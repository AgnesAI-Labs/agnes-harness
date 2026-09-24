import type { LedgerEvent } from '@agnes/sdk'
import { createClient } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { FAKE_SESSION_ID, FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

const clientFor = (ep: FakeEndpoint) => createClient({ transport: { kind: 'inproc', endpoint: ep } })

describe('the fake endpoint drives a real sdk client', () => {
  it('runs a whole one-shot exchange and reports the turn reason from the ledger', async () => {
    const ep = scriptedEndpoint({ reply: 'forty two' })
    const client = clientFor(ep)
    const session = await client.session.new({ cwd: '/w' })
    expect(session.id).toBe(FAKE_SESSION_ID)

    const seen: LedgerEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) {
        seen.push(e)
        if (e.type === 'turn/end') break
      }
    })()
    const result = await session.prompt('what is six times seven')
    await reading

    expect(result.reason).toBe('completed')
    expect(result.stopReason).toBe('end_turn')
    expect(seen.map((e) => e.type)).toEqual(['turn/start', 'assistant/message', 'turn/end'])
    const text = seen.find((e) => e.type === 'assistant/message')?.data as {
      content: Array<{ text: string }>
    }
    expect(text.content[0]?.text).toBe('forty two')
    // Observed, not assumed: events() attaches lazily, from inside the first next(), so a prompt
    // issued in the same tick reaches the endpoint before the attach does. The endpoint has to
    // tolerate that ordering, and so does anything built on it.
    expect(ep.calls.map((c) => c.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
      '_agnes/v1/session.attach',
    ])
    await client.close()
  })

  // The reason must come off the ledger row, not off the ACP stop reason: the fake always answers
  // end_turn, which maps to 'completed', so a client reading the wrong one cannot tell these apart.
  it('a parked turn is reported as parked even though the ACP stop reason still says end_turn', async () => {
    const ep = scriptedEndpoint({ reason: 'parked' })
    const client = clientFor(ep)
    const session = await client.session.new({ cwd: '/w' })
    await session.attach()
    const result = await session.prompt('do something risky')
    expect(result.stopReason).toBe('end_turn')
    expect(result.reason).toBe('parked')
    await client.close()
  })

  it('an unregistered method answers METHOD_NOT_FOUND rather than hanging', async () => {
    const ep = scriptedEndpoint()
    const client = clientFor(ep)
    await expect(
      client.call('session/set_mode', { sessionId: FAKE_SESSION_ID, modeId: 'x' }),
    ).rejects.toThrow(/METHOD_NOT_FOUND/)
    await client.close()
  })

  // Both shapes reach the same listener. A consumer that assumed one payload shape -- say, always
  // reading `.kind` -- would read undefined for the daemon's own notices.
  it('notice carries two unrelated payload shapes, told apart by kind', async () => {
    const ep = scriptedEndpoint()
    const client = clientFor(ep)
    const notices: unknown[] = []
    client.on('notice', (p) => notices.push(p))
    const session = await client.session.new({ cwd: '/w' })
    await session.attach()

    ep.pushNotice({ level: 'warn', code: 'daemon.busy', message: 'queue is deep' })
    // A row the ledger schema rejects: origin is not one of the permitted forms.
    ep.pushEvent(
      FAKE_SESSION_ID,
      {
        seq: 9,
        ts: new Date(0).toISOString(),
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0999',
        type: 'turn/start',
        data: {},
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'not a legal origin',
        trust: 'trusted',
      },
      { promptTurnId: '1', eventSequence: 9, generation: 1, lane: 'main', phase: 'event' },
    )
    await new Promise((r) => setTimeout(r, 5))

    const kinds = notices.map((n) => (n as { kind?: string }).kind)
    expect(kinds).toEqual([undefined, 'invalid-event'])
    expect(notices[0]).toMatchObject({ code: 'daemon.busy' })
    expect(notices[1]).toMatchObject({ kind: 'invalid-event', sessionId: FAKE_SESSION_ID, seq: 9 })
    await client.close()
  })

  it('close ends the notification stream instead of delivering one more frame', async () => {
    const ep = new FakeEndpoint()
    const it = ep.notifications[Symbol.asyncIterator]()
    const pending = it.next()
    await ep.close()
    expect(await pending).toEqual({ done: true, value: undefined })
    ep.push({ jsonrpc: '2.0', method: 'too/late' })
    expect(await it.next()).toEqual({ done: true, value: undefined })
  })

  // The default ordering, and only the default: the queue wakes a parked reader by resolving its
  // promise, and those microtasks are queued ahead of the one the transport uses to deliver the
  // reply, so a row pushed before the handler returns is already with the client. Asserted on the
  // session's own position rather than on an iterator, so it holds whatever a reader is doing.
  // `rowsAfterReply` below is the other ordering, which a real endpoint can also produce.
  it('rows pushed before the reply arrive before it', async () => {
    const ep = scriptedEndpoint()
    const client = clientFor(ep)
    const session = await client.session.new({ cwd: '/w' })
    await session.attach()
    expect(session.lastSeq).toBe(0)
    await session.prompt('anything')
    expect(session.lastSeq).toBe(3)
    await client.close()
  })

  // What a resume has to cope with: the attach answers with a position, and the transcript arrives
  // afterwards. A reader that started after the attach still gets all of it, which is why runPrint
  // skips the prefix by sequence rather than by hoping to have missed it.
  it('an attach replays the history the session already has, and reports it as lastSeq', async () => {
    const ep = scriptedEndpoint({ history: 'yesterday', reply: 'today' })
    const client = clientFor(ep)
    const session = await client.session.load(FAKE_SESSION_ID)
    const seen: LedgerEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await new Promise((r) => setTimeout(r, 5))
    expect(session.lastServerSeq).toBe(3)
    await client.close()
    await reading
    const texts = seen
      .filter((e) => e.type === 'assistant/message')
      .map((e) => (e.data as { content: Array<{ text: string }> }).content[0]?.text)
    expect(texts).toEqual(['yesterday'])
    expect(seen.every((e) => e.seq <= 3)).toBe(true)
  })

  it('a reader that subscribes after the attach still receives the replay', async () => {
    const ep = scriptedEndpoint({ history: 'yesterday' })
    const client = clientFor(ep)
    const session = await client.session.load(FAKE_SESSION_ID)
    await session.attach()
    expect(session.lastServerSeq).toBe(3)
    const seen: LedgerEvent[] = []
    const reading = (async () => {
      for await (const e of session.events()) seen.push(e)
    })()
    await new Promise((r) => setTimeout(r, 5))
    await client.close()
    await reading
    expect(seen.map((e) => e.type)).toEqual(['turn/start', 'assistant/message', 'turn/end'])
  })

  // The ordering the default one is not. Nothing about the wire guarantees a terminal row beats the
  // reply -- daemon's own wait for quiescence is bounded -- and under this one sdk answers with no
  // turn/end in hand and falls back to the ACP stop reason, which calls every outcome `end_turn`.
  it('rows pushed after the reply arrive after it, and the reply carries no turn outcome', async () => {
    const ep = scriptedEndpoint({ reason: 'blocked', rowsAfterReply: true })
    const client = clientFor(ep)
    const session = await client.session.new({ cwd: '/w' })
    await session.attach()
    const r = await session.prompt('anything')
    expect(session.lastSeq).toBe(0)
    // The wrong answer, arrived at honestly: there was nothing else to read yet.
    expect(r.reason).toBe('completed')
    await new Promise((res) => setTimeout(res, 5))
    expect(session.lastSeq).toBe(3)
    await client.close()
  })
})
