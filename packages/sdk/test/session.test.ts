import { META_KEY, rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { memoryJournal } from '../src/journal.js'
import { type SessionNotificationListener, toContentBlocks } from '../src/session.js'
import { fakeEndpoint, flush, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize

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
  it('session.new sends cwd, empty mcpServers, preset + sessionKey in _meta', async () => {
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

    const s = await c.session.new({ cwd: '/w', preset: 'standard', sessionKey: 'agnes:t:a:cli:dm:1' })

    expect(s.id).toBe('agnes:t:a:cli:dm:1')
    expect(got).toEqual({
      cwd: '/w',
      mcpServers: [],
      _meta: { [META_KEY]: { preset: 'standard', sessionKey: 'agnes:t:a:cli:dm:1' } },
    })
  })

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
    expect(got).toStrictEqual({ cwd: '/w', mcpServers: [], _meta: { [META_KEY]: {} } })
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

  it('prompt returns stopReason plus the turnEnd reason seen in _meta, and lastSeq', async () => {
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

    const r = await s.prompt('hello')

    expect(r).toEqual({
      stopReason: 'end_turn',
      reason: 'parked',
      lastSeq: 7,
      credits: { used: 12, source: 'estimated' },
    })
    expect(f.calls.find((x) => x.method === 'session/prompt')?.params).toEqual({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'hello' }],
    })
  })

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

  it('derives reason from stopReason when no turnEnd meta arrived', async () => {
    const f = fakeEndpoint({
      initialize: init,
      'session/new': () => ({ sessionId: 's2' }),
      'session/prompt': () => ({ stopReason: 'cancelled' }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const s = await c.session.new({ cwd: '/w' })
    expect((await s.prompt('x')).reason).toBe('aborted')
  })

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

  it('pulling the prompt signal sends session/cancel without abandoning the request', async () => {
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
      'session/cancel': () => {
        cancelled = true
        release()
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

  it('steer / followUp / compact carry a journal commandId and return seq; cancel is a notification', async () => {
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
    expect(await s.followUp([{ type: 'text', text: 'later' }])).toBe(42)
    expect(await s.compact('keep decisions')).toBe(43)
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
    expect(f.calls.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 's3' } })
  })

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
