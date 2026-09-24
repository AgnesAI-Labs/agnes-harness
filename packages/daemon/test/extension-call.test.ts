import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionActivationBarrier, type Host } from '@agnes/host'
import { type ExtensionCallResult, rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerExtensions } from '../src/local/methods/extensions.js'
import { type CommandJournal, MemoryJournal } from '../src/local/ports.js'
import { PersistentCommandJournal } from '../src/storage/command-journal.js'
import { sqliteTables } from './sqlite-tables.js'

function endpoint(
  callService: Host['callService'],
  surface = true,
  kind: 'query' | 'effect' = 'effect',
  journal: CommandJournal = new MemoryJournal(() => 1_700_000_000_000),
  resolveServiceSession = vi.fn(async (sessionId: string) => sessionId),
) {
  const activationBarrier = createExtensionActivationBarrier()
  const ep = new LocalEndpoint({ clock: () => 1_700_000_000_000, principalId: 'transport' })
  ep.establishPrincipal(surface ? 'surface:reports:portal:alice' : 'jwt:alice')
  ep.conn.initialized = true
  ep.conn.clientId = 'untrusted-client-label'
  ep.conn.authKind = surface ? 'surface' : 'jwt'
  ep.conn.credentialKind = surface ? 'sso' : 'jwt'
  ep.conn.credential = surface
    ? { kind: 'sso', userId: 'alice', raw: { department: 'sales' } }
    : { kind: 'jwt', token: 'opaque', userId: 'alice' }
  if (surface)
    ep.conn.surface = Object.freeze({
      sourceId: 'reports',
      sourceAuthKeyId: 'reports-key',
      grants: Object.freeze([
        Object.freeze({ extension: 'agnes/reports', name: 'sales.list', range: '^1.0.0' }),
      ]),
    })
  const queue = new CommandQueue()
  registerExtensions(ep, {
    activationBarrier,
    journal,
    commandQueue: queue,
    callService: callService as never,
    inspectService: vi.fn(async () => ({ kind })),
    resolveServiceSession,
  })
  return { ep, queue, journal, activationBarrier }
}

const request = (id: number, input: Record<string, unknown>, commandId?: string) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/extension.call' as const,
  params: {
    sessionId: 'session-1',
    extension: 'agnes/reports',
    service: 'sales.list',
    input,
    ...(commandId ? { commandId } : {}),
  },
})

const ackRequest = (id: number, commandId: string) => ({
  jsonrpc: '2.0' as const,
  id,
  method: '_agnes/v1/extension.ack' as const,
  params: {
    extension: 'agnes/reports',
    service: 'sales.list',
    commandId,
  },
})

describe('S5 extension.call daemon boundary', () => {
  it('fails closed before inspection for stale or substituted session ids', async () => {
    const callService = vi.fn(async () => ({ output: { ok: true } })) as unknown as Host['callService']
    const stale = endpoint(
      callService,
      true,
      'query',
      new MemoryJournal(() => 1_700_000_000_000),
      vi.fn(async () => {
        throw rpcError('INTERNAL_ERROR', { code: 'E_WORKSPACE_REQUIRED' })
      }),
    )
    await expect(stale.ep.handle(request(1, {}))).resolves.toMatchObject({
      error: { data: { code: 'E_WORKSPACE_REQUIRED' } },
    })
    expect(callService).not.toHaveBeenCalled()
    await stale.queue.close()
    await stale.ep.close()

    const substituted = endpoint(
      callService,
      true,
      'query',
      new MemoryJournal(() => 1_700_000_000_000),
      vi.fn(async () => 'another-session'),
    )
    await expect(substituted.ep.handle(request(2, {}))).resolves.toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(callService).not.toHaveBeenCalled()
    await substituted.queue.close()
    await substituted.ep.close()
  })

  it('rejects a new Service call before journaling while activation owns the shared gate', async () => {
    const callService = vi.fn(async () => ({ output: { ok: true } })) as unknown as Host['callService']
    const { ep, queue, activationBarrier } = endpoint(callService)
    let releaseSwitch: () => void = () => undefined
    let markSwitching: () => void = () => undefined
    const switching = new Promise<void>((resolve) => {
      markSwitching = resolve
    })
    const hold = new Promise<void>((resolve) => {
      releaseSwitch = resolve
    })
    const activation = activationBarrier.quiesce('service-cutover', async () => {
      markSwitching()
      await hold
    })
    await switching
    await expect(ep.handle(request(1, { n: 1 }, 'effect-during-cutover'))).resolves.toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'activation-in-progress', operationId: 'service-cutover' },
      },
    })
    expect(callService).not.toHaveBeenCalled()
    releaseSwitch()
    await activation
    await expect(ep.handle(request(2, { n: 1 }, 'effect-during-cutover'))).resolves.toMatchObject({
      result: { output: { ok: true } },
    })
    expect(callService).toHaveBeenCalledTimes(1)
    await queue.close()
    await ep.close()
  })

  it('allows only a doubly-authenticated Surface connection and injects server identity', async () => {
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({
        output: { rows: 1 },
      }),
    )
    const allowed = endpoint(call, true, 'query')
    await expect(allowed.ep.handle(request(1, { region: 'east' }))).resolves.toMatchObject({
      result: { output: { rows: 1 } },
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[1]).toEqual({
      kind: 'surface-service',
      source: 'reports',
      subjectCredential: { kind: 'sso', userId: 'alice', raw: { department: 'sales' } },
      grants: [{ extension: 'agnes/reports', name: 'sales.list', range: '^1.0.0' }],
    })
    expect(JSON.stringify(call.mock.calls[0]?.[0])).not.toMatch(/actor|credential|principal/i)

    const deniedCall = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({ output: {} }),
    )
    const denied = endpoint(deniedCall, false, 'query')
    await expect(denied.ep.handle(request(2, {}))).resolves.toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(deniedCall).not.toHaveBeenCalled()
    await allowed.ep.close()
    await allowed.queue.close()
    await denied.ep.close()
    await denied.queue.close()
  })

  it('journals an effect once and replays its result without author execution', async () => {
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({
        output: { created: 'row-1' },
      }),
    )
    const { ep, queue } = endpoint(call)
    const first = await ep.handle(request(1, { value: 1 }, 'create-1'))
    const replay = await ep.handle(request(2, { value: 1 }, 'create-1'))
    expect(first).toMatchObject({ result: { output: { created: 'row-1' } } })
    expect(replay).toMatchObject({ result: { output: { created: 'row-1' } } })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[3]).toEqual({ commandId: 'create-1' })
    await ep.close()
    await queue.close()
  })

  it('retains effect receipts until the authenticated Surface explicitly acknowledges delivery', async () => {
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({ output: {} }),
    )
    const journal = new MemoryJournal(() => 1_700_000_000_000)
    const ack = vi.spyOn(journal, 'ack')
    const gc = vi.spyOn(journal, 'gc')
    const { ep, queue } = endpoint(call, true, 'effect', journal)
    await ep.handle(request(1, {}, 'first'))
    expect(ack).not.toHaveBeenCalled()
    await ep.handle(request(2, {}, 'second'))
    expect(ack).not.toHaveBeenCalled()
    await expect(ep.handle(ackRequest(3, 'first'))).resolves.toMatchObject({ result: {} })
    expect(ack).toHaveBeenCalledWith({
      principalId: 'surface:reports:portal:alice',
      clientId: 'reports',
      sessionId: 'service:reports:agnes/reports/sales.list',
      commandId: 'first',
    })
    expect(gc).toHaveBeenCalledWith(1_700_000_000_000)
    await expect(ep.handle(ackRequest(4, 'first'))).resolves.toMatchObject({ result: {} })
    await expect(ep.handle(ackRequest(5, 'missing'))).resolves.toMatchObject({ result: {} })
    expect(gc).toHaveBeenCalledTimes(1)
    await ep.close()
    expect(ack).toHaveBeenCalledTimes(3)
    await queue.close()

    const reconnect = endpoint(call, true, 'effect', journal)
    await expect(reconnect.ep.handle(ackRequest(6, 'first'))).resolves.toMatchObject({ result: {} })
    expect(gc).toHaveBeenCalledTimes(1)
    await reconnect.ep.close()
    await reconnect.queue.close()

    const denied = endpoint(call, false, 'effect', journal)
    await expect(denied.ep.handle(ackRequest(7, 'second'))).resolves.toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(ack).toHaveBeenCalledTimes(4)
    await denied.ep.close()
    await denied.queue.close()
  })

  it('replays a durable effect receipt across reconnect and deletes it only after explicit ack plus GC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-extension-effect-'))
    const database = join(dir, 'journal.db')
    let now = 1_700_000_000_000
    const retentionMs = 100
    try {
      const firstTables = sqliteTables(database)
      const firstJournal = new PersistentCommandJournal(
        firstTables.table('command_journal'),
        () => now,
        retentionMs,
      )
      const firstCall = vi.fn(
        async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({
          output: { created: 'durable-row' },
        }),
      )
      const first = endpoint(firstCall, true, 'effect', firstJournal)
      await expect(first.ep.handle(request(1, { value: 1 }, 'durable'))).resolves.toMatchObject({
        result: { output: { created: 'durable-row' } },
      })
      await first.ep.close()
      await first.queue.close()
      await firstTables.close()

      const reopened = sqliteTables(database)
      try {
        const table = reopened.table('command_journal')
        const afterRestart = new PersistentCommandJournal(table, () => now, retentionMs)
        now += 10_000
        // Age and a closed transport are not delivery acknowledgement. The durable receipt must
        // survive GC so a reconnecting source can safely repeat the same effect command.
        expect(await afterRestart.gc(now)).toBe(0)
        expect(table.get<{ n: number }>('SELECT COUNT(*) AS n FROM command_journal')?.n).toBe(1)
        const mustNotDispatch = vi.fn(
          async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => {
            throw new Error('effect replayed')
          },
        )
        const second = endpoint(mustNotDispatch, true, 'effect', afterRestart)
        await expect(second.ep.handle(request(2, { value: 1 }, 'durable'))).resolves.toMatchObject({
          result: { output: { created: 'durable-row' } },
        })
        await expect(second.ep.handle(request(3, { value: 2 }, 'durable'))).resolves.toMatchObject({
          error: { data: { code: 'ID_CONFLICT' } },
        })
        expect(mustNotDispatch).not.toHaveBeenCalled()

        await expect(second.ep.handle(ackRequest(4, 'durable'))).resolves.toMatchObject({ result: {} })
        expect(await afterRestart.gc(now + retentionMs)).toBe(0)
        expect(table.get<{ n: number }>('SELECT COUNT(*) AS n FROM command_journal')?.n).toBe(1)
        now += retentionMs + 1
        expect(await afterRestart.gc(now)).toBe(1)
        expect(table.get<{ n: number }>('SELECT COUNT(*) AS n FROM command_journal')?.n).toBe(0)
        await second.ep.close()
        await second.queue.close()
      } finally {
        await reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses trusted Service kind so a query carrying commandId is never journaled', async () => {
    let calls = 0
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({
        output: { fresh: ++calls },
      }),
    )
    const { ep, queue } = endpoint(call, true, 'query')
    await expect(ep.handle(request(1, { value: 1 }, 'query-label'))).resolves.toMatchObject({
      result: { output: { fresh: 1 } },
    })
    await expect(ep.handle(request(2, { value: 1 }, 'query-label'))).resolves.toMatchObject({
      result: { output: { fresh: 2 } },
    })
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.every((args) => args[3] === undefined)).toBe(true)
    await ep.close()
    await queue.close()
  })

  it('rejects a trusted effect without commandId before dispatch or journal retention', async () => {
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({ output: {} }),
    )
    const { ep, queue } = endpoint(call)
    await expect(ep.handle(request(1, {}))).resolves.toMatchObject({
      error: { data: { code: 'INVALID_PARAMS' } },
    })
    expect(call).not.toHaveBeenCalled()
    await ep.close()
    await queue.close()
  })

  it('rejects commandId reuse with a different payload', async () => {
    const call = vi.fn(
      async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => ({
        output: { ok: true },
      }),
    )
    const { ep, queue } = endpoint(call)
    await ep.handle(request(1, { value: 1 }, 'same-id'))
    await expect(ep.handle(request(2, { value: 2 }, 'same-id'))).resolves.toMatchObject({
      error: { data: { code: 'ID_CONFLICT' } },
    })
    expect(call).toHaveBeenCalledTimes(1)
    await ep.close()
    await queue.close()
  })

  it('abandons known pre-effect refusals but retains a stable unknown outcome after unsafe failure', async () => {
    let attempt = 0
    const refused = vi.fn(async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => {
      if (attempt++ === 0) throw rpcError('CAPABILITY_DENIED', { _servicePhase: 'pre-dispatch' })
      return { output: { ok: true } }
    })
    const retryable = endpoint(refused)
    await expect(retryable.ep.handle(request(1, {}, 'retryable'))).resolves.toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    await expect(retryable.ep.handle(request(2, {}, 'retryable'))).resolves.toMatchObject({
      result: { output: { ok: true } },
    })
    expect(refused).toHaveBeenCalledTimes(2)

    const crashed = vi.fn(async (..._args: Parameters<Host['callService']>): Promise<ExtensionCallResult> => {
      throw new Error('private runner path')
    })
    const uncertain = endpoint(crashed)
    await expect(uncertain.ep.handle(request(3, {}, 'uncertain'))).resolves.toMatchObject({
      error: { code: -32013, message: 'OUTCOME_UNKNOWN', data: { code: 'OUTCOME_UNKNOWN' } },
    })
    await expect(uncertain.ep.handle(request(4, {}, 'uncertain'))).resolves.toMatchObject({
      error: { code: -32013, message: 'OUTCOME_UNKNOWN', data: { code: 'OUTCOME_UNKNOWN' } },
    })
    expect(crashed).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(await uncertain.ep.handle(request(5, {}, 'uncertain')))).not.toContain(
      'private runner path',
    )

    await retryable.ep.close()
    await retryable.queue.close()
    await uncertain.ep.close()
    await uncertain.queue.close()
  })

  it('aborts active and queued calls immediately when the bound connection closes', async () => {
    const entered: AbortSignal[] = []
    const call = vi.fn(
      async (
        _params: Parameters<Host['callService']>[0],
        _credential: Parameters<Host['callService']>[1],
        signal?: AbortSignal,
      ): Promise<ExtensionCallResult> => {
        if (!signal) throw new Error('missing signal')
        entered.push(signal)
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
        return { output: {} }
      },
    )
    const { ep, queue } = endpoint(call)
    const active = ep.handle(request(1, {}, 'active'))
    const waiting = ep.handle(request(2, {}, 'waiting'))
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await ep.close()
    await expect(active).resolves.toMatchObject({ error: { data: { code: 'OUTCOME_UNKNOWN' } } })
    await expect(waiting).resolves.toMatchObject({ error: { data: { code: 'REQUEST_TIMEOUT' } } })
    expect(entered[0]?.aborted).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    await queue.close()
  })
})
