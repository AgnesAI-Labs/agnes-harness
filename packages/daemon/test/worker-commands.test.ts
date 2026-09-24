import type { Host, HostSession } from '@agnes/host'
import type { Actor } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { WorkerHello } from '../src/supervisor/frames.js'
import { encodeFrame, FrameTooLarge, InvalidFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { handleCommand } from '../src/worker/commands.js'
import { openTestHost, say } from './host.js'

const actor: Actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
type CommandFrame = Parameters<typeof handleCommand>[1]

describe('worker command dispatch against a real host+session', () => {
  it('maps enqueue/run/latest/scan and aborts a run by runId', async () => {
    const t = await openTestHost({ script: [say('hi')] })
    const session = await t.host.createSession({ cwd: t.dataDir })
    const aborts = new Map<string, AbortController>()
    const seq = await handleCommand(
      session,
      {
        kind: 'command',
        requestId: '1',
        method: 'enqueue',
        params: {
          target: 'next-turn',
          msg: { content: [{ type: 'text', text: 'hi' }], actor, kind: 'prompt' },
        },
      },
      { host: t.host, aborts },
    )
    expect(typeof seq).toBe('number')
    const out = (await handleCommand(
      session,
      { kind: 'command', requestId: '2', method: 'run', params: { runId: 'r1', until: 'turn-end' } },
      { host: t.host, aborts },
    )) as { reason: string }
    expect(out.reason).toBe('completed')
    // The AbortController keyed by runId is removed once run() settles, whether or not it was ever
    // aborted - a leaked entry would mean a later 'abort' for a since-reused runId hits a stale
    // controller instead of a no-op.
    expect(aborts.has('r1')).toBe(false)
    const rows = (await handleCommand(
      session,
      { kind: 'command', requestId: '3', method: 'scan', params: { fromSeq: 1, limit: 10 } },
      { host: t.host, aborts },
    )) as unknown[]
    expect(rows.length).toBeGreaterThan(0)
    await expect(
      handleCommand(
        session,
        { kind: 'command', requestId: '4', method: 'bogus' as never, params: {} },
        { host: t.host, aborts },
      ),
    ).rejects.toThrow(/unknown worker method/)
    await t.close()
  })

  it('abort() reaches a still-running turn through the stored AbortController', async () => {
    const t = await openTestHost({ script: [say('hi')] })
    const session = await t.host.createSession({ cwd: t.dataDir })
    const aborts = new Map<string, AbortController>()
    await handleCommand(
      session,
      {
        kind: 'command',
        requestId: '1',
        method: 'enqueue',
        params: {
          target: 'next-turn',
          msg: { content: [{ type: 'text', text: 'hi' }], actor, kind: 'prompt' },
        },
      },
      { host: t.host, aborts },
    )
    const runPromise = handleCommand(
      session,
      { kind: 'command', requestId: '2', method: 'run', params: { runId: 'r2', until: 'turn-end' } },
      { host: t.host, aborts },
    )
    // The controller is registered synchronously before `run()`'s first await, so it is safe to look
    // it up and trigger it immediately after issuing the command - no artificial wait needed.
    expect(aborts.has('r2')).toBe(true)
    await handleCommand(
      session,
      { kind: 'command', requestId: '3', method: 'abort', params: { runId: 'r2' } },
      { host: t.host, aborts },
    )
    const out = (await runPromise) as { reason: string }
    expect(out.reason).not.toBe('error')
    await t.close()
  })

  it('ping reports lastSeq and projectUI/projectUIPatch cross the worker command boundary', async () => {
    const t = await openTestHost({ script: [say('hi')] })
    const session = await t.host.createSession({ cwd: t.dataDir })
    const aborts = new Map<string, AbortController>()
    const ping = (await handleCommand(
      session,
      { kind: 'command', requestId: '1', method: 'ping', params: {} },
      { host: t.host, aborts },
    )) as {
      ok: boolean
      lastSeq: number
    }
    expect(ping).toEqual({
      ok: true,
      lastSeq: session.lastSeq,
      preset: session.preset.name,
      parent: null,
    })
    const timeline = (await handleCommand(
      session,
      { kind: 'command', requestId: '2', method: 'projectUI', params: {} },
      { host: t.host, aborts },
    )) as { upto: number }
    expect(timeline).toBeTruthy()
    const update = await handleCommand(
      session,
      {
        kind: 'command',
        requestId: '21',
        method: 'projectUIPatch',
        params: { after: timeline.upto },
      },
      { host: t.host, aborts },
    )
    expect(update).toMatchObject({
      kind: 'patch',
      patch: { from: timeline.upto, upto: timeline.upto, changes: [] },
    })
    await session.append([
      session.ev('user/message', { content: [{ type: 'text', text: 'older' }] }),
      session.ev('user/message', { content: [{ type: 'text', text: 'newer' }] }),
    ])
    const opening = (await handleCommand(
      session,
      {
        kind: 'command',
        requestId: '22',
        method: 'projectUIOpening',
        params: { maxNodes: 1, maxBytes: 16 * 1024, surface: 'tui' },
      },
      { host: t.host, aborts },
    )) as { timeline: { upto: number; nodes: unknown[] }; startIndex: number; totalNodes: number }
    expect(opening).toMatchObject({ startIndex: 1, totalNodes: 2, timeline: { nodes: [{}] } })
    const history = await handleCommand(
      session,
      {
        kind: 'command',
        requestId: '23',
        method: 'projectUIHistory',
        params: {
          cut: opening.timeline.upto,
          beforeIndex: opening.startIndex,
          limit: 1,
          maxBytes: 16 * 1024,
          surface: 'tui',
        },
      },
      { host: t.host, aborts },
    )
    expect(history).toMatchObject({ startIndex: 0, totalNodes: 2, hasEarlier: false, nodes: [{}] })
    await session.close()
    expect(session.closingOrClosed).toBe(true)
    await t.close()
  })

  it('expires a durable ticket before worker decideApproval can consume it', async () => {
    const t = await openTestHost()
    const session = await t.host.createSession({ cwd: t.dataDir })
    const ticket = 'daemon-expiry-ticket'
    const expiresAt = new Date(Date.now() + 30).toISOString()
    try {
      // This is a real Host session used by the daemon worker command path. The asked row is
      // durable and deliberately outlives no in-memory endpoint, so the Host scheduler must be the
      // component that settles it before the command arrives.
      await session.append([
        session.ev('approval/asked', {
          requestId: 'daemon-expiry-request',
          kind: 'tool',
          summary: 'shell touch marker',
          risk: 'destructive',
          bindingHash: '0'.repeat(64),
          pending: { ticket, expiresAt },
        }),
      ])
      await vi.waitFor(
        async () => {
          const rows = await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })
          expect(rows).toHaveLength(1)
          expect(rows[0]?.data).toMatchObject({ ticket, via: 'timeout', verdict: 'rejected' })
          expect(session.state.pendingApprovals.size).toBe(0)
        },
        { timeout: 2_000, interval: 20 },
      )
      const aborts = new Map<string, AbortController>()
      await expect(
        handleCommand(
          session,
          {
            kind: 'command',
            requestId: 'daemon-expiry-decide',
            method: 'decideApproval',
            params: { ticket, verdict: 'allowed-once', decidedBy: { ...actor, id: 'approver' } },
          },
          { host: t.host, aborts },
        ),
      ).rejects.toThrow(/ticket unavailable|ticket expired/)
      expect(await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })).toHaveLength(1)
    } finally {
      await t.close()
    }
  })
})

/**
 * These isolate `handleCommand`'s dispatch against tiny fakes, on purpose: `setPreset`/`setModel`
 * must route through `Host.validatePresetSwitch`/`validateModelSwitch` before ever calling
 * `HostSession.setPreset`/`setModel` - the plan's own illustrative sample called a `host.presetView`
 * method that `@agnes/host`'s real `Host` interface does not have (packages/host/src/host.ts has no
 * such member) - and `decideApproval` must resolve through `HostSession.resumeApproval`, since core's
 * `SessionImpl` has no method literally named `decideApproval` (packages/core/src/step/session.ts).
 * A fake proves the *call shape* handleCommand makes without needing a real assembled preset table.
 */
describe('handleCommand dispatch against the real Host/HostSession shapes', () => {
  it('setPreset calls host.setSessionPreset with the session key — not session.setPreset', async () => {
    const calls: string[] = []
    const host = {
      setSessionPreset: async (sessionKey: string, name: string) => {
        calls.push(`set:${sessionKey}:${name}`)
        return 5
      },
    } as unknown as Host
    const session = { key: 'sess-1' } as unknown as HostSession
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'setPreset',
      params: { preset: 'standard' },
    }
    const out = await handleCommand(session, cmd, { host, aborts: new Map() })
    expect(out).toEqual({ effectiveFromSeq: 5 })
    expect(calls).toEqual(['set:sess-1:standard'])
  })

  it('setModel calls host.validateModelSwitch before session.setModel', async () => {
    const calls: unknown[] = []
    const host = { validateModelSwitch: (sel: unknown) => calls.push(['validate', sel]) } as unknown as Host
    const session = {
      setModel: async (sel: unknown) => {
        calls.push(['set', sel])
        return 7
      },
    } as unknown as HostSession
    const sel = { slot: 'primary', route: 'gw', model: 'm1' }
    const cmd: CommandFrame = { kind: 'command', requestId: '1', method: 'setModel', params: { sel } }
    const out = await handleCommand(session, cmd, { host, aborts: new Map() })
    expect(out).toEqual({ effectiveFromSeq: 7 })
    expect(calls).toEqual([
      ['validate', sel],
      ['set', sel],
    ])
  })

  it('setYolo passes the supervisor-minted operator through to the session ledger boundary', async () => {
    let seen: unknown
    const operator: Actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const session = {
      setYolo: async (enabled: boolean, actor: Actor) => {
        seen = { enabled, actor }
        return 3
      },
    } as unknown as HostSession
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'setYolo',
      params: { enabled: true, actor: operator },
    }
    const out = await handleCommand(session, cmd, { host: {} as Host, aborts: new Map() })
    expect(out).toEqual({ effectiveFromSeq: 3 })
    expect(seen).toEqual({ enabled: true, actor: operator })
  })

  it('does not coerce a malformed private setYolo command into an enabled bypass', async () => {
    const setYolo = vi.fn()
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'setYolo',
      params: {
        enabled: 'false',
        actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      },
    }
    await expect(
      handleCommand({ setYolo } as unknown as HostSession, cmd, {
        host: {} as Host,
        aborts: new Map(),
      }),
    ).rejects.toThrow('invalid setYolo command')
    expect(setYolo).not.toHaveBeenCalled()
  })

  it('decideApproval resolves through session.resumeApproval(ticket, verdict, decidedBy)', async () => {
    let seen: unknown
    const session = {
      resumeApproval: async (ticket: string, verdict: string, decidedBy: Actor) => {
        seen = { ticket, verdict, decidedBy }
        return { seq: 9 }
      },
    } as unknown as HostSession
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'decideApproval',
      params: { ticket: 't1', verdict: 'allowed-once', decidedBy: actor },
    }
    const out = await handleCommand(session, cmd, { host: {} as Host, aborts: new Map() })
    expect(out).toEqual({ seq: 9 })
    expect(seen).toEqual({ ticket: 't1', verdict: 'allowed-once', decidedBy: actor })
  })

  it('resolveActor delegates to the worker Host principals seam', async () => {
    const credential = { kind: 'channel', userId: 'worker-user' }
    const resolveActor = async (got: unknown, surface: string) => {
      expect(got).toBe(credential)
      expect(surface).toBe('approval')
      return actor
    }
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'resolveActor',
      params: { credential, surface: 'approval' },
    }
    const out = await handleCommand({} as HostSession, cmd, {
      host: { resolveActor } as unknown as Host,
      aborts: new Map(),
    })
    expect(out).toBe(actor)
  })
})

/**
 * Reverse-verification of the frame protocol's error handling, against the real `JsonlDecoder`
 * (packages/daemon/src/supervisor/framing.ts) and this task's own frame types - not the plan's stale
 * illustrative code. A worker that received a malformed or oversized frame from the supervisor cannot
 * keep reading that link (the decoder never resynchronizes - see framing.ts's own comment), which is
 * exactly what worker/main.ts's `link.on('data', ...)` handler relies on to decide "this link is
 * dead, shut the worker down" rather than silently dropping or misreading whatever follows.
 */
describe('reverse-verification: internal frame protocol error handling', () => {
  it('an oversized frame is rejected as FrameTooLarge, and the decoder does not recover', () => {
    const dec = new JsonlDecoder(64) // small cap so the test does not need a real 16 MiB payload
    const hugeCommand: CommandFrame = {
      kind: 'command',
      requestId: '1',
      method: 'ping',
      params: { pad: 'x'.repeat(200) },
    }
    expect(() => dec.feed(encodeFrame(hugeCommand))).toThrow(FrameTooLarge)
    // Confirmed dead, not merely errored once: a subsequent feed on the same decoder - even with a
    // small, well-formed frame - is refused too.
    expect(() => dec.feed(encodeFrame({ kind: 'close', reason: 'x' }))).toThrow(InvalidFrame)
  })

  it('a malformed (truncated / non-JSON) frame is rejected as InvalidFrame, and the decoder does not recover', () => {
    const dec = new JsonlDecoder()
    expect(() => dec.feed(Buffer.from('{"kind":"command", not json\n'))).toThrow(InvalidFrame)
    expect(() => dec.feed(encodeFrame({ kind: 'ping' }))).toThrow(InvalidFrame)
  })

  it('a well-formed frame still round-trips correctly on a fresh decoder afterward', () => {
    const hello: WorkerHello = {
      kind: 'hello',
      token: 'tok',
      workerKey: '@shared',
      workerGeneration: 1,
      profileHash: `sha256-${'a'.repeat(64)}`,
      workerKind: 'session',
    }
    const cmd: CommandFrame = {
      kind: 'command',
      requestId: '9',
      method: 'latest',
      params: { register: 'budget.state' },
    }
    // A brand-new connection gets a brand-new decoder - one bad link does not poison the protocol for
    // the next one, which is what this asserts against the same `JsonlDecoder` class used above.
    const fresh = new JsonlDecoder()
    const decoded = fresh.feed(Buffer.concat([encodeFrame(hello), encodeFrame(cmd)]))
    expect(decoded).toEqual([hello, cmd])
  })
})
