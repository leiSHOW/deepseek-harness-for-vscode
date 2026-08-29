import type { RawData } from 'ws'
import WebSocket from 'ws'
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  parseImportDiscoverResult,
  parseImportResult,
  type ImportDiscoverRequest,
  type ImportDiscoverResult,
  type ImportRequest,
  type ImportResult,
} from '../import/types.js'

type FrameParser<F> = { parse(value: unknown): F }
type SocketItem<F> = { readonly kind: 'frame'; readonly envelope: RpcRequest<F> } | { readonly kind: 'end' }

/** A host-registered slash command descriptor, as served by `commands/list`. */
export interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

export interface HostCommandExecution {
  readonly commandId: string
  /** RC.6 returns the settled result; newer Hosts may keep admission-only semantics. */
  readonly result?: { readonly kind: 'success' | 'error'; readonly text?: string }
}

/**
 * Node transport for the Harness Gateway. Unary calls use the official typed
 * fetch client; event downlinks use `ws` because VS Code's extension host is
 * not a browser and does not expose the Harness browser module loader.
 */
export class NodeGatewayClient extends AbstractApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly importTimeoutMs = 30_000,
  ) {
    super(30_000)
  }

  /** Lists the slash commands the active Harness deployment registers for one session. */
  async listCommands(sessionId: string): Promise<readonly HostCommandDescriptor[]> {
    // Typert Remote endpoints use the generic Connection `{ args }` carrier;
    // API Proxy methods use their payload directly. Keeping that envelope here
    // is what lets the Host interceptor claim commands/list before fallback.
    return this.callUnaryRaw<readonly HostCommandDescriptor[]>('commands/list', {
      args: { agentId: sessionId },
    })
  }

  /** Executes one registered Host slash command without sending it to the LLM. */
  async executeCommand(sessionId: string, line: string): Promise<HostCommandExecution | undefined> {
    return this.callUnaryRaw<HostCommandExecution | undefined>('commands/execute', {
      // The typert descriptor declares `images` as a required strict field
      // since dsh 0.1.1; host commands carry no attachments, so send an
      // explicit empty list instead of omitting it.
      args: { agentId: sessionId, line, images: [] },
    })
  }

  /** Downloads the session log ZIP (with descendant sessions) served by the Gateway. */
  async exportSession(sessionId: string, includeDescendants = true): Promise<Uint8Array> {
    const url = new URL('/api/session.export', this.baseUrl)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('includeDescendants', String(includeDescendants))
    const response = await globalThis.fetch(url)
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Lists importable sessions through the dsh-chat-import panel API. */
  async discoverImportSessions(request: ImportDiscoverRequest = {}): Promise<ImportDiscoverResult> {
    return await this.postImportApi('/api-import/sessions', request, parseImportDiscoverResult)
  }

  /** Imports discovered sessions through the dsh-chat-import panel API. */
  async importDiscoveredSessions(request: ImportRequest): Promise<ImportResult> {
    return await this.postImportApi('/api-import/import', request, parseImportResult)
  }

  private async postImportApi<T>(
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.doFetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.importTimeoutMs),
    }).catch((cause: unknown) => {
      throw timedOutImport(path, this.importTimeoutMs, cause)
    })
    if (response.status === 404) {
      throw new Error('SESSION_IMPORT_UNAVAILABLE')
    }
    const text = await response.text().catch((cause: unknown) => {
      throw timedOutImport(path, this.importTimeoutMs, cause)
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw new Error(`Import API ${path} returned HTTP ${response.status}${text === '' ? '' : `: ${text}`}`)
    }
    if (!response.ok) {
      const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
      throw new Error(
        typeof record?.error === 'string' ? record.error : `Import API ${path} failed: HTTP ${response.status}`,
      )
    }
    try {
      return parse(parsed)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`Import API ${path} returned HTTP ${response.status}: ${detail}`)
    }
  }

  /**
   * Generic unary call for endpoints outside the typed RpcMethodMap (the host
   * commands service is a typert remote, not part of the api-proxy contract).
   * Mirrors `callUnary`'s envelope lifecycle without the per-method value
   * schema table; the caller narrows the raw value.
   */
  private async callUnaryRaw<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const message = {
      type: 'client-request' as const,
      rpcId: this.mintRpcId(),
      method,
      payload,
    }
    this.onEnvelope(message)
    const response = await this.doFetch(new URL(`/api/${method}`, this.resolveBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
    if (!response.ok) throw new Error(`transport failure for ${method}: HTTP ${response.status}`)
    const full = serverResponseSchema.parse(await response.json())
    this.onEnvelope(full)
    if (full.rpcId !== message.rpcId) throw new Error(`rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`)
    if (!full.result.ok) throw new Error(`RPC ${method} failed: ${full.result.error.code}: ${full.result.error.message}`)
    return full.result.value as T
  }

  protected override resolveBase(): string {
    return this.baseUrl
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    // The Gateway always listens on 127.0.0.1. undici's default global fetch
    // honors HTTP(S)_PROXY env vars, so a system proxy (Clash/Surge/VPN) can
    // route loopback requests through the proxy and fail with `fetch failed`,
    // leaving the workbench stuck on "Starting Harness". A bare Agent bypasses
    // the proxy entirely for every request this client makes — the extension
    // only ever talks to the local Gateway over loopback.
    const request = init === undefined
      ? { dispatcher: LOOPBACK_DISPATCHER }
      : { ...init, dispatcher: LOOPBACK_DISPATCHER }
    return undiciFetch(input, request as Parameters<typeof undiciFetch>[1]) as Promise<Response>
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readSocket('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readSocket('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    parser: FrameParser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined

    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const close = (): void => { enqueue({ kind: 'end' }) }
    const abort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    const message = (data: RawData): void => {
      try {
        const full: ServerRequest = serverRequestSchema.parse(JSON.parse(rawDataText(data)))
        const payload = parser.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload } })
      } catch {
        // A malformed push is isolated. A later history refresh repairs gaps.
      }
    }

    socket.once('open', onOpen ?? (() => undefined))
    socket.on('message', message)
    socket.once('close', close)
    socket.once('error', close)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    try {
      while (!signal.aborted) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item?.kind === 'end') return
          if (item?.kind === 'frame') yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      socket.off('message', message)
      socket.off('close', close)
      socket.off('error', close)
      abort()
    }
  }
}

function timedOutImport(path: string, timeoutMs: number, cause: unknown): Error {
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return new Error(`Import API ${path} timed out after ${String(timeoutMs)}ms`)
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Shared proxy-free dispatcher for every loopback Gateway request. */
const LOOPBACK_DISPATCHER = new UndiciAgent({ connect: { timeout: 30_000 } })

function rawDataText(data: RawData): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}
