import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { noticeParams } from '@agnes/daemon-foundation/local/attached'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { JsonRpcMessage } from '@agnes/daemon-foundation/rpc'
import { notify } from '@agnes/daemon-foundation/rpc'
import { describe, expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { Feed } from '../src/local/methods/acp.js'
import { openTestHost, say, slowProvider } from './host.js'

const caps = (permission: boolean) => ({
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission } } },
})
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: caps(false),
    _meta: { 'ai.agnes.harness': { clientId: 'cli-test' } },
  },
}

async function addWorkspace(ep: LocalEndpoint, path: string): Promise<void> {
  expect(
    await ep.handle({
      jsonrpc: '2.0',
      id: 99,
      method: '_agnes/v1/workspace.add',
      params: { path },
    }),
  ).toMatchObject({ result: { workspace: { revision: 1 } } })
}

/** Close the endpoint first, then read the queue to the end: draining is then finite and ordered,
 *  rather than a detached pump the assertions race. */
async function drain(ep: {
  notifications: AsyncIterable<JsonRpcMessage>
  close(): Promise<void>
}): Promise<JsonRpcMessage[]> {
  await ep.close()
  const out: JsonRpcMessage[] = []
  for await (const n of ep.notifications) out.push(n)
  return out
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type N = {
  method?: string
  params?: { _meta?: Record<string, { phase: string; eventSequence: number; promptTurnId: string }> }
}

describe('local endpoint: ACP round trip', () => {
  it('audits a real SQLite session through the owner RPC, including corruption before its checkpoint', async () => {
    const h = await openTestHost({ provider: new ScriptedProvider({ scripts: [say('evidence')] }) })
    let ep = h.endpoint({ clock: Date.now, pollMs: 5 })
    try {
      await ep.handle(init)
      await addWorkspace(ep, h.dataDir)
      const created = (await ep.handle({
        jsonrpc: '2.0',
        id: 200,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const sessionId = created.result.sessionId
      await ep.handle({
        jsonrpc: '2.0',
        id: 201,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'audit me' }] },
      })
      const audit = (verify: boolean) =>
        ep.handle({
          jsonrpc: '2.0',
          id: 202,
          method: '_agnes/v1/session.integrity',
          params: { sessionId, verify },
        })
      await expect(audit(true)).resolves.toMatchObject({ result: { state: 'verified', legacyThroughSeq: 0 } })
      await ep.close()
      ep = h.endpoint({ clock: Date.now, pollMs: 5 })
      await ep.handle(init)
      await expect(audit(false)).resolves.toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
      expect(h.host.kernel.get(sessionId)).toBeUndefined()
      await expect(audit(true)).resolves.toMatchObject({ result: { state: 'verified', legacyThroughSeq: 0 } })
      const raw = new DatabaseSync(join(h.dataDir, 'sessions.db'))
      const target = raw
        .prepare(
          "SELECT seq FROM events WHERE session_key = ? AND type = 'user/message' ORDER BY seq LIMIT 1",
        )
        .get(sessionId) as { seq: number }
      raw
        .prepare(
          "UPDATE events SET data = json_set(data, '$.content[0].text', 'tampered audit') WHERE session_key = ? AND seq = ?",
        )
        .run(sessionId, target.seq)
      raw.close()
      await expect(audit(true)).resolves.toMatchObject({
        result: { state: 'failed', failureSeq: target.seq },
      })
      await expect(audit(false)).resolves.toMatchObject({
        result: { state: 'failed', failureSeq: target.seq },
      })
      expect(await h.host.kernel.o.storage.readVerifiedHead?.(sessionId)).toBeUndefined()
    } finally {
      await ep.close()
      await h.close()
    }
  })

  it('requires explicit workspace.add before session/new and never grants authority from cwd', async () => {
    const h = await openTestHost()
    const ep = createLocalEndpoint(h.host, { clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const create = (id: number) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })

    await expect(create(2)).resolves.toMatchObject({
      error: { data: { code: 'WORKSPACE_NOT_FOUND' } },
    })
    await expect(
      ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/workspace.add',
        params: { path: h.dataDir },
      }),
    ).resolves.toMatchObject({ result: { workspace: { revision: 1 } } })
    await ep.close()
    await h.close()
  })

  it('initialize → session/new → session/prompt yields updates, quiescence, then the response', async () => {
    const h = await openTestHost({ script: [say('hello world')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    expect(await ep.handle(init)).toMatchObject({ id: 1, result: { protocolVersion: 1 } })
    // The capability is read from clientCapabilities._meta, which is where sdk writes it.
    expect(ep.conn.capabilities.permission).toBe(false)
    expect(ep.conn.clientId).toBe('cli-test')
    expect(ep.conn.principalId).toBe('local')
    await addWorkspace(ep, h.dataDir)
    const created = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = created.result.sessionId
    const res = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })) as { result: { stopReason: string } }
    expect(res.result.stopReason).toBe('end_turn')
    const seen = (await drain(ep)) as N[]
    const updates = seen.filter((n) => n.method === 'session/update')
    // Streamed text rides as previews, which are not rows and carry no harness _meta.
    const stamped = updates.filter((u) => u.params?._meta?.['ai.agnes.harness'] !== undefined)
    const phases = stamped.map((u) => u.params?._meta?.['ai.agnes.harness']?.phase)
    expect(phases.filter((p) => p === 'terminalQuiescence')).toHaveLength(1)
    expect(phases[phases.length - 1]).toBe('terminalQuiescence')
    const seqs = stamped.map((u) => u.params?._meta?.['ai.agnes.harness']?.eventSequence as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    // The assistant's own words reach the client. Everything above holds on a stream that carries
    // only the user echo and an empty quiescence chunk, which is what a feed that lost the streamed
    // text would produce.
    const said = updates
      .map((u) => u.params as unknown as { update: { sessionUpdate: string; content?: { text?: string } } })
      .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.update.content?.text ?? '')
      .join('')
    expect(said).toContain('hello world')
    // Exactly once, not once per carrier: the durable assistant/message row says the same words the
    // previews already streamed, so only what they missed may follow it.
    expect(said).toBe('hello world')
    // Nothing raw goes out on a connection that never attached.
    expect(seen.some((n) => n.method === '_agnes/v1/session.event')).toBe(false)
    await h.close()
  })

  it.each([[0], [1001], [1.5], ['3'], [null]])(
    'rejects the prompt step cap %j and advertises the capability',
    async (cap) => {
      const h = await openTestHost({ script: [say('ok')] })
      const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
      expect(await ep.handle(init)).toMatchObject({
        result: { agentCapabilities: { _meta: { 'ai.agnes.harness': { turnMaxSteps: true } } } },
      })
      await addWorkspace(ep, h.dataDir)
      const created = (await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const prompt = (maxSteps: unknown, id: number) =>
        ep.handle({
          jsonrpc: '2.0',
          id,
          method: 'session/prompt',
          params: {
            sessionId: created.result.sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
            _meta: { 'ai.agnes.harness': { maxSteps } },
          },
        })
      expect(await prompt(cap, 3)).toMatchObject({ error: { data: { reason: 'invalid turn step cap' } } })
      // Nothing was queued by the refusal: a valid cap on the same session still runs the turn.
      expect(await prompt(5, 4)).toMatchObject({ result: { stopReason: 'end_turn' } })
      await ep.close()
      await h.close()
    },
  )

  it('accepts the permission capability from clientCapabilities._meta', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle({ ...init, params: { ...init.params, clientCapabilities: caps(true) } })
    expect(ep.conn.capabilities.permission).toBe(true)
    await ep.close()
    await h.close()
  })

  it('reuses canonical workspace sessions and explicit keys while loop or bundle selections create fresh ledgers', async () => {
    const h = await openTestHost()
    const ep = h.endpoint()
    try {
      await ep.handle(init)
      await addWorkspace(ep, h.dataDir)
      const { id, version } = h.host.kernel.loops.catalog()[0]!
      const create = async (
        meta: { loop?: { id: string; version: string }; sessionKey?: string; bundles?: string[] } = {},
      ) => {
        const response = await ep.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: h.dataDir, mcpServers: [], _meta: { 'ai.agnes.harness': meta } },
        })
        expect(response).toHaveProperty('result.sessionId')
        return (response as { result: { sessionId: string } }).result.sessionId
      }
      const canonical = await create()
      expect(await create()).toBe(canonical)
      const bundled = await create({ bundles: [] })
      expect(bundled).not.toBe(canonical)
      expect(await create({ bundles: [] })).not.toBe(bundled)
      const refused = await ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/new',
        params: {
          cwd: h.dataDir,
          mcpServers: [],
          _meta: { 'ai.agnes.harness': { bundles: ['same', 'same'] } },
        },
      })
      expect(refused).toHaveProperty('error.message', 'SEMANTIC_REJECTED')
      const selected = await create({ loop: { id, version } })
      expect(selected).not.toBe(canonical)
      expect(await create({ loop: { id, version } })).not.toBe(selected)
      expect(await create({ sessionKey: selected, loop: { id, version } })).toBe(selected)
      expect(await create()).toBe(canonical)
    } finally {
      await ep.close()
      await h.close()
    }
  })

  it('refuses a preset that is not in presets.allowed', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const bad = await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: {
        cwd: h.dataDir,
        mcpServers: [],
        _meta: { 'ai.agnes.harness': { preset: 'nope' } },
      },
    })
    expect(bad).toMatchObject({ error: { code: -32008, data: { reason: 'not in presets.allowed' } } })
    // With a bundle selected the Host decides, since the bundle may bring that preset itself; a
    // bundle that is not installed, enabled and trusted is the refusal it reports first.
    const missing = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: {
        cwd: h.dataDir,
        mcpServers: [],
        _meta: { 'ai.agnes.harness': { preset: 'nope', bundles: ['acme/absent#bundle'] } },
      },
    })
    expect(missing).toMatchObject({ error: { code: -32011, data: { code: 'BUNDLE_UNAVAILABLE' } } })
    await ep.close()
    await h.close()
  })

  it('carries a named permission to the Host and refuses one that is not a level', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const create = vi.spyOn(h.host, 'createSession').mockRejectedValue(new Error('stop after capture'))
    const open = (id: number, meta: Record<string, unknown>) =>
      ep.handle({
        jsonrpc: '2.0',
        id,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [], _meta: { 'ai.agnes.harness': meta } },
      })
    for (const permission of ['root', 7])
      expect(await open(2, { permission })).toMatchObject({
        error: { code: -32011, data: { reason: 'invalid permission' } },
      })
    expect(await open(3, { agent: 'acme/pkg#agent', permission: 'read-only' })).toMatchObject({
      error: { code: -32011, data: { reason: 'invalid agent selection' } },
    })
    expect(create).not.toHaveBeenCalled()
    await open(4, { preset: 'standard', permission: 'full-access', sessionKey: 'agnes:permission:a' })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ preset: 'standard', permission: 'full-access' })
    await open(5, { preset: 'standard', sessionKey: 'agnes:permission:b' })
    expect(create.mock.calls[1]?.[0]).toMatchObject({ preset: 'standard' })
    expect(create.mock.calls[1]?.[0]).toHaveProperty('permission', 'default')
    await ep.close()
    await h.close()
  })

  it('rejects non-empty mcpServers and a second in-flight prompt', async () => {
    const h = await openTestHost({ provider: slowProvider(50) })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const bad = await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [{ name: 'x', command: 'x', args: [], env: [] }] },
    })
    expect(bad).toMatchObject({ error: { code: -32011 } })
    const ok = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const p1 = ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'a' }] },
    })
    const p2 = await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'b' }] },
    })
    expect(p2).toMatchObject({ error: { code: -32002 } })
    await p1
    await ep.close()
    await h.close()
  })

  it('session/cancel aborts the in-flight prompt with stopReason cancelled', async () => {
    const h = await openTestHost({ provider: slowProvider(10_000) })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const ok = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const p = ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'x' }] },
    })
    await new Promise((r) => setTimeout(r, 20))
    await ep.handle({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: ok.result.sessionId },
    })
    expect(await p).toMatchObject({ result: { stopReason: 'cancelled' } })
    await ep.close()
    await h.close()
  })

  it.each([
    { method: 'session/load', cold: false },
    { method: 'session/load', cold: true },
    { method: '_agnes/v1/session.open', cold: false },
    { method: '_agnes/v1/session.open', cold: true },
  ])(
    '$method admits and verifies history (cold=$cold), replaying only for ACP load',
    async ({ method, cold }) => {
      const provider = new ScriptedProvider({
        scripts: [say('hi'), say('again'), say('ordinary before verification')],
      })
      const infer = vi.spyOn(provider, 'infer')
      const h = await openTestHost({ provider })
      let ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
      try {
        await ep.handle(init)
        await addWorkspace(ep, h.dataDir)
        const ok = (await ep.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: h.dataDir, mcpServers: [] },
        })) as { result: { sessionId: string } }
        await ep.handle({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'x' }] },
        })
        await ep.handle({
          jsonrpc: '2.0',
          id: 6,
          method: 'session/prompt',
          params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'next' }] },
        })
        if (cold) {
          await ep.close()
          ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
          await ep.handle(init)
        }
        // Preview frames use a separate budget but share the ordered notification queue.
        const before = ep.pending().events + ep.pendingPreviews().events
        expect(
          await ep.handle({
            jsonrpc: '2.0',
            id: 4,
            method,
            params: {
              sessionId: ok.result.sessionId,
              cwd: h.dataDir,
              ...(method === 'session/load' ? { mcpServers: [] } : { requestId: 'open-1' }),
            },
          }),
        ).toMatchObject({ result: {} })
        // Finish the healthy check before editing storage; no race with its background hash pass.
        const healthy = h.host.kernel.sessions.get(ok.result.sessionId)
        if (!healthy) throw new Error('load did not open the session')
        await healthy.d.log.fullVerified()
        let coldReplay: JsonRpcMessage[] | undefined
        if (cold) {
          coldReplay = (await drain(ep)).slice(before)
          ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
          await ep.handle(init)
        } else {
          // Without a checkpoint, a live recheck must detect corruption in the foreground.
          await h.host.kernel.o.storage.deleteVerifiedHead?.(ok.result.sessionId)
          expect(await h.host.kernel.o.storage.readVerifiedHead?.(ok.result.sessionId)).toBeUndefined()
        }
        const raw = new DatabaseSync(join(h.dataDir, 'sessions.db'))
        const turns = raw
          .prepare("SELECT seq FROM events WHERE session_key = ? AND type = 'turn/start' ORDER BY seq")
          .all(ok.result.sessionId) as { seq: number }[]
        raw
          .prepare(
            "UPDATE events SET data = json_set(data, '$.content[0].text', 'changed') WHERE session_key = ? AND type = 'user/message'",
          )
          .run(ok.result.sessionId)
        raw.close()
        const load = () =>
          ep.handle({
            jsonrpc: '2.0',
            id: 5,
            method,
            params: {
              sessionId: ok.result.sessionId,
              cwd: h.dataDir,
              ...(method === 'session/load' ? { mcpServers: [] } : { requestId: 'open-2' }),
            },
          })
        if (cold) {
          const storage = h.host.kernel.o.storage
          const scan = storage.scanIntegrity.bind(storage)
          const gate = deferred()
          const reached = deferred()
          let folded = false
          // Ignore single-row authority probes. Cold open folds the prefix; the explicit full verification rehashes it.
          const hold = vi.spyOn(storage, 'scanIntegrity').mockImplementation(async (key, query) => {
            if (key === ok.result.sessionId && query.fromSeq === 1 && query.toSeq > 1) {
              if (folded) {
                reached.resolve()
                await gate.promise
              }
              folded = true
            }
            return scan(key, query)
          })
          try {
            await expect(load()).resolves.toMatchObject({ result: {} })
            const session = h.host.kernel.sessions.get(ok.result.sessionId)
            if (!session) throw new Error('cold load did not open the session')
            const log = session.d.log
            expect(log.openStats.checkpoint).toMatchObject({ used: true })
            // Cold open returns before its automatic prefix check; only attestations wait.
            expect(log.historyVerified).toBe(false)
            await reached.promise
            expect(log.historyVerified).toBe(false)
            infer.mockClear()
            const queued = deferred()
            const appended: string[] = []
            const off = session.onAppended((events) => {
              appended.push(...events.map((event) => event.type))
              if (events.some((event) => event.type === 'inbox')) queued.resolve()
            })
            const prompt = () =>
              ep.handle({
                jsonrpc: '2.0',
                id: 7,
                method: 'session/prompt',
                params: { sessionId: session.key, prompt: [{ type: 'text', text: 'must not execute' }] },
              })
            try {
              // An ordinary model step can run; the final verifier gate still waits for history.
              const pending = prompt()
              await queued.promise
              await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(1))
              expect(appended).not.toContain('turn/end')
              const verified = expect(log.fullVerified()).rejects.toMatchObject({
                code: 'E_LEDGER_INTEGRITY',
              })
              gate.resolve()
              await verified
              expect(log.faulted).toBe(true)
              expect(await storage.readVerifiedHead?.(session.key)).toBeUndefined()
              await expect(pending).resolves.toMatchObject({
                error: { data: { code: 'TURN_ERROR', error: { code: 'E_LEDGER_INTEGRITY' } } },
              })
              await expect(prompt()).resolves.toMatchObject({
                error: { data: { code: 'E_LEDGER_INTEGRITY' } },
              })
              await expect(load()).resolves.toMatchObject({ error: { data: { code: 'E_SESSION_CORRUPT' } } })
              expect(infer).toHaveBeenCalledTimes(1)
              expect(appended).not.toContain('turn/end')
            } finally {
              off()
            }
          } finally {
            gate.resolve()
            hold.mockRestore()
          }
        } else {
          await expect(load()).resolves.toMatchObject({ error: { data: { code: 'E_SESSION_CORRUPT' } } })
        }
        const remaining = await drain(ep)
        const replayed = (coldReplay ?? remaining.slice(before)) as N[]
        const updates = replayed
          .filter((n) => n.method === 'session/update')
          .map(
            (n) =>
              (n.params as unknown as { update: { sessionUpdate: string; content?: { text?: string } } })
                .update,
          )
        const kinds = updates.map((u) => u.sessionUpdate)
        if (method !== 'session/load') {
          // A lagging live turn/end may still deliver its empty quiescence carrier.
          expect(updates.filter((update) => update.content?.text !== '')).toEqual([])
          return
        }
        expect(turns).toHaveLength(2)
        for (const n of replayed.filter((n) => n.method === 'session/update')) {
          const meta = n.params?._meta?.['ai.agnes.harness']
          expect(meta).toBeDefined()
          if (meta)
            expect(meta.promptTurnId).toBe(
              String(turns.filter((t) => t.seq <= meta.eventSequence).at(-1)?.seq ?? 0),
            )
        }
        // Only the durable classes come back; chunks and turn edges are not part of a load.
        expect(kinds).toContain('user_message_chunk')
        expect(
          kinds.every((k) =>
            ['user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(
              k,
            ),
          ),
        ).toBe(true)
        // Both halves of the conversation, not just the client's own. Chunks are excluded from a load,
        // so assistant/message is the only row that can carry the answer back.
        expect(kinds).toContain('agent_message_chunk')
        const said = updates
          .filter((u) => u.sessionUpdate === 'agent_message_chunk')
          .map((u) => u.content?.text ?? '')
          .join('')
        // A cold connection can also receive the registry's historical live-tail backlog. Check
        // attribution on every frame above without making duplicate delivery part of this contract.
        if (cold) expect(said).toContain('hiagain')
        else expect(said).toBe('hiagain')
      } finally {
        await ep.close()
        infer.mockRestore()
        await h.close()
      }
    },
  )

  it('session/set_mode switches to an allowed preset and rejects one outside presets.allowed', async () => {
    // The fixture host's local-dev-shaped profile allows only 'standard' (packages/host/testkit's
    // default); 'minimal-rl' is a real preset name elsewhere in this codebase but is not in this
    // deployment's presets.allowed, so it exercises the same host gate a disallowed arbitrary name
    // would - `validatePresetSwitch` -> `E_PRESET_UNSUPPORTED` -> `mapCore` -> -32008.
    const h = await openTestHost({
      profileInputs: {
        bundleCatalog: {
          'acme/modes#modes': {
            id: 'acme/modes#modes',
            sourcePackage: 'acme/modes',
            document: { presets: { review: { name: 'review', extends: 'standard' } } },
          },
        },
      },
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const ok = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/set_mode',
        params: { sessionId: ok.result.sessionId, modeId: 'standard' },
      }),
    ).toMatchObject({ result: {} })
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/set_mode',
        params: { sessionId: ok.result.sessionId, modeId: 'minimal-rl' },
      }),
    ).toMatchObject({ error: { code: -32008 } })
    const bundled = (await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/new',
      params: {
        cwd: h.dataDir,
        mcpServers: [],
        _meta: { 'ai.agnes.harness': { bundles: ['acme/modes#modes'] } },
      },
    })) as { result: { sessionId: string } }
    expect(bundled.result.sessionId).toBeTypeOf('string')
    for (const method of ['session/set_mode', '_agnes/v1/session.setPreset']) {
      const switchTo = (sessionId: string, preset: string) =>
        ep.handle({
          jsonrpc: '2.0',
          id: 6,
          method,
          params: { sessionId, ...(method === 'session/set_mode' ? { modeId: preset } : { preset }) },
        })
      expect(await switchTo(bundled.result.sessionId, 'standard')).toHaveProperty('result')
      expect(await switchTo(bundled.result.sessionId, 'review')).toHaveProperty('result')
      expect(await switchTo(ok.result.sessionId, 'review')).toHaveProperty('error.code', -32008)
    }
    await ep.close()
    await h.close()
  })

  it('answers the prompt even if the quiescence carrier never arrives', async () => {
    // Feed.pushed() used to wait for run()'s lastSeq unconditionally, so a lastSeq that no tailed row
    // ever carries hung session/prompt for good. The wait is now bounded and the response still goes.
    const h = await openTestHost({ script: [say('hi')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5, quiescenceWaitMs: 30 })
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const ok = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const started = Date.now()
    const r = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'x' }] },
    })
    expect(r).toMatchObject({ result: { stopReason: 'end_turn' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    await ep.close()
    await h.close()
  })

  it('the prompt response is the last thing the client sees, after the quiescence carrier', async () => {
    // Draining after the fact only shows that quiescence was sent, not that it was sent first. This
    // records the two in one order: with the wait removed, run() returns before the tail has even
    // read turn/end and the response lands ahead of it.
    const h = await openTestHost({ script: [say('ordered')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const order: string[] = []
    const pump = (async () => {
      for await (const n of ep.notifications) {
        const m = n as N
        if (m.method === 'session/update')
          order.push(`update:${m.params?._meta?.['ai.agnes.harness']?.phase}`)
      }
    })()
    await ep.handle(init)
    await addWorkspace(ep, h.dataDir)
    const ok = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: ok.result.sessionId, prompt: [{ type: 'text', text: 'x' }] },
    })
    order.push('response')
    expect(order.indexOf('update:terminalQuiescence')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('response')).toBeGreaterThan(order.indexOf('update:terminalQuiescence'))
    await ep.close()
    await pump
    await h.close()
  })

  it('a replayed tool result is preceded by the call that announced its id', async () => {
    // tool_call_update names a toolCallId. Replaying the result without the call left an ACP client
    // that keys tool calls by id holding an update for a call it had never been told about.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const feed = new Feed(ep, { key: 'k', generation: 1 } as never, () => undefined)
    const row = (seq: number, type: string, data: unknown) =>
      ({
        seq,
        ts: '1970-01-01T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type,
        data,
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'model',
        trust: 'trusted',
        lane: 'main',
      }) as never
    feed.replayLoad([
      row(1, 'user/message', { content: [{ type: 'text', text: 'go' }] }),
      row(2, 'assistant/output', {
        state: 'started',
        effectId: 'e1',
        chars: { text: 8, thinking: 0 },
        estimatedTokens: 2,
      }),
      row(3, 'tool/call', { toolUseId: 't1', name: 'ls', args: {}, ordinal: 0 }),
      row(4, 'tool/result', { toolUseId: 't1', content: [], isError: false }),
      row(5, 'assistant/message', { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }),
      row(6, 'turn/end', { reason: 'completed', lastAssistantSeq: 5 }),
    ])
    const kinds = (
      (await drain(ep)) as unknown as Array<{ params: { update: { sessionUpdate: string } } }>
    ).map((n) => n.params.update.sessionUpdate)
    expect(kinds).toEqual(['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk'])
  })

  it('Feed.pushed gives up on a seq no row will ever carry', async () => {
    // The bound itself, not a turn that happens to be fast: a seq the feed will never see must still
    // release the waiter, or session/prompt never answers.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const entry = { key: 'k', generation: 1 } as never
    const feed = new Feed(ep, entry, () => undefined)
    const started = Date.now()
    await feed.pushed(999, { timeoutMs: 20 })
    expect(Date.now() - started).toBeLessThan(2_000)
    await ep.close()
  })

  it('distinguishes a replacement registry entry with the same session key', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const oldEntry = { key: 'same', generation: 1 } as never
    const replacement = { key: 'same', generation: 1 } as never
    const feed = new Feed(ep, oldEntry, () => undefined)

    expect(feed.belongsTo(oldEntry)).toBe(true)
    expect(feed.belongsTo(replacement)).toBe(false)

    await ep.close()
  })
})

describe('result validation', () => {
  it('refuses to ship a result its own schema forbids', async () => {
    // `_agnes/v1/session.detach` declares Empty, so `{ ok: true }` is a violation. Without an
    // enforcement point here it would leave the server looking valid and land on the client.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.register('initialize', async (_p, c) => {
      c.conn.initialized = true
      return { protocolVersion: 1 }
    })
    ep.register('_agnes/v1/session.detach', async () => ({ ok: true }))
    await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    const r = await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/session.detach',
      params: { sessionId: 'k' },
    })
    expect(r).toMatchObject({ error: { code: -32603, data: { code: 'RESULT_INVALID' } } })
    await ep.close()
  })

  it('leaves a method with no declared result alone', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.register('initialize', async (_p, c) => {
      c.conn.initialized = true
      return { protocolVersion: 1 }
    })
    ep.register('session/cancel', async () => undefined)
    await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    // A notification gets no response at all, valid or otherwise.
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'k' } }),
    ).toBeUndefined()
    await ep.close()
  })

  // A real test Host: well under a second alone, 2 to 6 s on the Windows runner.
  it('session/load cannot claim an unseen id even when the caller supplies a cwd', async () => {
    const h = await openTestHost({ script: [say('hi')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const id = 'agnes:local:local-dev:cli:dm:unseen'
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/load',
        params: { sessionId: id, cwd: h.dataDir, mcpServers: [] },
      }),
    ).toMatchObject({
      error: { code: -32006, data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
    })
    await ep.close()
    await h.close()
  }, 30_000)

  // A real test Host: well under a second alone, 2 to 6 s on the Windows runner.
  it('rejects an unseen id with an empty cwd through the same fixed ownership denial', async () => {
    const h = await openTestHost({ script: [say('hi')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/load',
        params: { sessionId: 'agnes:local:local-dev:cli:dm:rootless', cwd: '', mcpServers: [] },
      }),
    ).toMatchObject({
      error: { code: -32006, data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
    })
    await ep.close()
    await h.close()
  }, 30_000)
})

describe('outbound validation', () => {
  // A daemon.notice whose kind is not in the schema's closed set. Every bypass of the source-text
  // guard ends here: what a client is handed is this payload, however the method name was spelled.
  const bad = { kind: 'invalid-event', detail: { anything: true }, at: '2026-09-07T00:00:00.000Z' }
  const NOTICE = '_agnes/v1/daemon.notice'
  /** The error a refusal throws, or undefined if the frame went out. */
  const thrownBy = (fn: () => void): unknown => {
    try {
      fn()
      return undefined
    } catch (e) {
      return e
    }
  }

  it('refuses a hand-built notice whatever the method name is spelled with', async () => {
    // The three ways the source-text guard was defeated. It matches the single-quoted literal within
    // 40 characters of `notify(` and then wants `noticeParams(` in the next 200; a backtick, a
    // concatenation, or an unrelated legitimate neighbour inside that window all walk past it. None
    // of them walks past this, because this reads the frame rather than the text that built it.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const backtick = `_agnes/v1/daemon.notice`
    const concatenated = `${'_agnes/v1/'}daemon.notice`
    for (const method of [NOTICE, backtick, concatenated])
      expect(thrownBy(() => ep.push({ jsonrpc: '2.0', method, params: bad }))).toMatchObject({
        code: -32603,
        data: { code: 'OUTBOUND_INVALID', method: NOTICE },
      })
    // Nothing reached the queue on any of the three.
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
  })

  it('lets a notice built through noticeParams through', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.push(
      notify(NOTICE, noticeParams('overloaded', { sessionId: 'k', detail: { code: 'OVERLOADED' }, atMs: 0 })),
    )
    expect(ep.pending().events).toBe(1)
    await ep.close()
  })

  it('refuses a malformed session.event and a malformed ACP update too', async () => {
    // Not just the notice channel: every frame this server builds of its own accord is measured
    // against the same table a client will measure it against.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    expect(
      thrownBy(() => ep.push(notify('_agnes/v1/session.event', { sessionId: 'k', event: { seq: 'one' } }))),
    ).toMatchObject({ data: { code: 'OUTBOUND_INVALID', method: '_agnes/v1/session.event' } })
    expect(
      thrownBy(() =>
        ep.push(notify('session/update', { sessionId: 'k', update: { sessionUpdate: 'no_such_kind' } })),
      ),
    ).toMatchObject({ data: { code: 'OUTBOUND_INVALID', method: 'session/update' } })
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
  })

  it('refuses a server-to-client request its own schema forbids, leaving nothing behind', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    await expect(ep.request('session/request_permission', { sessionId: 's' })).rejects.toMatchObject({
      code: -32603,
      data: { code: 'OUTBOUND_INVALID' },
    })
    expect(ep.pendingRequests()).toBe(0)
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
  })

  it('refuses a client-to-server name pushed outbound, however well-formed', async () => {
    // A c2s name has a schema, so validating one would let a well-formed session/prompt out as a
    // server notification. The direction has already decided it: handle() refuses the mirror image
    // inbound, and this refuses here.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    expect(thrownBy(() => ep.push(notify('session/prompt', { junk: 1 })))).toMatchObject({
      code: -32603,
      data: { code: 'OUTBOUND_WRONG_DIRECTION', method: 'session/prompt' },
    })
    // Even a params the method's own schema would accept.
    expect(
      thrownBy(() =>
        ep.push(notify('session/prompt', { sessionId: 's', prompt: [{ type: 'text', text: 'x' }] })),
      ),
    ).toMatchObject({ data: { code: 'OUTBOUND_WRONG_DIRECTION' } })
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
  })

  it('leaves a method the table does not know alone', async () => {
    // The table is the whole gate, and this is the edge of the check: a name outside it has no
    // schema to be measured against, and refusing it would make this a second place that decides
    // which methods exist. So an unknown name goes out unmeasured, deliberately - the check covers
    // what the protocol describes, not everything that can be pushed.
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.push({ jsonrpc: '2.0', method: 'x/not-a-method', params: { anything: true } })
    expect(ep.pending().events).toBe(1)
    await ep.close()
  })
})
