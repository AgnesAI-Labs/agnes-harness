import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { describe, expect, it, vi } from 'vitest'
import {
  type AskOutcome,
  approvalActor,
  notifyApprovalConnectionAttached,
  PrompterRouter,
  withPermissionContext,
} from '../src/local/prompter.js'

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
const permissionContext = {
  sessionKey: 'k',
  sessionId: 'fixture-backend',
  epoch: 0,
  policy: 'full-access',
  actor,
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
  it('accepts source answers only through the configured bridge verifier', async () => {
    const { ep } = mk()
    ep.conn.authKind = 'local'
    const source = { kind: 'channel', accountId: 'trusted', userId: 'reviewer' }
    await expect(approvalActor(ep.conn, 'k', async () => actor, undefined, source)).rejects.toThrow(
      'unverified',
    )
    const verify = async (_conn: typeof ep.conn, credential: unknown) => {
      if (JSON.stringify(credential) !== JSON.stringify(source)) throw new Error('invalid source')
      return { ...actor, id: 'source-reviewer' }
    }
    await expect(approvalActor(ep.conn, 'k', async () => actor, verify, source)).resolves.toEqual({
      ...actor,
      id: 'source-reviewer',
    })
    await expect(
      approvalActor(ep.conn, 'k', async () => actor, verify, { ...source, userId: 'forged' }),
    ).rejects.toThrow('invalid source')
  })

  it('prefers the local prompter', async () => {
    const { r, log } = mk({ local: { ask: async () => 'allowed-once' }, localActor: async () => actor })
    await expect(r.ask(req as never, { signal: never })).resolves.toEqual({
      verdict: 'allowed-once',
      answeredBy: actor,
    })
    expect(log).toEqual([{ requestId: 'r1', via: 'local', verdict: 'allowed-once', answeredBy: actor }])
  })

  it('refuses a local answer when stop arrives during credential resolution', async () => {
    const controller = new AbortController()
    let resolve!: (value: typeof actor) => void
    let enter!: () => void
    const entered = new Promise<void>((ready) => {
      enter = ready
    })
    const { r, log } = mk({
      local: { ask: async () => 'allowed-once' },
      localActor: () => {
        enter()
        return new Promise((ready) => {
          resolve = ready
        })
      },
    })
    const pending = r.ask(req as never, { signal: controller.signal })
    await entered
    controller.abort('stopped')
    resolve(actor)
    await expect(pending).resolves.toEqual({ verdict: 'cancelled', reason: 'stopped' })
    expect(log).toEqual([{ requestId: 'r1', via: 'aborted', verdict: 'cancelled', reason: 'stopped' }])
  })

  it('only routes to a connection that declared the permission capability, and maps the answer', async () => {
    const { ep, r, log } = mk()
    // Without the capability the router must not send anything at all.
    await expect(r.ask(req as never, { signal: never })).resolves.toEqual({
      verdict: 'unavailable',
      reason: 'no-approver',
    })
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
    await expect(p).resolves.toEqual({ verdict: 'allowed-session', answeredBy: { ...actor, id: 'local' } })
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
    expect(m.params.toolCall._meta).toEqual({
      'ai.agnes.harness': { tool, category: 'permission', purpose: 'tool' },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toEqual({ verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } })
  })

  it('a backend budget quote is a permission of kind other and names no tool', async () => {
    const { ep, r } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const { tool: _tool, ...rest } = req
    const p = r.ask({ ...rest, kind: 'budget' } as never, { signal: never })
    const m = (await it.next()).value as { id: string; params: { toolCall: Record<string, unknown> } }
    expect(m.params.toolCall.kind).toBe('other')
    expect(m.params.toolCall._meta).toEqual({
      'ai.agnes.harness': { category: 'permission', purpose: 'budget' },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'cancelled' }, _meta: { 'ai.agnes.harness': { reason: 'no-handler' } } },
    })
    await expect(p).resolves.toEqual({ verdict: 'unavailable', reason: 'no-handler' })
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
    await expect(p).resolves.toEqual({ verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } })
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
    await expect(p).resolves.toEqual({
      verdict: 'rejected',
      reason: 'user-rejected',
      answeredBy: { ...actor, id: 'local' },
    })
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

  it.each(['allow_always', 'allow_permanent', 'reject_always'])(
    'never accepts unoffered option %s from the three-choice ACP bridge',
    async (optionId) => {
      const { ep, r, log } = mk()
      ep.conn.capabilities.permission = true
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = r.ask({ ...req, options: ['allowed-once', 'rejected'] } as never, { signal: never })
      const m = (await it.next()).value as { id: string; params: { options: Array<{ kind: string }> } }
      expect(m.params.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once'])
      await ep.handle({
        jsonrpc: '2.0',
        id: m.id,
        result: { outcome: { outcome: 'selected', optionId } },
      })
      await expect(p).resolves.toEqual({ verdict: 'unavailable', reason: 'invalid-answer' })
      expect(log.at(-1)?.via).toBe('malformed')
    },
  )

  it('an ACP cancelled response with no-handler is unanswered', async () => {
    const { ep, r, log } = mk()
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    await ep.handle({
      jsonrpc: '2.0',
      id: m.id,
      result: { outcome: { outcome: 'cancelled' }, _meta: { 'ai.agnes.harness': { reason: 'no-handler' } } },
    })
    await expect(p).resolves.toEqual({ verdict: 'unavailable', reason: 'no-handler' })
    expect(log.at(-1)).toEqual({
      requestId: 'r1',
      via: 'malformed',
      verdict: 'unavailable',
      reason: 'no-handler',
    })
  })

  it.each([
    ['timeout', undefined, 'timeout', { verdict: 'unavailable', reason: 'deadline' }],
    [
      'a JSON-RPC error from the client',
      { code: -32603, message: 'boom', data: { code: 'INTERNAL' } },
      'transport',
      { verdict: 'unavailable', reason: 'transport' },
    ],
    [
      'an outcome shape nobody defined',
      { outcome: { outcome: 'shrug' } },
      'malformed',
      { verdict: 'unavailable', reason: 'invalid-answer' },
    ],
  ] as const)('%s stays unanswered, recorded as its own cause', async (_n, answer, via, expected) => {
    const { ep, r, log } = mk({ clock: () => 59_990 }) // deadline is 60_000 ⇒ 10 ms to answer
    ep.conn.capabilities.permission = true
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = r.ask(req as never, { signal: never })
    const m = (await it.next()).value as { id: string }
    if (answer && 'code' in answer) await ep.handle({ jsonrpc: '2.0', id: m.id, error: answer })
    else if (answer) await ep.handle({ jsonrpc: '2.0', id: m.id, result: answer })
    await expect(p).resolves.toEqual(expected)
    expect(log.at(-1)).toEqual({ requestId: 'r1', via, ...expected })
  })

  it("the caller's own abort is a cancellation, not an outage", async () => {
    const { ep, r, log } = mk()
    ep.conn.capabilities.permission = true
    const ac = new AbortController()
    const p = r.ask(req as never, { signal: ac.signal })
    ac.abort()
    await expect(p).resolves.toEqual({ verdict: 'cancelled', reason: 'stopped' })
    expect(log.at(-1)).toMatchObject({ via: 'aborted', verdict: 'cancelled', reason: 'stopped' })
  })

  const attach = (ep: LocalEndpoint) => {
    ep.conn.capabilities.permission = true
    ep.conn.attached.set('k', {
      cursor: { fromSeq: 0, generation: 1 },
      filter: { preview: false, acpUpdates: true },
    })
  }

  it('asks the same approval again when the browser connection closes', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
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
    try {
      const first = origin.notifications[Symbol.asyncIterator]()
      const p = r.ask(req as never, { signal: controller.signal })
      await first.next()
      live = []
      await origin.close()
      // Let the dropped offer settle, without advancing the 20 ms polling timer.
      await vi.advanceTimersByTimeAsync(0)
      const it = next.notifications[Symbol.asyncIterator]()
      let message:
        | { id: string; params: { _meta: { 'ai.agnes.harness': { requestId: string } } } }
        | undefined
      void it.next().then((value) => {
        message = value.value as typeof message
      })
      live = [next]
      notifyApprovalConnectionAttached(next.conn)
      await vi.advanceTimersByTimeAsync(0)
      expect(message?.params._meta['ai.agnes.harness'].requestId).toBe('r1')
      await next.handle({
        jsonrpc: '2.0',
        id: message!.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      })
      await expect(p).resolves.toEqual({ verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } })
      expect(log).toEqual([
        { requestId: 'r1', via: 'answered', verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } },
      ])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.abort('stopped')
      await origin.close()
      await next.close()
      vi.useRealTimers()
    }
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
      connections: () => [next.conn],
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
    await expect(p).resolves.toEqual({ verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } })
    expect(log).toEqual([
      { requestId: 'r1', via: 'answered', verdict: 'allowed-once', answeredBy: { ...actor, id: 'local' } },
    ])
  })

  it('waits out the deadline when a refresh leaves nobody to ask', async () => {
    vi.useFakeTimers()
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    ep.conn.capabilities.permission = true
    const log: AskOutcome[] = []
    const r = new PrompterRouter({
      endpointFor: () => ep,
      connections: () => [ep.conn],
      originOf: () => ep.conn,
      clock: Date.now,
      record: (x) => log.push(x),
    })
    try {
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = r.ask({ ...req, deadline: new Date(Date.now() + 80).toISOString() } as never, {
        signal: never,
      })
      await it.next()
      await ep.close()
      let settled = false
      const done = p.then((answer) => {
        settled = true
        return answer
      })
      await vi.advanceTimersByTimeAsync(79)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(done).resolves.toEqual({ verdict: 'unavailable', reason: 'deadline' })
      expect(log).toEqual([{ requestId: 'r1', via: 'timeout', verdict: 'unavailable', reason: 'deadline' }])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await ep.close()
      vi.useRealTimers()
    }
  })

  it.each(['stopped', 'deadline'] as const)(
    'keeps %s when the caller withdraws a dropped approval',
    async (reason) => {
      const { ep, r, log } = mk()
      ep.conn.capabilities.permission = true
      const ac = new AbortController()
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = r.ask(req as never, { signal: ac.signal })
      await it.next()
      await ep.close()
      ac.abort(reason)
      const answer =
        reason === 'deadline'
          ? { verdict: 'unavailable', reason: 'deadline' }
          : { verdict: 'cancelled', reason: 'stopped' }
      await expect(p).resolves.toEqual(answer)
      expect(log).toEqual([
        { requestId: 'r1', via: reason === 'deadline' ? 'timeout' : 'aborted', ...answer },
      ])
    },
  )
})

it.each([
  'candidate.test',
  'plugin.publish',
  'memory',
  'credential.admin',
  'skills.install',
  'mcp.connect',
  'verifier',
])('auto-allows %s without any local or remote approval offer', async (scope) => {
  const local = { ask: vi.fn(async () => 'rejected' as const) }
  const { r, log, ep } = mk({ local, localActor: async () => actor, connections: () => [] })
  const evidence: unknown[] = []
  const answer = await withPermissionContext(
    permissionContext,
    (value) => evidence.push(value),
    () => r.ask({ ...req, scope }, { signal: never }),
    async () => permissionContext,
  )
  expect(answer).toMatchObject({
    verdict: 'allowed-once',
    reason: 'full-access',
    answeredBy: { role: 'system' },
  })
  expect(local.ask).not.toHaveBeenCalled()
  expect(log).toMatchObject([{ via: 'full-access', reason: 'full-access' }])
  expect(evidence).toMatchObject([
    { scope, bindingHash: 'h', reason: 'full-access', consumption: 'authorized' },
    { scope, bindingHash: 'h', reason: 'full-access', consumption: 'consumed' },
  ])
  await ep.close()
})

it('keeps expiry and cancellation authoritative for automatic permission decisions', async () => {
  for (const state of ['expired', 'cancelled', 'cancelled-during-journal'] as const) {
    const controller = new AbortController()
    if (state === 'cancelled') controller.abort('stopped')
    const { ep, r } = mk({ clock: () => (state === 'expired' ? 60_000 : 0), connections: () => [] })
    const evidence: unknown[] = []
    try {
      const answer = await withPermissionContext(
        permissionContext,
        async (value) => {
          evidence.push(value)
          controller.abort('stopped')
        },
        () => r.ask(req, { signal: controller.signal }),
        async () => permissionContext,
      )
      expect(answer).toEqual(
        state === 'expired'
          ? { verdict: 'unavailable', reason: 'deadline' }
          : { verdict: 'cancelled', reason: 'stopped' },
      )
      expect(evidence).toHaveLength(state === 'cancelled-during-journal' ? 1 : 0)
    } finally {
      await ep.close()
    }
  }
})

it('keeps delegated child human gates out of parent full-access automation', async () => {
  const { r, ep, log } = mk({ connections: () => [] })
  try {
    const evidence: unknown[] = []
    const answer = await withPermissionContext(
      permissionContext,
      (value) => evidence.push(value),
      () =>
        r.ask(
          {
            ...req,
            options: ['allowed-once', 'rejected'],
            delegation: {
              role: '@fixture/app#requirements',
              childSessionKey: 'child',
              parentSessionKey: 'k',
              reason: 'taint',
            },
          },
          { signal: never },
        ),
      async () => permissionContext,
    )
    expect(answer).toEqual({ verdict: 'unavailable', reason: 'no-approver' })
    expect(evidence).toEqual([])
    expect(log).toMatchObject([{ via: 'absent' }])
  } finally {
    await ep.close()
  }
})
