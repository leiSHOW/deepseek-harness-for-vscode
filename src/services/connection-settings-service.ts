import type {
  ConfigurableProviderView,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { ConfigurationService } from '../config/configuration.js'
import type {
  ConnectionProviderView,
  ConnectionSettingsInput,
  ConnectionSettingsState,
} from '../domain/connection-settings.js'
import { validateBaseUrl } from '../domain/base-url.js'
import { modelCapacity } from '../domain/model-capacity.js'
import { supportsImageInput } from '../domain/model-modalities.js'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_PROVIDER,
  isDeepSeekOfficialBaseUrl,
  providerKeyEnv,
  providerRoute,
  type CustomProvider,
} from '../domain/provider.js'
import type { CredentialStore } from '../security/credential-store.js'

export const PI_AI_SETTINGS_NS = 'llm-pi-ai'
export const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

type ProviderControlClient = Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
type Listener = () => void

const EMPTY_STATE: ConnectionSettingsState = {
  writable: false,
  providers: [{
    id: DEEPSEEK_OFFICIAL_PROVIDER,
    name: 'DeepSeek Official',
    baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
    models: [],
    apiKeyConfigured: false,
    credentialWritable: false,
    removable: false,
  }],
}

/**
 * Adapts the upstream DSH settings/credentials/LLM control plane to the
 * extension's deliberately small DeepSeek-source form.
 */
export class ConnectionSettingsService {
  private client: ProviderControlClient | undefined
  private stateValue: ConnectionSettingsState = EMPTY_STATE
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly legacyCredentials: CredentialStore,
  ) {}

  get state(): ConnectionSettingsState {
    return this.stateValue
  }

  get connected(): boolean {
    return this.client !== undefined
  }

  hasConfiguredProvider(): boolean {
    return this.stateValue.providers.some((provider) => provider.apiKeyConfigured)
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  /** Binds one live Gateway client and imports settings written by older builds. */
  async connect(client: ProviderControlClient): Promise<void> {
    this.client = client
    await this.migrateLegacySettings()
    await this.migrateRelayReasoningEfforts()
    await this.migrateRelayCapacities()
    await this.migrateRelayImageModalities()
    await this.refresh()
  }

  disconnect(): void {
    this.client = undefined
  }

  async refresh(): Promise<ConnectionSettingsState> {
    const client = this.requireClient()
    const [directoryResponse, settingsResponse, modelsResponse] = await Promise.all([
      client.llm.providers({}),
      client.settings.describe({}),
      client.llm.models({}),
    ])
    const directory = valueOf(directoryResponse)
    const described = valueOf(settingsResponse)
    const models = valueOf(modelsResponse)
    const namespaces = new Map(described.namespaces.map((namespace) => [namespace.ns, namespace]))
    // A custom relay is compatible when it exposes at least one model — its
    // ids need not be the built-in DeepSeek pair (e.g. Volcengine Ark model
    // ids or endpoint ids). The official route is always compatible.
    const groupsByProvider = new Map(models.groups.map((group) => [group.id, group]))
    const compatible = new Set<string>([DEEPSEEK_OFFICIAL_PROVIDER])
    for (const entry of directory.providers) {
      if (entry.settingsNs !== DEEPSEEK_SETTINGS_NS && entry.settingsNs !== PI_AI_SETTINGS_NS) continue
      if (groupsByProvider.get(entry.provider)?.models.length) compatible.add(entry.provider)
    }

    const entries = directory.providers.filter((entry) => (
      compatible.has(entry.provider)
      && (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER || entry.active)
      && (entry.settingsNs === DEEPSEEK_SETTINGS_NS || entry.settingsNs === PI_AI_SETTINGS_NS)
    ))
    const references = [...new Set(entries.map((entry) => credentialRef(entry, namespaces.get(entry.settingsNs))))]
    const credentials = references.length === 0
      ? { credentials: {} }
      : valueOf(await client.credentials.describe({ refs: references }))
    const providers = entries.map((entry) => providerView(
      entry,
      namespaces.get(entry.settingsNs),
      credentials.credentials[credentialRef(entry, namespaces.get(entry.settingsNs))],
    ))
    providers.sort((left, right) => {
      if (left.id === DEEPSEEK_OFFICIAL_PROVIDER) return -1
      if (right.id === DEEPSEEK_OFFICIAL_PROVIDER) return 1
      return left.name.localeCompare(right.name)
    })
    this.setState({ writable: described.writable, providers })
    return this.stateValue
  }

  async apply(input: ConnectionSettingsInput): Promise<string> {
    const normalized = normalizeInput(input)
    if (normalized.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      await this.applyOfficial(normalized.baseUrl, normalized.apiKey)
      await this.refresh()
      return DEEPSEEK_OFFICIAL_PROVIDER
    }

    const route = normalized.provider === '__new__'
      ? providerRoute(normalized.name)
      : normalized.provider
    if (route === DEEPSEEK_OFFICIAL_PROVIDER) throw new Error('This provider name is reserved. Choose another name.')
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(route)) {
      throw new Error('The provider name cannot be converted to a valid provider ID.')
    }
    const existing = this.stateValue.providers.find((provider) => provider.id === route)
    if (input.provider === '__new__' && existing !== undefined) throw new Error('A provider with this name already exists.')
    if (input.provider === '__new__' && normalized.apiKey === '') throw new Error('The provider API key cannot be empty.')

    const client = this.requireClient()
    const namespace = await this.namespace(PI_AI_SETTINGS_NS)
    const keyRef = providerKeyEnv(route)
    const profile = deepSeekRelayProfile(normalized.name, normalized.baseUrl, keyRef, normalized.models)
    const ops: SettingsPathOpView[] = existing === undefined
      ? [{ op: 'set', path: ['providers', route], value: profile }]
      : [
          { op: 'set', path: ['providers', route, 'displayName'], value: normalized.name },
          { op: 'set', path: ['providers', route, 'baseURL'], value: normalized.baseUrl },
          { op: 'set', path: ['providers', route, 'api'], value: 'openai-completions' },
          { op: 'set', path: ['providers', route, 'compat'], value: relayCompat() },
          { op: 'set', path: ['providers', route, 'models'], value: relayModels(normalized.models) },
          ...(normalized.apiKey === '' ? [] : [{ op: 'set' as const, path: ['providers', route, 'apiKeyEnv'], value: keyRef }]),
        ]
    const response = await client.settings.mutate({
      ns: PI_AI_SETTINGS_NS,
      ops,
      expectedRevision: namespace.revision,
    })
    valueOf(response)
    if (normalized.apiKey !== '') valueOf(await client.credentials.set({ ref: keyRef, value: normalized.apiKey }))
    await this.refresh()
    return route
  }

  async remove(provider: string): Promise<void> {
    if (provider === DEEPSEEK_OFFICIAL_PROVIDER) throw new Error('The built-in provider cannot be removed.')
    const target = this.stateValue.providers.find((item) => item.id === provider)
    if (target === undefined || !target.removable) throw new Error('This provider is not removable.')
    const client = this.requireClient()
    const namespace = await this.namespace(PI_AI_SETTINGS_NS)
    const ref = credentialRefForProfile(valueAt(namespace.value, ['providers', provider]), provider)
    // Delete the profile first: if this write fails on a stale revision, the
    // credential is still intact, so the user never loses a key for a provider
    // that still exists. A credential unset that fails afterwards leaves only
    // an invisible orphan key, which is safe.
    valueOf(await client.settings.mutate({
      ns: PI_AI_SETTINGS_NS,
      ops: [{ op: 'unset', path: ['providers', provider] }],
      expectedRevision: namespace.revision,
    }))
    const credential = valueOf(await client.credentials.describe({ refs: [ref] })).credentials[ref]
    if (credential?.configured === true && credential.writable) valueOf(await client.credentials.unset({ ref }))
    await this.refresh()
  }

  async setOfficialApiKey(value: string): Promise<void> {
    const normalized = value.trim()
    if (normalized === '') throw new Error('The API Key cannot be empty.')
    valueOf(await this.requireClient().credentials.set({ ref: 'DEEPSEEK_API_KEY', value: normalized }))
    await this.refresh()
  }

  async clearOfficialApiKey(): Promise<void> {
    valueOf(await this.requireClient().credentials.unset({ ref: 'DEEPSEEK_API_KEY' }))
    await this.refresh()
  }

  private async applyOfficial(baseUrl: string, apiKey: string): Promise<void> {
    const client = this.requireClient()
    if (!isDeepSeekOfficialBaseUrl(baseUrl)) {
      throw new Error('Third-party endpoints must be added as a custom provider.')
    }
    const namespace = await this.namespace(DEEPSEEK_SETTINGS_NS)
    const normalizedBase = baseUrl === DEEPSEEK_OFFICIAL_BASE_URL ? '' : baseUrl
    const ops: SettingsPathOpView[] = normalizedBase === ''
      ? [{ op: 'unset', path: ['baseURL'] }]
      : [{ op: 'set', path: ['baseURL'], value: normalizedBase }]
    valueOf(await client.settings.mutate({
      ns: DEEPSEEK_SETTINGS_NS,
      ops,
      expectedRevision: namespace.revision,
    }))
    if (apiKey !== '') valueOf(await client.credentials.set({ ref: 'DEEPSEEK_API_KEY', value: apiKey }))
  }

  private async namespace(ns: string): Promise<SettingsNamespaceView> {
    const described = valueOf(await this.requireClient().settings.describe({}))
    const namespace = described.namespaces.find((item) => item.ns === ns)
    if (namespace === undefined) throw new Error(`Harness settings namespace "${ns}" is unavailable.`)
    if (!described.writable) throw new Error('Harness settings are read-only.')
    return namespace
  }

  private async migrateLegacySettings(): Promise<void> {
    const client = this.requireClient()
    const described = valueOf(await client.settings.describe({}))
    if (!described.writable) return
    const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
    const deepSeek = described.namespaces.find((item) => item.ns === DEEPSEEK_SETTINGS_NS)
    const legacyKey = await this.legacyCredentials.getApiKey()
    const legacyBaseUrl = this.configuration.getLegacyBaseUrl()
    const legacyRelay = legacyBaseUrl !== undefined && !isDeepSeekOfficialBaseUrl(legacyBaseUrl)
      ? importedRelay(legacyBaseUrl, legacyKey)
      : undefined

    if (piAi !== undefined) {
      const legacyProviders = [
        ...this.configuration.getLegacyProviders(),
        ...(legacyRelay === undefined ? [] : [legacyRelay.provider]),
      ]
      const ops: SettingsPathOpView[] = []
      const pendingCredentials: { ref: string; value: string }[] = []
      const candidates = legacyProviders.map((provider) => {
        const route = providerRoute(provider.name)
        const existing = valueAt(piAi.value, ['providers', route])
        const ref = credentialRefForProfile(existing, route)
        return { provider, route, existing, ref }
      })
      const refs = [...new Set(candidates.map((candidate) => candidate.ref))]
      const credentialState = refs.length === 0
        ? { credentials: {} }
        : valueOf(await client.credentials.describe({ refs }))
      for (const candidate of candidates) {
        if (candidate.existing === undefined) {
          ops.push({
            op: 'set',
            path: ['providers', candidate.route],
            value: deepSeekRelayProfile(candidate.provider.name, candidate.provider.baseUrl, candidate.ref),
          })
        }
        if (candidate.provider.apiKey.trim() !== '' && credentialState.credentials[candidate.ref]?.configured !== true) {
          pendingCredentials.push({ ref: candidate.ref, value: candidate.provider.apiKey })
        }
      }
      if (ops.length > 0) {
        valueOf(await client.settings.mutate({ ns: PI_AI_SETTINGS_NS, ops, expectedRevision: piAi.revision }))
      }
      for (const credential of pendingCredentials) {
        valueOf(await client.credentials.set(credential))
      }
    } else if (legacyRelay !== undefined) {
      throw new Error('Harness cannot migrate the legacy relay because llm-pi-ai is unavailable.')
    }

    if (legacyRelay === undefined && legacyKey !== undefined && legacyKey.trim() !== '') {
      const status = valueOf(await client.credentials.describe({ refs: ['DEEPSEEK_API_KEY'] }))
      if (status.credentials.DEEPSEEK_API_KEY?.configured !== true) {
        valueOf(await client.credentials.set({ ref: 'DEEPSEEK_API_KEY', value: legacyKey.trim() }))
      }
    }
    if (deepSeek !== undefined && legacyBaseUrl !== undefined && legacyRelay === undefined && valueAt(deepSeek.user, ['baseURL']) === undefined) {
      valueOf(await client.settings.mutate({
        ns: DEEPSEEK_SETTINGS_NS,
        ops: [{ op: 'set', path: ['baseURL'], value: legacyBaseUrl }],
        expectedRevision: deepSeek.revision,
      }))
    }
    if (legacyRelay !== undefined && this.configuration.get().provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      await this.configuration.setProvider(legacyRelay.route)
    }
    // Migration is complete only after every upstream write above succeeded.
    // Remove plaintext legacy copies so DSH remains the single authority.
    if (this.configuration.getLegacyProviders().length > 0) await this.configuration.clearLegacyProviders()
    if (legacyKey !== undefined && legacyKey.trim() !== '') await this.legacyCredentials.clearApiKey()
    if (legacyBaseUrl !== undefined) await this.configuration.clearLegacyBaseUrl()
  }

  /**
   * Tops up reasoning effort maps on custom relays written by older builds.
   * Harness 0.1.0-rc.7 added the `low` tier; relay profiles persist their own
   * reasoningEfforts map, so existing installs keep showing the old stops
   * until the map is healed. Idempotent: already-current maps are untouched.
   */
  private async migrateRelayReasoningEfforts(): Promise<void> {
    const client = this.requireClient()
    const described = valueOf(await client.settings.describe({}))
    if (!described.writable) return
    const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
    if (piAi === undefined) return
    const providers = valueAt(piAi.user, ['providers'])
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
    const ops: SettingsPathOpView[] = []
    for (const [route, profile] of Object.entries(providers)) {
      const models = valueAt(profile, ['models'])
      if (!Array.isArray(models)) continue
      let changed = false
      const upgraded = models.map((model) => {
        if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
        const efforts = (model as Record<string, unknown>)['reasoningEfforts']
        if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts)) return model
        if ('low' in efforts) return model
        changed = true
        // Extension-written legacy maps are replaced wholesale so the stop
        // order stays canonical; customized maps only gain the missing entry.
        const next = isLegacyRelayReasoningEfforts(efforts)
          ? { ...RELAY_REASONING_EFFORTS }
          : { off: null, low: 'low', ...efforts }
        return { ...(model as Record<string, unknown>), reasoningEfforts: next }
      })
      if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
    }
    if (ops.length === 0) return
    valueOf(await client.settings.mutate({ ns: PI_AI_SETTINGS_NS, ops, expectedRevision: piAi.revision }))
  }

  /**
   * Fills in contextWindow/maxTokens on relay models written by older builds.
   * The pi-ai adapter falls back to a 256K default when a model entry carries
   * no capacity, which misstates 1M-window models; writing the known capacity
   * makes the context meter accurate for Auto and manual selections alike.
   * Idempotent: entries that already carry a capacity are untouched, and ids
   * outside the capacity table keep their entries as-is.
   */
  private async migrateRelayCapacities(): Promise<void> {
    const client = this.requireClient()
    const described = valueOf(await client.settings.describe({}))
    if (!described.writable) return
    const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
    if (piAi === undefined) return
    const providers = valueAt(piAi.user, ['providers'])
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
    const ops: SettingsPathOpView[] = []
    for (const [route, profile] of Object.entries(providers)) {
      const models = valueAt(profile, ['models'])
      if (!Array.isArray(models)) continue
      let changed = false
      const upgraded = models.map((model) => {
        if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
        const record = model as Record<string, unknown>
        const id = record['id']
        if (typeof id !== 'string' || record['contextWindow'] !== undefined) return model
        const capacity = modelCapacity(id)
        if (capacity === undefined) return model
        changed = true
        return {
          ...record,
          contextWindow: capacity.contextWindow,
          ...(capacity.maxTokens === undefined ? {} : { maxTokens: capacity.maxTokens }),
        }
      })
      if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
    }
    if (ops.length === 0) return
    valueOf(await client.settings.mutate({ ns: PI_AI_SETTINGS_NS, ops, expectedRevision: piAi.revision }))
  }

  /**
   * Declares image input on relay vision models written by older builds. The
   * pi-ai adapter serves an entry without `input` as text-only, so a relay
   * vision model rejected image prompts even after the session switched to it.
   * Idempotent: entries that already declare modalities are untouched, and ids
   * without the vision naming convention keep their entries as-is.
   */
  private async migrateRelayImageModalities(): Promise<void> {
    const client = this.requireClient()
    const described = valueOf(await client.settings.describe({}))
    if (!described.writable) return
    const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
    if (piAi === undefined) return
    const providers = valueAt(piAi.user, ['providers'])
    if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
    const ops: SettingsPathOpView[] = []
    for (const [route, profile] of Object.entries(providers)) {
      const models = valueAt(profile, ['models'])
      if (!Array.isArray(models)) continue
      let changed = false
      const upgraded = models.map((model) => {
        if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
        const record = model as Record<string, unknown>
        const id = record['id']
        if (typeof id !== 'string' || !supportsImageInput(id)) return model
        // pi-ai's declaredInput treats an empty list as undeclared too.
        const input = record['input']
        if (Array.isArray(input) && input.length > 0) return model
        changed = true
        return { ...record, input: ['text', 'image'] }
      })
      if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
    }
    if (ops.length === 0) return
    valueOf(await client.settings.mutate({ ns: PI_AI_SETTINGS_NS, ops, expectedRevision: piAi.revision }))
  }

  private requireClient(): ProviderControlClient {
    if (this.client === undefined) throw new Error('Harness Gateway is not connected.')
    return this.client
  }

  private setState(state: ConnectionSettingsState): void {
    this.stateValue = state
    for (const listener of this.listeners) listener()
  }
}

function importedRelay(baseUrl: string, apiKey: string | undefined): {
  route: string
  provider: CustomProvider
} {
  const hostname = new URL(baseUrl).hostname.replace(/^www\./u, '')
  const name = `Imported ${hostname}`
  return {
    route: providerRoute(name),
    provider: { name, baseUrl, apiKey: apiKey?.trim() ?? '' },
  }
}

function normalizeInput(input: ConnectionSettingsInput): ConnectionSettingsInput {
  const name = input.name.trim()
  const baseUrl = input.baseUrl.trim()
  const apiKey = input.apiKey.trim()
  if (input.provider !== DEEPSEEK_OFFICIAL_PROVIDER && name === '') throw new Error('The provider name cannot be empty.')
  if (baseUrl === '') {
    if (input.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      return { ...input, name, baseUrl: DEEPSEEK_OFFICIAL_BASE_URL, apiKey }
    }
    throw new Error('The provider base URL cannot be empty.')
  }
  if (!validateBaseUrl(baseUrl).valid) throw new Error('The Base URL must be a valid http(s) URL.')
  const models = input.provider === DEEPSEEK_OFFICIAL_PROVIDER
    ? []
    : normalizeRelayModels(input.models)
  return { ...input, name, baseUrl, apiKey, models }
}

/**
 * A custom relay endpoint is addressed by the model ids it actually exposes
 * (e.g. a Volcengine Ark model id or endpoint). Empty input keeps the
 * extension's DeepSeek defaults so existing behavior is preserved.
 */
function normalizeRelayModels(models: readonly string[] | undefined): readonly string[] {
  const ids = (models ?? [])
    .map((model) => model.trim())
    .filter((model) => model !== '')
  return [...new Set(ids)]
}

/** Reasoning effort wire map the extension writes for custom relay models. */
const RELAY_REASONING_EFFORTS = { off: null, low: 'low', high: 'high', max: 'max' } as const

/** Map shape written by builds before the low tier existed (pre rc.7). */
const LEGACY_RELAY_REASONING_EFFORTS = { off: null, high: 'high', max: 'max' } as const

function isLegacyRelayReasoningEfforts(efforts: object): boolean {
  const entries = Object.entries(efforts)
  const legacy = Object.entries(LEGACY_RELAY_REASONING_EFFORTS) as [string, unknown][]
  return entries.length === legacy.length
    && legacy.every(([key, value]) => (efforts as Record<string, unknown>)[key] === value)
}

function relayModels(models: readonly string[]): { id: string; reasoningEfforts: object; input?: readonly string[]; contextWindow?: number; maxTokens?: number }[] {
  const ids = models.length > 0 ? models : ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
  return ids.map((id) => {
    const capacity = modelCapacity(id)
    return {
      id,
      reasoningEfforts: { ...RELAY_REASONING_EFFORTS },
      // The pi-ai adapter serves an entry without `input` as text-only, so a
      // vision route must declare its modalities or image prompts are rejected
      // at admission even after the session switched to it.
      ...(supportsImageInput(id) ? { input: ['text', 'image'] } : {}),
      ...(capacity === undefined ? {} : {
        contextWindow: capacity.contextWindow,
        ...(capacity.maxTokens === undefined ? {} : { maxTokens: capacity.maxTokens }),
      }),
    }
  })
}

function deepSeekRelayProfile(displayName: string, baseURL: string, apiKeyEnv: string, models?: readonly string[]): object {
  return {
    displayName,
    apiKeyEnv,
    api: 'openai-completions',
    baseURL,
    compat: relayCompat(),
    models: relayModels(models ?? []),
  }
}

function relayCompat(): object {
  return {
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  }
}

function providerView(
  entry: ConfigurableProviderView,
  namespace: SettingsNamespaceView | undefined,
  credential: { readonly configured: boolean; readonly writable: boolean } | undefined,
): ConnectionProviderView {
  const profile = valueAt(namespace?.value, entry.settingsPath)
  const baseUrl = stringField(profile, 'baseURL')
    ?? (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER ? DEEPSEEK_OFFICIAL_BASE_URL : '')
  return {
    id: entry.provider,
    name: entry.displayName,
    baseUrl,
    models: modelsField(profile),
    apiKeyConfigured: credential?.configured === true,
    credentialWritable: credential?.writable === true,
    removable: entry.settingsPath.length > 0 && valueAt(namespace?.user, entry.settingsPath) !== undefined,
  }
}

function credentialRef(entry: ConfigurableProviderView, namespace: SettingsNamespaceView | undefined): string {
  if (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER) return 'DEEPSEEK_API_KEY'
  return credentialRefForProfile(valueAt(namespace?.value, entry.settingsPath), entry.provider)
}

function credentialRefForProfile(profile: unknown, provider: string): string {
  return stringField(profile, 'apiKeyEnv') ?? providerKeyEnv(provider)
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined
}

function modelsField(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const models = (value as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  return models
    .map((model) => (typeof model === 'object' && model !== null
      ? stringField(model, 'id')
      : typeof model === 'string' ? model : undefined))
    .filter((model): model is string => model !== undefined)
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function valueOf<T>(response: { readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } } }): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}
