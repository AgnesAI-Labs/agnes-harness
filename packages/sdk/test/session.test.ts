import { META_KEY, rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { memoryJournal } from '../src/journal.js'
import { type SessionNotificationListener, toContentBlocks } from '../src/session.js'
import { fakeEndpoint, flush, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize

it.each([true, false])(
  'negotiates admission-only opening (supported=%s) and remembers it for restoration',
  async (supported) => {
    const f = fakeEndpoint({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { _meta: { [META_KEY]: { sessionOpen: supported } } },
      }),
      'session/load': () => ({}),
      '_agnes/v1/session.open': () => ({}),
    })
    const client = createClient({
      sessionRestoreHistory: 'none',
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    try {
      await client.session.open('web', { cwd: '/workspace' })
      await client.restoreSession('web', '/workspace')
      const loads = f.calls.filter((call) => call.method !== 'initialize')
      expect(loads.map((call) => call.method)).toEqual(
        Array(2).fill(supported ? '_agnes/v1/session.open' : 'session/load'),
      )
      if (supported) {
        expect(loads[0]?.params).toMatchObject({
          sessionId: 'web',
          cwd: '/workspace',
          requestId: expect.any(String),
        })
        expect(loads[0]?.params).not.toEqual(loads[1]?.params)
      }
      await client.session.load('web')
      await client.restoreSession('web', '/workspace')
      expect(f.calls.at(-1)?.method).toBe('session/load')
    } finally {
      await client.close()
    }
  },
)

it('never falls back after admission refusal and cancels just the caller-owned open', async () => {
  let release!: () => void
  const f = fakeEndpoint({
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { _meta: { [META_KEY]: { sessionOpen: true } } },
    }),
    '_agnes/v1/session.open': (params) => {
      if ((params as { sessionId: string }).sessionId === 'refused') throw rpcError('CAPABILITY_DENIED')
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  try {
    await expect(client.session.open('refused')).rejects.toMatchObject({ code: -32006 })
    const controller = new AbortController()
    const pending = client.session.open('pending', { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow()
    await flush()
    controller.abort(new Error('selection changed'))
    await rejected
    const opening = f.calls.find(
      (call) =>
        call.method === '_agnes/v1/session.open' &&
        (call.params as { sessionId: string }).sessionId === 'pending',
    )
    expect(f.calls).toContainEqual({
      method: '_agnes/v1/session.loadingCancel',
      params: {
        sessionId: 'pending',
        requestId: (opening?.params as { requestId?: string } | undefined)?.requestId,
      },
    })
    expect(f.calls.some((call) => call.method === 'session/load')).toBe(false)
    release()
  } finally {
    await client.close()
  }
})

it.each(['open', 'new', 'fork'] as const)(
  'reconnect restoration of a Web %s handle never asks for ACP replay',
  async (creation) => {
    let attaches = 0
    const f = fakeEndpoint({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { _meta: { [META_KEY]: { sessionOpen: true } } },
      }),
      '_agnes/v1/session.open': () => ({}),
      'session/new': () => ({ sessionId: 'web' }),
      '_agnes/v1/submit': () => ({ replayed: false, result: { sessionId: 'web' } }),
      '_agnes/v1/submit.ack': () => ({}),
      '_agnes/v1/session.attach': () => {
        if (++attaches === 2) throw rpcError('SESSION_NOT_FOUND', { sessionId: 'web' })
        return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
      },
    })
    const client = createClient({
      sessionRestoreHistory: 'none',
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    try {
      const session =
        creation === 'new'
          ? await client.session.new({ cwd: '/workspace' })
          : creation === 'fork'
            ? await client.session.fork('parent', 1, { cwd: '/workspace' })
            : await client.session.open('web', { cwd: '/workspace' })
      await session.attach()
      await session.recover()
      expect(f.calls.filter((call) => call.method === '_agnes/v1/session.open')).toHaveLength(
        creation === 'open' ? 2 : 1,
      )
      expect(f.calls.some((call) => call.method === 'session/load')).toBe(false)
    } finally {
      await client.close()
    }
  },
)

it('cancels an opening during a shared handshake without cancelling initialization for the next selection', async () => {
  let finish!: (value: unknown) => void
  const f = fakeEndpoint({
    initialize: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    'session/load': () => ({}),
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  try {
    const controller = new AbortController()
    const opening = client.session.open('cancelled', { signal: controller.signal })
    const rejected = expect(opening).rejects.toThrow('switched before initialization')
    await flush()
    controller.abort(new Error('switched before initialization'))
    await rejected
    finish({ protocolVersion: 1, agentCapabilities: {} })
    await client.initialize()
    await client.session.open('next')
    expect(f.calls.filter((call) => call.method === 'session/load').map((call) => call.params)).toEqual([
      { sessionId: 'next', cwd: '', mcpServers: [] },
    ])
  } finally {
    await client.close()
  }
})

const meta = (seq: number, phase: string, extra: Record<string, unknown> = {}) => ({
  [META_KEY]: { promptTurnId: '1', eventSequence: seq, generation: 1, lane: 'main', phase, ...extra },
})

const update = (sessionId: string, _meta: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  method: 'session/update',
  params: {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    _meta,
  },
})

describe('toContentBlocks', () => {
  it('wraps a string and passes blocks through untouched', () => {
    expect(toContentBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }])
    const blocks = [{ type: 'text' as const, text: 'a' }]
    expect(toContentBlocks(blocks)).toBe(blocks)
  })
})

describe('Session', () => {
  it('undoes a turn with a stable commandId and previews without one', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's' }),
      '_agnes/v1/session.undo.preview': (params: unknown) => {
        seen.push({ method: 'preview', params: params as Record<string, unknown> })
        return {
          sessionId: 's',
          busy: false,
          undoable: false,
          blockedBy: 'none',
          laterTurns: [],
          shellChanges: false,
          files: [],
        }
      },
      '_agnes/v1/session.undo': (params: unknown) => {
        seen.push({ method: 'undo', params: params as Record<string, unknown> })
        return { sessionId: 's', turn: 2, seq: 9, restored: ['a.txt'], failed: [], conflicts: [] }
      },
    })
    const c = createClient({ transport: { kind: 'inproc', endpoint: f.endpoint }, authProviders: providers })
    const s = await c.session.new({ cwd: '/w' })
    await s.undoPreview(2)
    await s.undo(2, { commandId: 'retry-1' })
    await s.undo(2, { commandId: 'retry-1' })
    await s.undo(2)
    expect(seen[0]).toEqual({ method: 'preview', params: { sessionId: 's', turn: 2 } })
    expect(seen.slice(1, 3).map((call) => call.params)).toEqual([
      { sessionId: 's', turn: 2, commandId: 'retry-1' },
      { sessionId: 's', turn: 2, commandId: 'retry-1' },
    ])
    expect(seen[3]?.params.commandId).toEqual(expect.any(String))
    expect(seen[3]?.params.commandId).not.toBe('retry-1')
    await c.close()
  })

  it.each([
    ['controls', '_agnes/v1/session.controls', { controls: {}, paused: false, pending: [] }],
    [
      'projectUI',
      '_agnes/v1/session.projectUI',
      { sessionId: 's', generation: 1, upto: 0, opState: null, nodes: [], turns: [] },
    ],
    ['uiRead', '_agnes/v1/ui.read', { sessionId: 's', lastSeq: 0, surfaces: [], actions: [] }],
    [
      'workspaceChanges',
      '_agnes/v1/session.workspace.changes',
      {
        scope: 'session',
        revision: 'a'.repeat(64),
        observedAt: '2026-10-17T00:00:00Z',
        fromSeq: 0,
        toSeq: 0,
        turn: null,
        truncated: false,
        unrecorded: false,
        files: [],
      },
    ],
  ] as const)(
    'coalesces concurrent %s reads with a fresh follow-up after events',
    async (read, method, result) => {
      const finish: Array<(value: unknown) => void> = []
      const f = fakeEndpoint({
        initialize: init,
        '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
        'session/new': () => ({ sessionId: 's' }),
        [method]: () => new Promise((resolve) => finish.push(resolve)),
      })
      const c = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        authProviders: providers,
      })
      const s = await c.session.new({ cwd: '/w' })
      const detached = [s[read](), s[read]()]
      await flush()
      expect(finish).toHaveLength(2)
      for (const resolve of finish.splice(0)) resolve(result)
      await Promise.all(detached)
      await s.attach()
      const a = s[read](),
        b = s[read]()
      await flush()
      expect(finish).toHaveLength(1)
      // Events during a flight queue a fresh read; a burst shares the same follow-up.
      f.push(update('s', meta(1, 'event')))
      await flush()
      const newer = s[read]()
      f.push(update('s', meta(2, 'event')))
      await flush()
      const newest = s[read]()
      await flush()
      expect(finish).toHaveLength(1)
      finish[0]?.(result)
      const [first, second] = await Promise.all([a, b])
      expect(first).toEqual(result)
      expect(second).toEqual(result)
      expect(first).not.toBe(second)
      await flush()
      expect(finish).toHaveLength(2)
      const updated =
        read === 'controls'
          ? { ...result, paused: true }
          : read === 'projectUI'
            ? { ...result, upto: 2 }
            : read === 'uiRead'
              ? { ...result, lastSeq: 2 }
              : { ...result, toSeq: 2 }
      finish[1]?.(updated)
      const [fresh, latest] = await Promise.all([newer, newest])
      expect(fresh).toEqual(updated)
      expect(latest).toEqual(updated)
      expect(fresh).not.toBe(latest)
      const again = s[read]()
      await flush()
      expect(finish).toHaveLength(3)
      finish[2]?.(result)
      await again
      await c.close()
    },
  )

  it.each(['detach', 'disconnect', 'generation'] as const)(
    'rejects a coalesced read after %s and does not reuse it',
    async (change) => {
      const finish: Array<(value: unknown) => void> = []
      const result = { controls: {}, paused: false, pending: [] }
      const f = fakeEndpoint({
        initialize: init,
        '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
        'session/new': () => ({ sessionId: 's' }),
        '_agnes/v1/session.detach': () => ({}),
        '_agnes/v1/session.controls': () => new Promise((resolve) => finish.push(resolve)),
      })
      const c = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        authProviders: providers,
      })
      const s = await c.session.new({ cwd: '/w' })
      await s.attach()
      const a = s.controls(),
        b = s.controls()
      await flush()
      expect(finish).toHaveLength(1)
      f.push(update('s', meta(1, 'event')))
      await flush()
      const queued = s.controls()
      await flush()
      expect(finish).toHaveLength(1)
      const stale = expect(Promise.all([a, b, queued])).rejects.toThrow()
      if (change === 'detach') await s.detach()
      else if (change === 'disconnect') c.emit('connectionStateChanged', 'reconnecting')
      else f.push(update('s', meta(2, 'event', { generation: 2 })))
      await flush()
      const next = s.controls()
      await flush()
      expect(finish).toHaveLength(2)
      finish[0]?.(result)
      await stale
      // A late obsolete completion cannot evict a new read that is still in flight.
      const joined = s.controls()
      await flush()
      expect(finish).toHaveLength(change === 'detach' ? 3 : 2)
      finish[1]?.(result)
      if (change === 'detach') finish[2]?.(result)
      expect(await next).toEqual(result)
      expect(await joined).toEqual(result)
      await c.close()
    },
  )

  it('keeps read parameters and sessions separate, propagates refusal, and retries after it', async () => {
    let refused = true
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
      'session/load': () => ({}),
      '_agnes/v1/session.controls': () => {
        if (refused) throw rpcError('AUTH_INVALID')
        return { controls: {}, paused: false, pending: [] }
      },
    })
    const c = createClient({ transport: { kind: 'inproc', endpoint: f.endpoint }, authProviders: providers })
    const s = await c.session.load('s'),
      other = await c.session.load('other')
    await s.attach()
    await other.attach()
    const denied = await Promise.allSettled([
      s.controls(),
      s.controls(),
      s.controls({ afterSeq: 1 }),
      other.controls(),
    ])
    expect(denied.every((r) => r.status === 'rejected')).toBe(true)
    expect(f.calls.filter((r) => r.method === '_agnes/v1/session.controls')).toHaveLength(3)
    await expect(s.controls({ afterSeq: 1n } as never)).rejects.toMatchObject({ kind: 'protocol-violation' })
    expect(f.calls.filter((r) => r.method === '_agnes/v1/session.controls')).toHaveLength(3)
    refused = false
    expect(await s.controls()).toEqual({ controls: {}, paused: false, pending: [] })
    expect(f.calls.filter((r) => r.method === '_agnes/v1/session.controls')).toHaveLength(4)
    const valid = s.controls({ afterSeq: 1 })
    // A boxed number serializes like the valid scalar but must not bypass parameter validation.
    await expect(s.controls({ afterSeq: Object(1) } as never)).rejects.toMatchObject({
      kind: 'protocol-violation',
    })
    await valid
    expect(f.calls.filter((r) => r.method === '_agnes/v1/session.controls')).toHaveLength(5)
    await c.close()
  })

  it('reads capabilities through the authenticated tool catalog and supports older servers', async () => {
    let params: unknown
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 'fixture' }),
      '_agnes/v1/session.tools': (input) => {
        params = input
        return { sessionId: 'fixture', tools: [], resources: [] }
      },
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const session = await client.session.new({ cwd: '/synthetic' })
    expect(await session.capabilities()).toBeUndefined()
    expect(params).toMatchObject({ sessionId: 'fixture' })
    await client.close()
  })
  it.each([
    ['standard', undefined],
    ['default', 'default'],
    ['acme-custom', 'read-only'],
  ] as const)(
    'session.new sends explicit recipe %s and permission %s with its session key',
    async (preset, permission) => {
      let got: unknown
      const f = fakeEndpoint({
        initialize: init,
        'session/new': (p) => {
          got = p
          return { sessionId: 'agnes:t:a:cli:dm:1' }
        },
      })
      const c = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        journal: memoryJournal(),
        authProviders: providers,
      })

      const s = await c.session.new({
        cwd: '/w',
        preset,
        ...(permission ? { permission } : {}),
        sessionKey: 'agnes:t:a:cli:dm:1',
      })

      expect(s.id).toBe('agnes:t:a:cli:dm:1')
      expect(got).toEqual({
        cwd: '/w',
        mcpServers: [],
        _meta: {
          [META_KEY]: { preset, permission: permission ?? 'default', sessionKey: 'agnes:t:a:cli:dm:1' },
        },
      })
    },
  )

  it('leaves preset and sessionKey out when the caller gave neither', async () => {
    let got: unknown
    const f = fakeEndpoint({
      initialize: init,
      'session/new': (p) => {
        got = p
        return { sessionId: 's0' }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await c.session.new({ cwd: '/w' })
    // Strict: an explicit `preset: undefined` would compare equal to an absent key,
    // yet it is a real difference on a transport that does not drop undefined values.
    expect(got).toStrictEqual({ cwd: '/w', mcpServers: [], _meta: { [META_KEY]: { permission: 'default' } } })
  })

  it('hands back the same handle for a session id it already knows', async () => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's1' }),
      'session/load': () => ({}),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const created = await c.session.new({ cwd: '/w' })
    expect(await c.session.load('s1')).toBe(created)
  })

  // The vendored request makes both mandatory, and an absent cwd fails validation
  // before the frame leaves, so the empty string is the value being pinned here.
  it('loads by session id alone, treating an explicit empty cwd as the same omission', async () => {
    let got: unknown
    const f = fakeEndpoint({
      initialize: init,
      'session/load': (p) => {
        got = p
        return {}
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    await c.session.load('s1', { cwd: '' })

    expect(got).toEqual({ sessionId: 's1', cwd: '', mcpServers: [] })
    expect(f.calls.some((call) => call.method === '_agnes/v1/workspace.add')).toBe(false)
  })

  // A caller-supplied directory is only a daemon registry lookup hint. Loading does not add it.
  it('passes a working directory on when the caller knows one', async () => {
    let got: unknown
    const f = fakeEndpoint({
      initialize: init,
      'session/load': (p) => {
        got = p
        return {}
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    await c.session.load('s1', { cwd: '/var/work' })

    expect(got).toEqual({ sessionId: 's1', cwd: '/var/work', mcpServers: [] })
    expect(f.calls.some((call) => call.method === '_agnes/v1/workspace.add')).toBe(false)
  })

  it('writes no cursor for a session that never attached', async () => {
    const f = fakeEndpoint({ initialize: init, 'session/load': () => ({}) })
    const j = memoryJournal('cid')
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: j,
      authProviders: providers,
    })
    const s = await c.session.load('s9')

    await s.flushCursor()

    // Generations start at one, so a zero here is not a position that could ever be
    // sent back as a cursor - writing it would only corrupt the next resume.
    expect(await j.cursor('s9')).toBeNull()
  })

  // A listener that unsubscribes another one mid-delivery must not cost that other
  // one the event already in flight.
  it('delivers a notification to every listener that was present when it arrived', async () => {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.attach('sc')

    const seen: string[] = []
    const second: SessionNotificationListener = () => seen.push('second')
    const first: SessionNotificationListener = () => {
      seen.push('first')
      s.listeners.delete(second)
    }
    s.listeners.add(first)
    s.listeners.add(second)

    f.push(update('sc', meta(1, 'event')))
    await flush()

    expect(seen).toEqual(['first', 'second'])
  })

  it('refuses hard-budget prompts on older servers without sending a prompt', async () => {
    const f = fakeEndpoint({ initialize: init, 'session/new': () => ({ sessionId: 'budget' }) })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    try {
      const session = await client.createSession({ cwd: '/synthetic' })
      await expect(session.prompt('bounded', { creditLimit: 1 })).rejects.toThrow(
        'server does not support hard turn budgets',
      )
      for (const creditLimit of [-1, Infinity, NaN])
        await expect(session.prompt('invalid', { creditLimit })).rejects.toThrow('invalid turn credit limit')
      await expect(session.prompt('capped', { maxSteps: 3 })).rejects.toThrow(
        'server does not support turn step caps',
      )
      for (const maxSteps of [0, 1001, 1.5, NaN])
        await expect(session.prompt('invalid', { maxSteps })).rejects.toThrow('invalid turn step cap')
      expect(f.calls.filter((row) => row.method === 'session/prompt')).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('sends both limits on a server that advertises them, and the unattended flag only when asked', async () => {
    const f = fakeEndpoint({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { _meta: { [META_KEY]: { hardTurnBudget: true, turnMaxSteps: true } } },
      }),
      'session/new': () => ({ sessionId: 'caps' }),
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    try {
      const session = await client.createSession({ cwd: '/synthetic' })
      await session.prompt('x', { creditLimit: 2, maxSteps: 3 })
      await session.prompt('y', { unattended: true })
      const prompts = f.calls.filter((x) => x.method === 'session/prompt').map((x) => x.params)
      expect(prompts[0]).toMatchObject({ _meta: { [META_KEY]: { creditLimit: 2, maxSteps: 3 } } })
      expect((prompts[0] as { _meta: Record<string, object> })._meta[META_KEY]).not.toHaveProperty(
        'unattended',
      )
      expect(prompts[1]).toMatchObject({ _meta: { [META_KEY]: { unattended: true } } })
    } finally {
      await client.close()
    }
  })

  it.each([undefined, 'en', 'zh-CN'] as const)(
    'prompt carries title language %s and returns its own turn outcome',
    async (titleLocale) => {
      const f = fakeEndpoint({
        initialize: init,
        'session/new': () => ({ sessionId: 's1' }),
        'session/prompt': async (_p, { push }) => {
          push(update('s1', meta(5, 'event')))
          push(
            update(
              's1',
              meta(7, 'terminalQuiescence', {
                turnEnd: { reason: 'parked' },
                credits: { used: 12, source: 'estimated' },
              }),
            ),
          )
          await new Promise((r) => setTimeout(r, 5))
          return { stopReason: 'end_turn' }
        },
      })
      const c = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        journal: memoryJournal(),
        authProviders: providers,
      })
      const s = await c.session.new({ cwd: '/w' })

      const input =
        titleLocale === 'zh-CN'
          ? [{ type: 'file' as const, name: '资料.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }]
          : 'hello'
      const references = [{ source: 'file', id: 'notes.txt' }]
      const r = await s.prompt(input, { ...(titleLocale ? { titleLocale } : {}), references })

      expect(r).toEqual({
        stopReason: 'end_turn',
        reason: 'parked',
        lastSeq: 7,
        credits: { used: 12, source: 'estimated' },
      })
      expect(f.calls.find((x) => x.method === 'session/prompt')?.params).toEqual({
        sessionId: 's1',
        prompt:
          titleLocale === 'zh-CN'
            ? [
                {
                  type: 'resource',
                  resource: {
                    uri: 'agnes-attachment:%E8%B5%84%E6%96%99.txt',
                    mimeType: 'text/plain',
                    blob: 'aGVsbG8=',
                  },
                },
              ]
            : [{ type: 'text', text: 'hello' }],
        _meta: { 'ai.agnes.harness': { ...(titleLocale ? { titleLocale } : {}), references } },
      })
    },
  )

  it('restores a reclaimed attached session and retries the rejected prompt exactly once', async () => {
    let prompts = 0
    let attaches = 0
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 'reclaimed' }),
      'session/load': () => ({}),
      '_agnes/v1/session.attach': () => ({
        generation: 1,
        lastSeq: attaches++ === 0 ? 7 : 8,
        resolvedProfileHash: null,
      }),
      'session/prompt': async (_p, { push }) => {
        prompts++
        if (prompts === 1) throw rpcError('SESSION_NOT_FOUND', { sessionId: 'reclaimed' })
        push(update('reclaimed', meta(9, 'terminalQuiescence', { turnEnd: { reason: 'completed' } })))
        return { stopReason: 'end_turn' }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/workspace' })
    await s.attach()

    await expect(s.prompt('after idle')).resolves.toMatchObject({
      stopReason: 'end_turn',
      reason: 'completed',
      lastSeq: 9,
    })

    expect(prompts).toBe(2)
    expect(attaches).toBe(2)
    expect(f.calls.map((call) => call.method)).toEqual([
      'initialize',
      'session/new',
      '_agnes/v1/session.attach',
      'session/prompt',
      'session/load',
      '_agnes/v1/session.attach',
      'session/prompt',
    ])
    expect(f.calls.find((call) => call.method === 'session/load')?.params).toEqual({
      sessionId: 'reclaimed',
      cwd: '/workspace',
      mcpServers: [],
    })
  })

  it('does not guess a workspace or loop when a reclaimed session cannot be restored', async () => {
    let prompts = 0
    let loads = 0
    const f = fakeEndpoint({
      initialize: init,
      'session/load': () => {
        loads++
        return {}
      },
      'session/prompt': () => {
        prompts++
        throw rpcError('SESSION_NOT_FOUND', { sessionId: 'unknown-workspace' })
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    // The explicit load itself uses the legacy empty cwd, but that is not enough evidence for an
    // automatic second load after reclamation.
    const s = await c.session.load('unknown-workspace')

    await expect(s.prompt('no guessed cwd')).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND' },
    })
    expect(loads).toBe(1)
    expect(prompts).toBe(1)
  })

  it('bounds idle-worker prompt recovery to one load and one retry', async () => {
    let prompts = 0
    let loads = 0
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 'still-missing' }),
      'session/load': () => {
        loads++
        return {}
      },
      'session/prompt': () => {
        prompts++
        throw rpcError('SESSION_NOT_FOUND', { sessionId: 'still-missing' })
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/workspace' })

    await expect(s.prompt('only once')).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND' },
    })
    expect(loads).toBe(1)
    expect(prompts).toBe(2)
  })

  it('coalesces concurrent recovery after one worker reclamation', async () => {
    let attaches = 0
    let loads = 0
    let releaseLoad!: () => void
    const loadReleased = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 'coalesced' }),
      'session/load': async () => {
        loads++
        await loadReleased
        return {}
      },
      '_agnes/v1/session.attach': () => {
        attaches++
        if (attaches === 2 || attaches === 3) throw rpcError('SESSION_NOT_FOUND', { sessionId: 'coalesced' })
        return { generation: 1, lastSeq: 4, resolvedProfileHash: null }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/workspace' })
    await s.attach()

    const first = s.recover()
    const second = s.recover()
    await flush()
    expect(loads).toBe(1)
    releaseLoad()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(loads).toBe(1)
    expect(attaches).toBe(4)
  })

  it.each([false, true])(
    'derives cancellation without its own terminal notification: %s',
    async (olderEnd) => {
      const f = fakeEndpoint({
        initialize: init,
        'session/new': () => ({ sessionId: 's2' }),
        'session/prompt': async (_p, { push }) => {
          if (olderEnd) {
            push(
              update(
                's2',
                meta(7, 'terminalQuiescence', {
                  turnEnd: { reason: 'completed' },
                  credits: { used: 12, source: 'estimated' },
                }),
              ),
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          return { stopReason: 'cancelled' }
        },
      })
      const c = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        journal: memoryJournal(),
        authProviders: providers,
      })
      const s = await c.session.new({ cwd: '/w' })
      const result = await s.prompt('x')
      expect(result.reason).toBe('aborted')
      expect(result.credits).toBeUndefined()
    },
  )

  // The turnEnd of turn one must not be reported as the outcome of turn two.
  it('does not reuse the previous turn end when the next turn reports none', async () => {
    let turn = 0
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's1' }),
      'session/prompt': async (_p, { push }) => {
        turn++
        if (turn === 1) {
          push(update('s1', meta(4, 'terminalQuiescence', { turnEnd: { reason: 'parked' } })))
          await new Promise((r) => setTimeout(r, 5))
          return { stopReason: 'end_turn' }
        }
        return { stopReason: 'end_turn' }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })

    expect((await s.prompt('one')).reason).toBe('parked')
    expect(await s.prompt('two')).toEqual({ stopReason: 'end_turn', reason: 'completed', lastSeq: 4 })
  })

  it('pulling the prompt signal submits durable cancel without abandoning the request', async () => {
    let cancelled = false
    let release: () => void = () => {}
    const cancelSeen = new Promise<void>((r) => {
      release = r
    })
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's5' }),
      'session/prompt': async () => {
        await cancelSeen
        return { stopReason: 'cancelled' }
      },
      '_agnes/v1/submit': (params) => {
        expect(params).toMatchObject({ kind: 'control', payload: { sessionId: 's5', action: 'cancel' } })
        cancelled = true
        release()
        return { seq: 1, replayed: false }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })

    const ctrl = new AbortController()
    const pending = s.prompt('x', { signal: ctrl.signal })
    await flush()
    ctrl.abort()

    expect(await pending).toMatchObject({ stopReason: 'cancelled', reason: 'aborted' })
    expect(cancelled).toBe(true)
  })

  // The cancel is best effort: a signal pulled after the connection went away must
  // not turn into an unhandled rejection on the way out.
  it('survives an abort whose cancel can no longer be sent', async () => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's5' }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })
    await c.close()

    const ctrl = new AbortController()
    const pending = s.prompt('x', { signal: ctrl.signal })
    ctrl.abort()

    await expect(pending).rejects.toBeDefined()
    await flush()
  })

  it('steer / followUp / compact / sendNow / removeQueued carry journal identities, including durable controls and queue editing', async () => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's3' }),
      '_agnes/v1/submit': (p) => {
        const kind = (p as { kind: string }).kind
        return { seq: kind === 'steer' ? 41 : kind === 'followUp' ? 42 : 43, replayed: false }
      },
      'session/cancel': () => undefined,
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })

    expect(await s.steer('now')).toBe(41)
    expect(
      await s.followUp([{ type: 'text', text: 'later' }], {
        references: [{ source: 'file', id: 'notes.txt' }],
      }),
    ).toBe(42)
    expect(f.calls.filter((x) => x.method === '_agnes/v1/submit')[1]?.params).toMatchObject({
      payload: { references: [{ source: 'file', id: 'notes.txt' }] },
    })
    expect(await s.compact('keep decisions')).toBe(43)
    expect(await s.sendNow('queued-C')).toBe(43)
    expect(await s.removeQueued('queued-D')).toBe(43)
    await s.cancel()

    const steer = f.calls.find((x) => x.method === '_agnes/v1/submit')?.params as {
      commandId: string
      payload: { content: unknown }
    }
    expect(steer.commandId).toBe('cid:s3:1')
    expect(steer.payload.content).toEqual([{ type: 'text', text: 'now' }])
    expect(
      f.calls.find(
        (x) => x.method === '_agnes/v1/submit' && (x.params as { kind?: string }).kind === 'compact',
      )?.params,
    ).toMatchObject({
      clientId: 'cid',
      commandId: 'cid:s3:3',
      kind: 'compact',
      payload: { sessionId: 's3', instructions: 'keep decisions' },
    })
    expect(
      f.calls.find(
        (call) => call.method === '_agnes/v1/submit' && (call.params as { kind?: string }).kind === 'control',
      ),
    ).toMatchObject({
      params: { kind: 'control', commandId: 'cid:s3:6', payload: { sessionId: 's3', action: 'cancel' } },
    })
    expect(await s.pause()).toBe(43)
    expect(await s.resume()).toBe(43)
    expect(await s.interrupt('queued-E')).toBe(43)
    expect(await s.editQueued('queued-F', 'edited')).toBe(43)
    expect(
      f.calls
        .filter((call) => call.method === '_agnes/v1/submit')
        .slice(-4)
        .map((call) => (call.params as { payload: unknown }).payload),
    ).toEqual([
      { sessionId: 's3', action: 'pause' },
      { sessionId: 's3', action: 'resume' },
      { sessionId: 's3', action: 'interrupt', itemId: 'queued-E' },
      { sessionId: 's3', itemId: 'queued-F', content: [{ type: 'text', text: 'edited' }] },
    ])
    expect(await s.stopChild('child-1')).toBe(43)
    expect(await s.continueChild('child-1', 'new instructions')).toBe(43)
    expect(
      f.calls
        .filter((call) => call.method === '_agnes/v1/submit')
        .slice(-2)
        .map((call) => (call.params as { payload: unknown }).payload),
    ).toEqual([
      { sessionId: 's3', action: 'child-stop', childId: 'child-1' },
      { sessionId: 's3', action: 'child-continue', childId: 'child-1', text: 'new instructions' },
    ])
    expect(
      f.calls.find(
        (call) => call.method === '_agnes/v1/submit' && (call.params as { kind?: string }).kind === 'sendNow',
      )?.params,
    ).toMatchObject({
      kind: 'sendNow',
      commandId: 'cid:s3:4',
      payload: { sessionId: 's3', itemId: 'queued-C' },
    })
    expect(
      f.calls.find(
        (call) =>
          call.method === '_agnes/v1/submit' && (call.params as { kind?: string }).kind === 'removeQueued',
      )?.params,
    ).toMatchObject({
      kind: 'removeQueued',
      commandId: 'cid:s3:5',
      payload: { sessionId: 's3', itemId: 'queued-D' },
    })
  })

  it.each(['sendNow', 'removeQueued', 'promoteQueued'] as const)(
    'does not replay a definitive %s refusal when attaching again',
    async (kind) => {
      const f = fakeEndpoint({
        initialize: init,
        'session/new': () => ({ sessionId: 's3' }),
        '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
        '_agnes/v1/submit': () => {
          throw rpcError('SEMANTIC_REJECTED', { code: 'QUEUED_INPUT_GONE' })
        },
      })
      const journal = memoryJournal('cid')
      const client = createClient({
        transport: { kind: 'inproc', endpoint: f.endpoint },
        journal,
        authProviders: providers,
      })
      const session = await client.session.new({ cwd: '/w' })
      await expect(session[kind]('gone')).rejects.toMatchObject({ data: { code: 'QUEUED_INPUT_GONE' } })
      expect(await journal.pending(session.id)).toEqual([])
      await session.attach()
      expect(f.calls.filter((call) => call.method === '_agnes/v1/submit')).toHaveLength(1)
      await client.close()
    },
  )

  it.each([
    [
      { state: 'completed', endSeq: 44 },
      { state: 'completed', endSeq: 44 },
    ],
    [
      { state: 'failed', endSeq: 44 },
      { state: 'failed', endSeq: 44 },
    ],
    [{ state: 'unknown' }, { state: 'unknown' }],
    [undefined, { state: 'unknown' }],
  ])('compactDetailed reads only a valid optional compact Ack field', async (compact, expected) => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 'detailed' }),
      '_agnes/v1/submit': () => ({ seq: 44, replayed: false, ...(compact ? { compact } : {}) }),
    })
    const c = createClient({ transport: { kind: 'inproc', endpoint: f.endpoint }, journal: memoryJournal() })
    const s = await c.session.new({ cwd: '/w' })
    await expect(s.compactDetailed('keep')).resolves.toEqual(expected)
    await expect(s.compact('keep')).resolves.toBe(44)
  })

  it('honours an explicit commandId instead of drawing a fresh one', async () => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's3' }),
      '_agnes/v1/submit': () => ({ seq: 1, replayed: false }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })
    await s.steer('again', { commandId: 'cid:s3:7' })
    const steer = f.calls.find((x) => x.method === '_agnes/v1/submit')?.params as {
      commandId: string
    }
    expect(steer.commandId).toBe('cid:s3:7')
  })

  // Both writes are on the wire at the same time: the steer handler will not answer
  // until the followUp handler has been entered, so a client that serialised them,
  // or that reused one request id, would hang or cross the two answers.
  it('keeps two concurrent writes apart, each with its own commandId', async () => {
    let followUpEntered: () => void = () => {}
    const followUpArrived = new Promise<void>((r) => {
      followUpEntered = r
    })
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's6' }),
      '_agnes/v1/submit': async (p) => {
        if ((p as { kind: string }).kind === 'steer') {
          await followUpArrived
          return { seq: 41, replayed: false }
        }
        followUpEntered()
        return { seq: 42, replayed: false }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })

    const [steerSeq, followUpSeq] = await Promise.all([s.steer('now'), s.followUp('later')])

    expect(steerSeq).toBe(41)
    expect(followUpSeq).toBe(42)
    const ids = f.calls
      .filter((x) => x.method === '_agnes/v1/submit')
      .map((x) => (x.params as { commandId: string }).commandId)
    expect(new Set(ids)).toEqual(new Set(['cid:s6:1', 'cid:s6:2']))
  })

  it('attach uses the journal cursor when present and records generation/lastSeq', async () => {
    let got: unknown
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': (p) => {
        got = p
        return { generation: 3, lastSeq: 99, resolvedProfileHash: null }
      },
    })
    const j = memoryJournal('cid')
    await j.setCursor('s4', { fromSeq: 10, generation: 2 })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: j,
      authProviders: providers,
    })

    const s = await c.session.attach('s4', { filter: { preview: false } })

    expect(got).toEqual({
      sessionId: 's4',
      cursor: { fromSeq: 10, generation: 2 },
      filter: { preview: false, acpUpdates: false },
    })
    expect(s.cursor()).toEqual({ fromSeq: 10, generation: 3 })
  })

  // A first attach has no generation yet, and the wire has no way to say "generation
  // zero", so the cursor key has to be absent rather than zero-filled.
  it('omits the cursor entirely on a first attach', async () => {
    let got: unknown
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': (p) => {
        got = p
        return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })

    const s = await c.session.attach('s7')

    expect(got).toEqual({ sessionId: 's7', filter: { acpUpdates: false } })
    expect(s.cursor()).toEqual({ fromSeq: 0, generation: 1 })
  })

  it('tracks the highest sequence seen and ignores a lower one that follows', async () => {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.attach('s8')

    f.push(update('s8', meta(7, 'event')))
    await flush()
    f.push(update('s8', meta(5, 'event')))
    await flush()

    expect(s.cursor()).toEqual({ fromSeq: 7, generation: 1 })
  })

  // A generation that walked backwards would be persisted as the cursor's own, and the
  // resume that read it back would be refused as stale.
  it('does not let a late row from an older generation walk the generation back', async () => {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const s = await c.session.attach('sg')

    f.push(update('sg', meta(3, 'event', { generation: 2 })))
    await flush()
    expect(s.generation).toBe(2)

    f.push(update('sg', meta(4, 'event', { generation: 1 })))
    await flush()

    expect(s.cursor()).toEqual({ fromSeq: 4, generation: 2 })
  })

  it('records what the server said its own last row was at attach time', async () => {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 2, lastSeq: 41, resolvedProfileHash: null }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })

    const s = await c.session.attach('sl')

    expect(s.lastServerSeq).toBe(41)
  })

  it('routes a notification only to the session it names', async () => {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    const a = await c.session.attach('sa')
    const b = await c.session.attach('sb')

    f.push(update('sa', meta(9, 'event')))
    await flush()

    expect(a.cursor().fromSeq).toBe(9)
    expect(b.cursor().fromSeq).toBe(0)
  })

  it('surfaces a daemon notice on the client rather than on a session', async () => {
    const f = fakeEndpoint({ initialize: init })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    await c.initialize()
    const seen: unknown[] = []
    c.on('notice', (p) => seen.push(p))

    // A notice shaped the way protocol's DaemonNotice now describes one: `kind` is required
    // and closed, and it is the only thing telling a consumer what arrived, since the
    // payload reaches `on('notice')` as `unknown`.
    const notice = { kind: 'shutting_down', detail: { reason: 'restarting' }, at: '2026-09-07T00:00:00Z' }
    f.push({ jsonrpc: '2.0', method: '_agnes/v1/daemon.notice', params: notice })
    await flush()

    expect(seen).toEqual([notice])
  })
})

it('recovers only the overloaded subscription and respects explicit detach', async () => {
  const f = fakeEndpoint({
    initialize: init,
    'session/load': () => ({}),
    '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    '_agnes/v1/session.detach': () => ({}),
  })
  const c = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  const a = await c.session.load('a'),
    b = await c.session.load('b')
  await a.attach()
  await b.attach()
  const drop = () =>
    f.push({
      jsonrpc: '2.0',
      method: '_agnes/v1/daemon.notice',
      params: {
        kind: 'overloaded',
        sessionId: 'a',
        detail: { code: 'OVERLOADED', retryAfterMs: 500 },
        at: new Date().toISOString(),
      },
    })
  drop()
  await vi.waitFor(
    () => expect(f.calls.filter((call) => call.method === '_agnes/v1/session.attach')).toHaveLength(3),
    { timeout: 2000 },
  )
  const calls = f.calls.filter((call) => call.method === '_agnes/v1/session.attach')
  expect(calls[2]?.params).toMatchObject({ sessionId: 'a', cursor: { fromSeq: 0, generation: 1 } })
  drop()
  await flush()
  await a.detach()
  await new Promise((resolve) => setTimeout(resolve, 650))
  expect(f.calls.filter((call) => call.method === '_agnes/v1/session.attach')).toHaveLength(3)
  expect(a.attached).toBe(false)
  expect(b.attached).toBe(true)
  await c.close()
})

it('recovers an overload delivered during the initial attach replay', async () => {
  let attempts = 0
  const f = fakeEndpoint({
    initialize: init,
    'session/load': () => ({}),
    '_agnes/v1/session.attach': (_p, { push }) => {
      if (++attempts === 1)
        push({
          jsonrpc: '2.0',
          method: '_agnes/v1/daemon.notice',
          params: {
            kind: 'overloaded',
            sessionId: 's',
            detail: { code: 'OVERLOADED' },
            at: new Date().toISOString(),
          },
        })
      return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
    },
  })
  const c = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  const s = await c.session.load('s')
  await s.attach()
  await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 2000 })
  expect(s.attached).toBe(true)
  await c.close()
})
