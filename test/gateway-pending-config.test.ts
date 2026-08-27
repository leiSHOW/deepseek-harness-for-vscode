import { describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostFrame } from '@deepseek-ai/dsh-client-connection/client'

vi.mock('vscode', () => ({
  EventEmitter: class {
    fire(): void {}
    event = (): { dispose(): void } => ({ dispose: () => {} })
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
  },
  l10n: { t: (message: string): string => message },
  env: { openExternal: async () => true },
}))

import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { Memento, OutputChannel } from 'vscode'

interface TestClient {
  workspace: { list: ReturnType<typeof vi.fn>; archiveSession: ReturnType<typeof vi.fn> }
  sessions: {
    list: ReturnType<typeof vi.fn>
    history: ReturnType<typeof vi.fn>
    models: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    selectModel: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    updateQueue: ReturnType<typeof vi.fn>
  }
  skills: { list: ReturnType<typeof vi.fn> }
  subagents: { list: ReturnType<typeof vi.fn> }
  agentPresets: { list: ReturnType<typeof vi.fn> }
  host: { describe: ReturnType<typeof vi.fn> }
}

const CONFIG = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  agentPreset: 'standard',
}

function createService(): { service: GatewayTestHarness; client: TestClient } {
  const client: TestClient = {
    workspace: { list: vi.fn(), archiveSession: vi.fn() },
    sessions: {
      list: vi.fn().mockResolvedValue({ result: { ok: true, value: { items: [] } } }),
      history: vi.fn().mockResolvedValue({ result: { ok: true, value: { events: [], hasMore: false } } }),
      models: vi.fn().mockResolvedValue({ result: { ok: true, value: { current: {}, groups: [] } } }),
      create: vi.fn().mockResolvedValue({ result: { ok: true, value: { sessionId: 's1', agentPreset: 'standard' } } }),
      selectModel: vi.fn().mockResolvedValue({ result: { ok: true, value: { selected: {} } } }),
      prompt: vi.fn().mockResolvedValue({ result: { ok: true, value: { accepted: true } } }),
      updateQueue: vi.fn().mockResolvedValue({ result: { ok: true, value: { accepted: true } } }),
    },
    skills: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { skills: [] } } }) },
    subagents: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { entries: [] } } }) },
    agentPresets: { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { presets: [] } } }) },
    host: { describe: vi.fn().mockResolvedValue({ result: { ok: true, value: {} } }) },
  }

  const runtime = {
    onDidChangeState: () => ({ dispose: () => {} }),
    state: { phase: 'idle' as const },
    start: vi.fn().mockResolvedValue('http://127.0.0.1:0'),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  } as unknown as HarnessHostRuntime

  const configuration = {
    get: () => ({ ...CONFIG }),
    setAgentPresetIfKnown: vi.fn(),
    setProviderIfConfigured: vi.fn(),
    setModelIfKnown: vi.fn(),
    setReasoningEffortIfKnown: vi.fn(),
  } as unknown as ConfigurationService

  const connectionSettings = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as ConnectionSettingsService

  const output = { appendLine: vi.fn() } as unknown as OutputChannel
  const globalState = {
    get: () => undefined,
    update: vi.fn(async () => {}),
  } as unknown as Memento

  const service = new HarnessGatewayService(
    runtime,
    configuration,
    connectionSettings,
    output,
    globalState,
  ) as unknown as GatewayTestHarness

  service.activeSessionId = 's1'
  service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })
  service.client = client
  return { service, client }
}

/** Structural view of the private gateway state the tests drive directly. */
interface GatewayTestHarness {
  client: TestClient | undefined
  activeSessionId: string | undefined
  summaries: Map<string, { running?: boolean; blank?: boolean; agentPreset?: string; updatedAt?: number }>
  pendingConfigurations: Map<string, unknown[]>
  admittedSessions: Set<string>
  handleMux: (rpcId: RpcId, frame: MuxFrame) => void
  handleHost: (frame: HostFrame) => void
  sendPrompt: (text: string, mode?: 'queue' | 'steer', attachments?: unknown[], configuration?: unknown, signals?: unknown) => Promise<void>
  removeQueued: (itemId: string) => Promise<void>
}

function config(reasoningEffort: string, agentPreset = 'standard'): unknown {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort, agentPreset }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function turnEndFrame(sessionId: string): MuxFrame {
  return {
    type: 'session/event',
    sessionId,
    event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 10, seq: 10 },
  } as unknown as MuxFrame
}

function idleBoundary(service: GatewayTestHarness): void {
  service.handleHost({ type: 'host/session-status', sessionId: 's1', running: false } as unknown as HostFrame)
  service.handleMux('rpc-boundary' as unknown as RpcId, turnEndFrame('s1'))
}

describe('gateway staged configuration', () => {
  it('applies the configuration before admission on the idle fast path', async () => {
    const { service, client } = createService()

    await service.sendPrompt('hello', 'queue', [], config('max'))

    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.selectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(client.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(service.pendingConfigurations.size).toBe(0)
    // The optimistic admission marker is set until the turn events arrive.
    expect(service.admittedSessions.has('s1')).toBe(true)
  })

  it('parks the configuration while a turn is running instead of dropping it', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('queued', 'queue', [], config('max'))

    expect(client.sessions.selectModel).not.toHaveBeenCalled()
    expect(client.sessions.prompt).toHaveBeenCalledTimes(1)
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)
  })

  it('applies the parked configuration at the next turn boundary', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(client.sessions.selectModel).not.toHaveBeenCalled()

    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.selectModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }))
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('keeps per-prompt FIFO order instead of sharing the last selection', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('max'))
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(service.pendingConfigurations.get('s1')).toHaveLength(2)

    idleBoundary(service)
    await tick()
    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel.mock.calls.map((call) => call[0].reasoningEffort)).toEqual(['max', 'low'])
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('treats a prompt admitted in the same tick as busy (no stale idle read)', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: false, blank: false, agentPreset: 'standard', updatedAt: 1 })

    await service.sendPrompt('first', 'queue', [], config('high'))
    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)

    // No turn events have arrived yet; the optimistic marker must force the
    // second prompt's configuration onto the deferred path.
    await service.sendPrompt('second', 'queue', [], config('low'))
    expect(client.sessions.selectModel).toHaveBeenCalledTimes(1)
    expect(client.sessions.prompt).toHaveBeenCalledTimes(2)
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)
  })

  it('rolls back the pending slot when admission fails', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    client.sessions.prompt.mockResolvedValueOnce({ result: { ok: false, error: { message: 'boom' } } })

    await expect(service.sendPrompt('queued', 'queue', [], config('max'))).rejects.toThrow('boom')

    expect(service.pendingConfigurations.size).toBe(0)
    expect(service.admittedSessions.has('s1')).toBe(false)
  })

  it('consumes config-less queue slots without applying anything', async () => {
    const { service, client } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('plain', 'queue', [])
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)

    idleBoundary(service)
    await tick()

    expect(client.sessions.selectModel).not.toHaveBeenCalled()
    expect(service.pendingConfigurations.size).toBe(0)
  })

  it('drops stale configurations when a queued item is withdrawn', async () => {
    const { service } = createService()
    service.summaries.set('s1', { running: true, blank: false, agentPreset: 'standard', updatedAt: 1 })
    await service.sendPrompt('queued', 'queue', [], config('max'))
    expect(service.pendingConfigurations.get('s1')).toHaveLength(1)

    await service.removeQueued('item-1')

    expect(service.pendingConfigurations.size).toBe(0)
  })
})