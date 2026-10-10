import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { describe, expect, it } from 'vitest'
import { type AskOutcome, PrompterRouter } from '../src/local/prompter.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const req = {
  requestId: 'r1',
  kind: 'tool' as const,
  sessionKey: 'k',
  stepId: '1',
  toolUseId: 't1',
  tool: { name: 'shell', args: { command: 'rm -rf x' }, meta: {} as never },
  summary: 'run rm',
  risk: 'destructive' as const,
  actor,
  taint: false,
  bindingHash: 'h',
  deadline: new Date(60_000).toISOString(),
  scope: 'workspace',
}
const never = new AbortController().signal
const mk = (o: Partial<ConstructorParameters<typeof PrompterRouter>[0]> = {}) => {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  const log: AskOutcome[] = []
  const r = new PrompterRouter({
    endpointFor: () => ep,
    connections: () => [ep.conn],
    originOf: () => ep.conn,
    clock: () => 0,
    record: (x) => log.push(x),
    ...o,
  })
  return { ep, r, log }
}

describe('PrompterRouter', () => {
  it('prefers the local prompter', async () => {
    const { r, log } = mk({ local: { ask: async () => 'allowed-once' } })
    await expect(r.ask(req as never, { signal: never })).resolves.toBe('allowed-once')
    expect(log).toEqual([{ requestId: 'r1', via: 'local', verdict: 'allowed-once' }])
  })

  it('only routes to a connection that declared the permission capability, and maps the answer', async () => {
    const { ep, r, log } = mk()
    // Without the capability the router must not send anything at all.
    await expect(r.ask(req as never, { signal: never })).resolves.toBe('unavailable')
    expect(ep.pending().events).toBe(0)
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as {
      id: string
      method: string
      params: { options: Array<{ kind: string }>; toolCall: { title: string; rawInput: unknown } }
    }
    expect(m.method).toBe('session/request_permission')
    expect(m.params.toolCall).toMatchObject({ title: req.summary, rawInput: req.tool.args })
    expect(m.params.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once'])
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_always' } },
    })
    await expect(p).resolves.toBe('allowed-session')
    expect(log.map((x) => x.via)).toEqual(['absent', 'answered'])
  })

  it.each([
    ['read', 'read'],
    ['write', 'edit'],
    ['edit', 'edit'],
    ['shell', 'execute'],
    ['run_code', 'execute'],
    ['web_fetch', 'fetch'],
    ['subagent_spawn', 'other'],
    ['mcp__db__query', 'other'],
    // Names that are properties of every object must not read a kind off the prototype.
    ['constructor', 'other'],
    ['__proto__', 'other'],
  ])('%s is shown as kind %s, a value the outbound validation accepts', async (tool, kind) => {
    const { ep, r } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask({ ...req, tool: { ...req.tool, name: tool } } as never, { signal: never })
    // An invalid kind never reaches the wire: the endpoint refuses it and the router fails closed.
    const m = (await Promise.race([
      it.next().then((n) => n.value),
      p.then((verdict) => {
        throw new Error(`refused before anyone was asked: ${verdict}`)
      }),
    ])) as { id: string; params: { toolCall: { kind: string; _meta: unknown } } }
    expect(m.params.toolCall.kind).toBe(kind)
    expect(m.params.toolCall._meta).toEqual({ 'ai.agnes.harness': { tool } })
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toBe('allowed-once')
  })

  it('a request that is not about a tool is kind other and names no tool', async () => {
    const { ep, r } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const { tool: _tool, ...rest } = req
    const p = r.ask({ ...rest, kind: 'budget' } as never, { signal: never })
    const m = (await it.next()).value as { id: string; params: { toolCall: Record<string, unknown> } }
    expect(m.params.toolCall.kind).toBe('other')
    expect(m.params.toolCall._meta).toBeUndefined()
    await ep.handle({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } })
    await expect(p).resolves.toBe('cancelled')
  })

  it('routes to an attached connection when the originator cannot answer', async () => {
    // The chosen connection has to decide the endpoint. Computing candidates and then posting to a
    // fixed endpoint regardless makes the capability filter decoration.
    const origin = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const watcher = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    watcher.conn.capabilities.permission = true
    watcher.conn.attached.set('k', {
      cursor: { fromSeq: 0, generation: 1 },
      filter: { preview: false, acpUpdates: true },
    })
    const log: AskOutcome[] = []
    const r = new PrompterRouter({
      endpointFor: (c) => (c === watcher.conn ? watcher : origin),
      connections: () => [origin.conn, watcher.conn],
      originOf: () => origin.conn,
      clock: () => 0,
      record: (x) => log.push(x),
    })
    const it = watcher.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    expect(origin.pending().events).toBe(0)
    await watcher.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toBe('allowed-once')
  })

  it('an explicit rejection is the user rejecting, and never the policy fallback', async () => {
    const { ep, r } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    })
    await expect(p).resolves.toEqual({ verdict: 'rejected', reason: 'user_rejected' })
  })

  it('askVerdict gives the bare verdict to callers that only need a yes or a no', async () => {
    const { ep, r } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.askVerdict(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    })
    await expect(p).resolves.toBe('rejected')
  })

  it.each(['allow_permanent', 'reject_always'])(
    'never accepts unoffered option %s from the three-choice ACP bridge',
    async (optionId) => {
      const { ep, r, log } = mk()
      ep.conn.capabilities.permission = true
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = r.ask({ ...req, options: ['allowed-permanent'] } as never, { signal: never })
      const m = (await it.next()).value as { id: string; params: { options: Array<{ kind: string }> } }
      expect(m.params.options.map((option) => option.kind)).toEqual([
        'allow_once',
        'allow_always',
        'reject_once',
      ])
      await ep.handle({
        jsonrpc: '2.0',
        id: m.id,
        result: { outcome: { outcome: 'selected', optionId } },
      })
      await expect(p).resolves.toBe('rejected')
      expect(log.at(-1)?.via).toBe('malformed')
    },
  )

  it('a cancelled outcome is a cancellation the client chose', async () => {
    const { ep, r, log } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    await ep.handle({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } })
    await expect(p).resolves.toBe('cancelled')
    expect(log.at(-1)).toEqual({ requestId: 'r1', via: 'answered', verdict: 'cancelled' })
  })

  it.each([
    ['timeout', undefined, 'timeout', { verdict: 'rejected', reason: 'timeout' }],
    [
      'a JSON-RPC error from the client',
      { code: -32603, message: 'boom', data: { code: 'INTERNAL' } },
      'transport',
      'rejected',
    ],
    ['an outcome shape nobody defined', { outcome: { outcome: 'shrug' } }, 'malformed', 'rejected'],
  ] as const)('%s fails closed to rejected, recorded as its own cause', async (_n, answer, via, expected) => {
    const { ep, r, log } = mk({ clock: () => 59_990 }) // deadline is 60_000 ⇒ 10 ms to answer
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    if (answer && 'code' in answer) await ep.handle({ jsonrpc: '2.0', id: m.id, error: answer })
    else if (answer) await ep.handle({ jsonrpc: '2.0', id: m.id, result: answer })
    await expect(p).resolves.toEqual(expected)
    expect(log.at(-1)).toEqual({ requestId: 'r1', via, verdict: 'rejected' })
  })

  it("the caller's own abort is a cancellation, not an outage", async () => {
    const { ep, r, log } = mk()
    ep.conn.capabilities.permission = true
    const ac = new AbortController()
    const p = r.ask(req as never, { signal: ac.signal })
    ac.abort()
    await expect(p).resolves.toEqual({ verdict: 'cancelled', reason: 'stopped' })
    expect(log.at(-1)).toMatchObject({ via: 'aborted', verdict: 'cancelled' })
  })

  const attach = (ep: LocalEndpoint) => {
    ep.conn.capabilities.permission = true
    ep.conn.attached.set('k', {
      cursor: { fromSeq: 0, generation: 1 },
      filter: { preview: false, acpUpdates: true },
    })
  }

  it('asks the same approval again when the browser connection closes', async () => {
    const origin = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    origin.conn.capabilities.permission = true
    const next = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    attach(next)
    let live = [origin]
    const log: AskOutcome[] = []
    const r = new PrompterRouter({
      endpointFor: (c) => {
        const found = live.find((ep) => ep.conn === c)
        if (!found) throw new Error('endpointFor: connection not found among live connections')
        return found
      },
      connections: () => live.map((ep) => ep.conn),
      originOf: () => origin.conn,
      clock: () => 0,
      record: (x) => log.push(x),
    })
    const first = origin.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    await first.next()
    await origin.close()
    live = [next]
    const it = next.notifications[Symbol.asyncIterator]()
    const m = (await it.next()).value as {
      id: string
      params: { _meta: { 'ai.agnes.harness': { requestId: string } } }
    }
    expect(m.params._meta['ai.agnes.harness'].requestId).toBe('r1')
    expect(origin.pending().events).toBe(0)
    await next.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toBe('allowed-once')
    expect(log).toEqual([{ requestId: 'r1', via: 'answered', verdict: 'allowed-once' }])
  })

  it('asks the next attached client when the origin endpoint is already gone', async () => {
    const origin = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    origin.conn.capabilities.permission = true
    const next = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    attach(next)
    const log: AskOutcome[] = []
    const r = new PrompterRouter({
      endpointFor: (c) => {
        if (c === next.conn) return next
        throw new Error('endpointFor: connection not found among live connections')
      },
      connections: () => [origin.conn, next.conn],
      originOf: () => origin.conn,
      clock: () => 0,
      record: (x) => log.push(x),
    })
    const it = next.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as {
      id: string
      params: { _meta: { 'ai.agnes.harness': { requestId: string } } }
    }
    expect(m.params._meta['ai.agnes.harness'].requestId).toBe('r1')
    expect(origin.pending().events).toBe(0)
    await next.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toBe('allowed-once')
    expect(log).toEqual([{ requestId: 'r1', via: 'answered', verdict: 'allowed-once' }])
  })

  it('waits out the deadline when a refresh leaves nobody to ask', async () => {
    const ep = new LocalEndpoint({ clock: () => Date.now(), principalId: 'local' })
    ep.conn.capabilities.permission = true
    const log: AskOutcome[] = []
    const r = new PrompterRouter({
      endpointFor: () => ep,
      connections: () => [ep.conn],
      originOf: () => ep.conn,
      clock: () => Date.now(),
      record: (x) => log.push(x),
    })
    const it = ep.notifications[Symbol.asyncIterator]()
    const started = Date.now()
    const p = r.ask({ ...req, deadline: new Date(started + 80).toISOString() } as never, { signal: never })
    await it.next()
    await ep.close()
    let settled = false
    const done = p.then(
      (answer) => {
        settled = true
        return answer
      },
      (error: unknown) => {
        settled = true
        throw error
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(settled).toBe(false)
    await expect(done).resolves.toEqual({ verdict: 'rejected', reason: 'timeout' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(log).toEqual([{ requestId: 'r1', via: 'timeout', verdict: 'rejected' }])
  })

  it('cancels a dropped approval when the caller aborts before anyone else answers', async () => {
    const { ep, r, log } = mk()
    ep.conn.capabilities.permission = true
    const ac = new AbortController()
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: ac.signal })
    await it.next()
    await ep.close()
    ac.abort()
    await expect(p).resolves.toEqual({ verdict: 'cancelled', reason: 'stopped' })
    expect(log).toEqual([{ requestId: 'r1', via: 'aborted', verdict: 'cancelled' }])
  })
})
