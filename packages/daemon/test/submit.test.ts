import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import { commandBinding } from '../src/local/command-binding.js'
import { compactOutcomeForRange } from '../src/local/methods/agnes.js'
import type { JournalIdentity, JournalResult } from '../src/local/ports.js'
import { MemoryJournal } from '../src/local/ports.js'
import type { JsonRpcMessage } from '../src/rpc.js'
import { MemorySessionPrincipalOwnership } from '../src/storage/session-ownership.js'
import { openTestHost, slowProvider } from './host.js'

const caps = {
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
}
// The clientId the connection carries is the one submit must be called with; the coupling used to be
// undeclared and only held because both sides happened to default to the literal 'local'.
const CLIENT = 'cli-test'
const SHARED_SOURCE_KEY = ['shared', 'source', 'key'].join('-')
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: caps,
    _meta: { 'ai.agnes.harness': { clientId: CLIENT } },
  },
}
const identity = (principal = 'local', client = CLIENT, sessionId = 'k', commandId = '1') => ({
  principalId: principal,
  clientId: client,
  sessionId,
  commandId,
})
const binding = (kind = 'steer', sessionId = 'k', payload: unknown = {}) =>
  commandBinding(kind, sessionId, undefined, payload)

class CrashAfterDispatchJournal extends MemoryJournal {
  private crash = true
  override async complete(identity: JournalIdentity, result: JournalResult): Promise<void> {
    if (this.crash) {
      this.crash = false
      throw new Error('simulated crash after durable dispatch')
    }
    await super.complete(identity, result)
  }
}

class RevokeOnUncertainJournal extends CrashAfterDispatchJournal {
  revoke = false
  override async begin(identity: JournalIdentity, next: ReturnType<typeof binding>) {
    const state = await super.begin(identity, next)
    if (state.state === 'uncertain') this.revoke = true
    return state
  }
}

const newSession = async (
  ep: { handle(m: JsonRpcMessage): Promise<JsonRpcMessage | undefined> },
  cwd: string,
): Promise<string> => {
  await ep.handle(init)
  const r = (await ep.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd, mcpServers: [] },
  })) as { result: { sessionId: string } }
  return r.result.sessionId
}

describe('MemoryJournal', () => {
  it('reports new / uncertain / complete states', async () => {
    const j = new MemoryJournal()
    const id = identity('c')
    expect(await j.begin(id, binding())).toEqual({ state: 'new' })
    expect(await j.begin(id, binding())).toEqual({ state: 'uncertain' })
    await j.complete(id, { seq: 9 })
    expect(await j.begin(id, binding())).toEqual({ state: 'complete', result: { seq: 9 } })
    await j.ack(id)
    expect(await j.gc(Date.now() + 25 * 3600_000)).toBe(1)
  })

  it('leaves an unacknowledged row alone however old it is', async () => {
    const j = new MemoryJournal()
    const id = identity('c')
    await j.begin(id, binding())
    await j.complete(id, { seq: 9 })
    expect(await j.gc(Date.now() + 1000 * 3600_000)).toBe(0)
    expect(await j.begin(id, binding())).toEqual({ state: 'complete', result: { seq: 9 } })
  })

  it('abandon frees an un-completed row and leaves a completed one alone', async () => {
    const j = new MemoryJournal()
    const id = identity('c', CLIENT, 'k', 'x')
    await j.begin(id, binding())
    await j.abandon(id)
    // Without this the failed dispatch would have left 'x' answering 'uncertain' for good.
    expect(await j.begin(id, binding())).toEqual({ state: 'new' })
    await j.complete(id, { seq: 4 })
    await j.abandon(id)
    expect(await j.begin(id, binding())).toEqual({ state: 'complete', result: { seq: 4 } })
  })

  it('two principals using the same clientId do not share a dedupe row', async () => {
    const j = new MemoryJournal()
    const alice = identity('alice', CLIENT, 'k', 'x')
    await j.begin(alice, binding())
    await j.complete(alice, { seq: 7 })
    expect(await j.begin(identity('bob', CLIENT, 'k', 'x'), binding())).toEqual({ state: 'new' })
  })

  it('rejects reuse of one identity with different command content', async () => {
    const j = new MemoryJournal()
    const id = identity()
    expect(await j.begin(id, binding('steer', 'k', { text: 'one' }))).toEqual({ state: 'new' })
    expect(await j.begin(id, binding('steer', 'k', { text: 'two' }))).toEqual({ state: 'conflict' })
  })
})

describe('compact outcome association', () => {
  const event = (seq: number, type: string) => ({
    seq,
    ts: '2026-01-01T00:00:00Z',
    type,
    data: {},
    actor: { id: 'u' },
  })
  const session = (...rows: ReturnType<typeof event>[]) => ({
    scan: async ({ type }: { type: string }) => rows.filter((row) => row.type === type),
  })

  it('only certifies the unique terminal fact between this marker and run end', async () => {
    await expect(
      compactOutcomeForRange(
        session(event(4, 'x/core/compaction-end'), event(8, 'x/core/compaction-end')),
        5,
        9,
      ),
    ).resolves.toEqual({ state: 'completed', endSeq: 9 })
    await expect(
      compactOutcomeForRange(
        session(event(4, 'x/core/compaction-end'), event(8, 'x/core/compaction-failed')),
        5,
        9,
      ),
    ).resolves.toEqual({ state: 'failed', endSeq: 9 })
  })

  it('reads every page of a real SQLite ledger: the fact after 600 earlier ones still counts', async () => {
    const h = await openTestHost()
    try {
      const real = await h.host.createSession({ cwd: h.dataDir })
      const earlier = Array.from({ length: 600 }, (_, n) =>
        real.ev('x/core/compaction-end', { n }, { ignorable: true }),
      )
      for (let i = 0; i < earlier.length; i += 100) await real.append(earlier.slice(i, i + 100))
      const markerSeq = real.lastSeq
      await real.append([real.ev('x/core/compaction-end', { n: 600 }, { ignorable: true })])
      await expect(compactOutcomeForRange(real, markerSeq, real.lastSeq)).resolves.toEqual({
        state: 'completed',
        endSeq: real.lastSeq,
      })
    } finally {
      await h.close()
    }
  })

  it('returns unknown for no fact or conflicting facts instead of reporting success', async () => {
    await expect(compactOutcomeForRange(session(event(4, 'x/core/compaction-end')), 5, 9)).resolves.toEqual({
      state: 'unknown',
    })
    await expect(
      compactOutcomeForRange(
        session(event(6, 'x/core/compaction-end'), event(8, 'x/core/compaction-failed')),
        5,
        9,
      ),
    ).resolves.toEqual({ state: 'unknown' })
  })
})

describe('steer / followUp / submit', () => {
  it('releases prompt admission before the model turn so in-turn input is not blocked', async () => {
    const h = await openTestHost({ provider: slowProvider(10_000) })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    const prompt = ep.handle({
      jsonrpc: '2.0',
      id: 30,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'slow' }] },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const followUp = ep.handle({
      jsonrpc: '2.0',
      id: 31,
      method: '_agnes/v1/session.followUp',
      params: {
        sessionId,
        content: [{ type: 'text', text: 'while running' }],
        commandId: 'during-prompt',
      },
    })
    expect(
      await Promise.race([
        followUp,
        new Promise((_, reject) => setTimeout(() => reject(new Error('followUp blocked by prompt')), 500)),
      ]),
    ).toMatchObject({ result: { seq: expect.any(Number) } })
    await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    await prompt
    await ep.close()
    await h.close()
  })

  it('replays the same seq for a repeated commandId and forwards it into the ledger', async () => {
    const h = await openTestHost()
    let now = Date.now()
    const journal = new MemoryJournal(() => now)
    const ep = h.endpoint({ clock: () => now, pollMs: 5, journal })
    const sessionId = await newSession(ep, h.dataDir)
    const a = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.followUp',
      params: { sessionId, content: [{ type: 'text', text: 'later' }], commandId: 'c1' },
    })) as { result: { seq: number } }
    const b = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.followUp',
      params: { sessionId, content: [{ type: 'text', text: 'later' }], commandId: 'c1' },
    })) as { result: { seq: number } }
    expect(b.result.seq).toBe(a.result.seq)
    const ack = await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/submit',
      params: {
        clientId: CLIENT,
        commandId: 'c1',
        kind: 'followUp',
        payload: { sessionId, content: [{ type: 'text', text: 'later' }] },
      },
    })
    expect(ack).toMatchObject({ result: { seq: a.result.seq, replayed: true } })
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 6,
        method: '_agnes/v1/submit',
        params: {
          clientId: CLIENT,
          commandId: 'c1',
          kind: 'followUp',
          payload: { sessionId, content: [{ type: 'text', text: 'changed' }] },
        },
      }),
    ).toMatchObject({ error: { code: -32011, data: { code: 'ID_CONFLICT' } } })
    const session = h.host.kernel.get(sessionId)
    const rows = await session?.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'inbox' })
    // The second layer is real: core takes commandId, so the inbox row carries it - and exactly one
    // inbox row does, which is the same thing as saying nothing was enqueued twice.
    expect(rows?.filter((r) => JSON.stringify(r).includes('"c1"'))).toHaveLength(1)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 7,
        method: '_agnes/v1/submit.ack',
        params: { clientId: CLIENT, sessionId, commandId: 'c1' },
      }),
    ).toMatchObject({ result: {} })
    now += 25 * 3600_000
    expect(await journal.gc(now)).toBe(1)
    await ep.close()
    await h.close()
  })

  it('a steer and a followUp reach different inbox targets', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.steer',
      params: { sessionId, content: [{ type: 'text', text: 'now' }], commandId: 's1' },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.followUp',
      params: { sessionId, content: [{ type: 'text', text: 'later' }], commandId: 'f1' },
    })
    const session = h.host.kernel.get(sessionId)
    const inbox = session?.latest('inbox') as { items: Array<{ target: string; kind: string }> }
    expect(inbox.items.map((i) => `${i.target}:${i.kind}`)).toEqual([
      'next-step:steer',
      'next-turn:follow_up',
    ])
    await ep.close()
    await h.close()
  })

  it('rejects a stale generation before admission and permits a corrected retry', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    const send = (generation: number, id: number) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: '_agnes/v1/session.followUp',
        params: {
          sessionId,
          content: [{ type: 'text', text: 'fenced' }],
          commandId: 'generation-retry',
          generation,
        },
      })
    expect(await send(2, 20)).toMatchObject({
      error: { code: -32004, data: { code: 'GENERATION_STALE', generation: 1 } },
    })
    expect(await send(1, 21)).toMatchObject({ result: { seq: expect.any(Number) } })
    await ep.close()
    await h.close()
  })

  it('a failed dispatch does not poison the commandId', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    const bad = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/submit',
      params: {
        clientId: CLIENT,
        commandId: 'c2',
        kind: 'steer',
        payload: { sessionId: 'agnes:nope', content: [{ type: 'text', text: 'x' }] },
      },
    })
    expect(bad).toMatchObject({ error: { code: -32003, data: { code: 'SESSION_NOT_FOUND' } } })
    // Retrying the same commandId against a session that exists must work, not report 'uncertain'.
    const retry = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/submit',
      params: {
        clientId: CLIENT,
        commandId: 'c2',
        kind: 'steer',
        payload: { sessionId, content: [{ type: 'text', text: 'x' }] },
      },
    })) as { result: { seq: number; replayed: boolean } }
    expect(retry.result).toMatchObject({ replayed: false })
    expect(retry.result.seq).toBeGreaterThan(0)
    await ep.close()
    await h.close()
  })

  it('recovers an inbox receipt after dispatch committed but journal completion was interrupted', async () => {
    const h = await openTestHost()
    const journal = new CrashAfterDispatchJournal()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5, journal })
    const sessionId = await newSession(ep, h.dataDir)
    const request = {
      sessionId,
      content: [{ type: 'text' as const, text: 'survived' }],
      commandId: 'crash-window',
    }
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 60,
        method: '_agnes/v1/session.followUp',
        params: request,
      }),
    ).toMatchObject({ error: { code: -32603 } })
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 61,
        method: '_agnes/v1/session.followUp',
        params: request,
      }),
    ).toMatchObject({ result: { seq: expect.any(Number) } })
    const session = h.host.kernel.get(sessionId)
    const rows = await session?.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'inbox' })
    expect(rows?.filter((row) => JSON.stringify(row).includes('"crash-window"'))).toHaveLength(1)
    await ep.close()
    await h.close()
  })

  it('rechecks ownership after journal begin before recovering an uncertain mutation', async () => {
    const h = await openTestHost()
    const journal = new RevokeOnUncertainJournal()
    const original = MemorySessionPrincipalOwnership.prototype.resolve
    const resolve = vi.spyOn(MemorySessionPrincipalOwnership.prototype, 'resolve')
    resolve.mockImplementation(function (this: MemorySessionPrincipalOwnership, sessionId) {
      if (journal.revoke) return undefined
      return original.call(this, sessionId)
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5, journal })
    try {
      const sessionId = await newSession(ep, h.dataDir)
      const request = {
        sessionId,
        content: [{ type: 'text' as const, text: 'only-once' }],
        commandId: 'ownership-lost-after-begin',
      }
      await expect(
        ep.handle({
          jsonrpc: '2.0',
          id: 62,
          method: '_agnes/v1/session.followUp',
          params: request,
        }),
      ).resolves.toMatchObject({ error: { code: -32603 } })
      await expect(
        ep.handle({
          jsonrpc: '2.0',
          id: 63,
          method: '_agnes/v1/session.followUp',
          params: request,
        }),
      ).resolves.toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
      })
      const session = h.host.kernel.get(sessionId)
      const rows = await session?.scan({ fromSeq: 1, toSeq: session.lastSeq, type: 'inbox' })
      expect(rows?.filter((row) => JSON.stringify(row).includes('ownership-lost-after-begin'))).toHaveLength(
        1,
      )
    } finally {
      resolve.mockRestore()
      await ep.close()
      await h.close()
    }
  })

  it('rechecks ownership after compact receipt discovery before running recovery', async () => {
    const h = await openTestHost()
    const journal = new CrashAfterDispatchJournal()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5, journal })
    let deny = false
    const originalResolve = MemorySessionPrincipalOwnership.prototype.resolve
    const resolve = vi
      .spyOn(MemorySessionPrincipalOwnership.prototype, 'resolve')
      .mockImplementation(function (this: MemorySessionPrincipalOwnership, sessionId) {
        return deny ? undefined : originalResolve.call(this, sessionId)
      })
    try {
      const sessionId = await newSession(ep, h.dataDir)
      const session = h.host.kernel.get(sessionId)
      if (!session) throw new Error('session unavailable')
      const originalScan = session.scan.bind(session)
      const scan = vi.spyOn(session, 'scan').mockImplementation(async (query) => {
        const rows = await originalScan(query)
        if (query.type === 'x/core/manual-compaction') deny = true
        return rows
      })
      const run = vi.spyOn(session, 'run')
      const request = {
        jsonrpc: '2.0' as const,
        method: '_agnes/v1/submit',
        params: {
          clientId: CLIENT,
          commandId: 'compact-owner-loss',
          kind: 'compact',
          payload: { sessionId },
        },
      }
      await expect(ep.handle({ ...request, id: 70 })).resolves.toMatchObject({
        error: { code: -32603 },
      })
      await expect(ep.handle({ ...request, id: 71 })).resolves.toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
      })
      expect(run).toHaveBeenCalledTimes(1)
      scan.mockRestore()
      run.mockRestore()
    } finally {
      resolve.mockRestore()
      await ep.close()
      await h.close()
    }
  })

  it('the ledger Actor is the identity the server set, never the label the client wrote', async () => {
    // clientId comes from initialize._meta and is written by the client. The Actor goes into an
    // append-only record, so taking the id from there would let a caller sign another identity's
    // name to it permanently. Both method families are checked, because both mint an Actor: the ACP
    // prompt path and the _agnes/v1 steer / followUp / submit path.
    const h = await openTestHost()
    const ep = h.endpoint({
      clock: () => Date.now(),
      pollMs: 5,
      identity: { principalId: 'server-said-alice', authKind: 'jwt', credentialKind: 'jwt' },
    })
    const sessionId = await newSession(ep, h.dataDir)
    // The two differ, so an Actor taken from either one is distinguishable from the other.
    expect(ep.conn.clientId).toBe(CLIENT)
    expect(ep.conn.principalId).toBe('server-said-alice')
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'from the prompt path' }] },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.followUp',
      params: { sessionId, content: [{ type: 'text', text: 'from the agnes path' }], commandId: 'c1' },
    })
    const log = h.host.kernel.get(sessionId)
    const rows = (await log?.scan({ fromSeq: 1, toSeq: log.lastSeq, type: 'inbox' })) ?? []
    // The Actor is on the queued item, not on the envelope: the envelope's actor is core's own for
    // the write, the item's is the one this package minted for the caller.
    const items = rows.flatMap(
      (r) => (r as unknown as { data: { items: Array<{ actor: { id: string } }> } }).data.items,
    )
    expect(items.length).toBeGreaterThanOrEqual(2)
    const ids = new Set(items.map((i) => i.actor.id))
    expect([...ids]).toEqual(['server-said-alice'])
    expect(ids.has(CLIENT)).toBe(false)
    await ep.close()
    await h.close()
  })

  it('submit dedupes on the clientId in the params, not the connection label', async () => {
    // SubmitParams carries a clientId of its own so that one connection can submit for several
    // logical clients, each with its own dedupe row. Reading the connection's label instead would
    // collapse them into one and hand the second caller the first one's Ack.
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    const send = (clientId: string, id: number) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: '_agnes/v1/submit',
        params: {
          clientId,
          commandId: 'same-command',
          kind: 'followUp',
          payload: { sessionId, content: [{ type: 'text', text: 'x' }] },
        },
      })
    const first = (await send('adapter-a', 3)) as { result: { replayed: boolean } }
    const second = (await send('adapter-b', 4)) as { result: { replayed: boolean } }
    const repeat = (await send('adapter-a', 5)) as { result: { replayed: boolean } }
    expect(first.result.replayed).toBe(false)
    // A different logical client, same commandId: its own row, so its message is actually enqueued.
    expect(second.result.replayed).toBe(false)
    // The same one again is the replay, which is what the row is for.
    expect(repeat.result.replayed).toBe(true)
    await ep.close()
    await h.close()
  })

  it('source-auth reconnect cannot select a fresh submit namespace by changing clientId', async () => {
    const h = await openTestHost()
    const journal = new MemoryJournal()
    const now = 1_700_000_000_000
    const connect = async (clientId: string, nonce: string) => {
      const ep = h.endpoint({
        clock: () => now,
        pollMs: 5,
        journal,
        auth: {
          config: {
            transport: 'ws',
            sourceAuthKeys: () => [{ secret: SHARED_SOURCE_KEY, keyId: 'installation-key' }],
          },
          nonces: { consume: () => true },
          clock: () => now,
        },
      })
      const params: Record<string, unknown> = {
        protocolVersion: 1,
        clientCapabilities: caps,
        _meta: { 'ai.agnes.harness': { clientId } },
      }
      const pocket = (params._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
      if (!pocket) throw new Error('missing metadata')
      pocket.auth = {
        kind: 'source-auth',
        timestamp: now / 1000,
        nonce,
        signature: signSourceAuth(
          SHARED_SOURCE_KEY,
          now / 1000,
          nonce,
          sourceAuthCanonical(clientId, params),
        ),
      }
      await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params })
      return ep
    }
    const first = await connect('adapter-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const made = (await first.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const second = await connect('adapter-renamed', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await second.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: { sessionId: made.result.sessionId, cwd: h.dataDir },
    })
    const send = (ep: typeof first, clientId: string, id: number) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: '_agnes/v1/submit',
        params: {
          clientId,
          commandId: 'same-command',
          kind: 'followUp',
          payload: {
            sessionId: made.result.sessionId,
            content: [{ type: 'text', text: 'once' }],
          },
        },
      })
    await expect(send(first, 'params-a', 3)).resolves.toMatchObject({ result: { replayed: false } })
    await expect(send(second, 'params-b', 3)).resolves.toMatchObject({ result: { replayed: true } })
    await first.close()
    await second.close()
    await h.close()
  })

  it('two principals with the same clientId each get their own dedupe row', async () => {
    // One journal, two connections. Only the client-written label is shared; the principal is what
    // the server set. Keyed on the label alone, the second caller would be handed the first one's
    // Ack for a command it never sent.
    const h = await openTestHost()
    const journal = new MemoryJournal()
    const alice = h.endpoint({ clock: () => Date.now(), pollMs: 5, journal })
    const bobDir = join(h.dataDir, 'bob')
    mkdirSync(bobDir, { recursive: true })
    await h.addWorkspace(bobDir)
    const bob = h.endpoint({
      clock: () => Date.now(),
      pollMs: 5,
      journal,
      // A whole identity, not a bare principal: authKind and credentialKind travel with it so the
      // gates that read them cannot go on believing this is the machine's own user.
      identity: { principalId: 'someone-else', authKind: 'jwt', credentialKind: 'jwt' },
    })
    const aliceSession = await newSession(alice, h.dataDir)
    const bobSession = await newSession(bob, bobDir)
    expect(bob.conn.clientId).toBe(alice.conn.clientId)
    const first = (await alice.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.followUp',
      params: { sessionId: aliceSession, content: [{ type: 'text', text: 'x' }], commandId: 'shared' },
    })) as { result: { seq: number; replayed?: boolean } }
    const second = (await bob.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/submit',
      params: {
        clientId: CLIENT,
        commandId: 'shared',
        kind: 'followUp',
        payload: { sessionId: bobSession, content: [{ type: 'text', text: 'x' }] },
      },
    })) as { result: { seq: number; replayed: boolean } }
    expect(first.result.seq).toBeGreaterThan(0)
    expect(second.result.replayed).toBe(false)
    // bob's row went into bob's own ledger, which is the effect a replayed Ack would have skipped.
    const bobLog = h.host.kernel.get(bobSession)
    const rows = await bobLog?.scan({ fromSeq: 1, toSeq: bobLog.lastSeq, type: 'inbox' })
    expect(rows?.filter((r) => JSON.stringify(r).includes('"shared"'))).toHaveLength(1)
    await alice.close()
    await bob.close()
    await h.close()
  })

  it('rejects a fork submit without a completed turn boundary', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 10,
        method: '_agnes/v1/submit',
        params: {
          clientId: CLIENT,
          commandId: 'fork-without-boundary',
          kind: 'fork',
          payload: { sessionId },
        },
      }),
    ).toMatchObject({ error: { code: -32011, data: { code: 'SEMANTIC_REJECTED' } } })
    await ep.close()
    await h.close()
  })

  it('refuses a submit kind this deployment cannot dispatch', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 10,
        method: '_agnes/v1/submit',
        params: {
          clientId: CLIENT,
          commandId: 'jobs-without-capability',
          kind: 'jobs.enqueue',
          payload: { sessionId },
        },
      }),
    ).toMatchObject({ error: { code: -32006, data: { code: 'CAPABILITY_DENIED' } } })
    await ep.close()
    await h.close()
  })

  it('deduplicates jobs submitted through the common journal path', async () => {
    const h = await openTestHost()
    let enqueues = 0
    const ep = h.endpoint({
      clock: () => Date.now(),
      jobs: {
        enqueue: async (spec) => {
          enqueues++
          return { jobId: (spec as { idempotencyKey: string }).idempotencyKey }
        },
        sessionKey: async () => undefined,
        poll: async () => ({}),
        cancel: async () => undefined,
      },
    })
    await ep.handle(init)
    const sessionId = await newSession(ep, h.dataDir)
    const params = {
      clientId: 'scheduler',
      commandId: 'delivery-one',
      kind: 'jobs.enqueue',
      payload: {
        idempotencyKey: 'job-one',
        sessionKey: sessionId,
        payload: { prompt: 'once' },
        schedule: { kind: 'at', at: Date.now() + 60_000 },
      },
    }
    expect(await ep.handle({ jsonrpc: '2.0', id: 70, method: '_agnes/v1/submit', params })).toMatchObject({
      result: { result: { jobId: 'job-one' }, replayed: false },
    })
    expect(await ep.handle({ jsonrpc: '2.0', id: 71, method: '_agnes/v1/submit', params })).toMatchObject({
      result: { result: { jobId: 'job-one' }, replayed: true },
    })
    expect(enqueues).toBe(1)
    await ep.close()
    await h.close()
  })
})
