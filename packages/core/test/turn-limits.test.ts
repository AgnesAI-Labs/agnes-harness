import { presetDefaults } from '@agnes/core-common/step/preset'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { REQUEST_NOTE_CLOSE, REQUEST_NOTE_OPEN } from '../src/request/derive.js'
import { NOTE_LANGUAGE, noteLanguageLine } from '../src/request/note-language.js'
import { turnTimeLimit } from '../src/step/time-limit.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const T0 = 1_757_203_200_000 // 2025-09-07 00:00:00 UTC
const NOTE = /^\[live context [a-f0-9]{64}\]\ncore:turn-limits\n/

type Log = Awaited<ReturnType<typeof openSession>>['log']

/** Every turn-limits note the model was sent, in order, as the ledger recorded it. */
async function limitNotes(log: Log): Promise<string[]> {
  const rows = await log.scan({ type: 'user/message', limit: 1000 })
  return rows
    .map((row) => row.data as { kind?: string; content?: Array<{ text?: string }> })
    .filter((data) => data.kind === 'runtime_context')
    .map((data) => data.content?.[0]?.text ?? '')
    .filter((text) => NOTE.test(text))
    .map((text) => text.replace(NOTE, ''))
}

/** A session whose clock moves by the next delta each time the model calls `read`. */
async function clocked(deltasMs: number[], preset = presetDefaults()) {
  let now = T0
  const deltas = [...deltasMs]
  const registry = new ToolRegistry()
  // The turn's time limit each tool call was handed, as a waiting tool would read it.
  const seen: unknown[] = []
  // The timeout each call was told, which a tool that only honours its own timeout waits up to.
  const timeouts: number[] = []
  registry.add(
    readTool(async (_args, ctx) => {
      seen.push(ctx.turnTimeLimit)
      timeouts.push(ctx.timeoutMs)
      now += deltas.shift() ?? 0
      return { content: [{ type: 'text' as const, text: 'ok' }] }
    }),
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const provider = fakeProvider([
    ...deltasMs.map(() => toolTurn('read', {})),
    textTurn('done'),
    textTurn('next'),
  ])
  const opened = await openSession({ provider, registry, preset, clock: () => now })
  return { ...opened, provider, seen, timeouts }
}

const signal = new AbortController().signal

const TURN_TIME = '[turn time]\n'
/** A measured-time note as the request carries it: framed as harness context, not a user turn. */
const FRAMED = `${REQUEST_NOTE_OPEN}${TURN_TIME}`
/** The prompts below are English ("do it"), so every note names English. */
const ENGLISH = noteLanguageLine('English')

/** Every measured-time note the ledger recorded, in order, without its prefix. */
async function timeNotes(log: Log): Promise<string[]> {
  const rows = await log.scan({ type: 'user/message', limit: 1000 })
  return rows
    .map((row) => row.data as { kind?: string; content?: Array<{ text?: string }> })
    .filter((data) => data.kind === 'runtime_context')
    .map((data) => data.content?.[0]?.text ?? '')
    .filter((text) => text.startsWith(TURN_TIME))
    .map((text) => text.slice(TURN_TIME.length))
}

/** How many Core notes the ledger holds in all: every `runtime_context` message row. */
async function noteRows(log: Log): Promise<number> {
  const rows = await log.scan({ type: 'user/message', limit: 1000 })
  return rows.filter((row) => (row.data as { kind?: string }).kind === 'runtime_context').length
}

const at = (used: string, left: string) =>
  `${used} of this turn's 1m40s time limit used, ${left} left. Measured at this request, it replaces any earlier time figure: do not conclude that the time limit is reached unless this note says so.\n${ENGLISH}`
/** The figures sent at 0, 30, 55, 60, 80, 95 and 97 s into a 100 s limit. */
const MEASURED = [
  at('0s', 'about 1m40s'),
  at('30s', 'about 1m10s'),
  at('50s', 'about 40s'),
  at('1m00s', 'about 40s'),
  at('1m20s', 'about 20s'),
  at('1m30s', 'less than 10s'),
  at('1m30s', 'less than 10s'),
]

type Request = ReturnType<typeof fakeProvider>['requests'][number]
/** The last measured-time note a request carries. */
const lastTime = (request: Request | undefined): string | undefined =>
  (request?.messages ?? [])
    .flatMap((message) => (message.role === 'user' ? message.content : []))
    .flatMap((block) => (block.type === 'text' && block.text.startsWith(FRAMED) ? [block.text] : []))
    .at(-1)
    ?.slice(FRAMED.length, -REQUEST_NOTE_CLOSE.length)

describe('turn limits the model is told about', () => {
  it('states the limits at turn start, then once each at 50%, 75% and 90% of the nearest, as live notes', async () => {
    // Fractions of the 100 s limit at each request: 0, 30, 55, 60, 80, 95, 97 per cent.
    const { session, log, provider } = await clocked([30_000, 25_000, 5_000, 20_000, 15_000, 2_000])
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'do it' }],
      actor,
      timeLimitMs: 100_000,
      maxSteps: 20,
    })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')

    const limits = 'a time limit of 1m40s (until 2025-09-07 00:01:40 UTC); at most 20 model steps'
    expect(await limitNotes(log)).toEqual([
      `Turn limits\nThis turn has limits: ${limits}. When one is reached the turn ends, and what is finished and checked by then is the result. Plan the work to fit, and do the core of the request first.\n${ENGLISH}`,
      `Turn limits\n50% of this turn's time limit is used: about 50s left (until 2025-09-07 00:01:40 UTC). Prioritise the core requirement: if its result is not in place yet, put a working version in place and check it before refining anything.\nLimits for this turn: ${limits}.\n${ENGLISH}`,
      `Turn limits\n75% of this turn's time limit is used: about 25s left (until 2025-09-07 00:01:40 UTC). Finish the core requirement now and verify it; skip optional extras and further exploration.\nLimits for this turn: ${limits}.\n${ENGLISH}`,
      `Turn limits\n90% of this turn's time limit is used: about 10s left (until 2025-09-07 00:01:40 UTC). Wrap up: leave the work in its best checked state and end with a short reply saying what is done, how it was checked and what remains.\nLimits for this turn: ${limits}.\n${ENGLISH}`,
    ])
    // The notes travel at the tail: every request carries the same system prompt.
    expect(provider.requests).toHaveLength(7)
    for (const request of provider.requests) expect(request.system).toBe(provider.requests[0]?.system)
    expect(provider.requests[0]?.system).not.toContain('Turn limits')

    // The next turn has no limit: no new note, and the old one is cleared rather than repeated.
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'and now?' }], actor })
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    const notes = await limitNotes(log)
    expect(notes).toHaveLength(5)
    expect(notes.at(-1)).toBe('Turn limits\nThis context item no longer applies.')
    expect(provider.requests.at(-1)?.system).toBe(provider.requests[0]?.system)
  })

  it('tells every request of a timed turn its measured time, as a request-only note history never keeps', async () => {
    // Seconds into the 100 s limit at each request: 0, 30, 55, 60, 80, 95, 97.
    const { session, log, provider, seen } = await clocked([30_000, 25_000, 5_000, 20_000, 15_000, 2_000])
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'do it' }],
      actor,
      timeLimitMs: 100_000,
    })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    // Every tool call is handed the turn's limit, so a foreground command can stop short of it.
    expect(seen).toEqual(seen.map(() => ({ timeLimitMs: 100_000, deadlineAt: T0 + 100_000 })))
    expect(seen).toHaveLength(6)

    expect(provider.requests.map(lastTime)).toEqual(MEASURED)
    for (const request of provider.requests) {
      // The figure is the request's last message, framed as harness context the user did not
      // write, and the request says it is not history.
      expect(request.messages.at(-1)).toMatchObject({
        role: 'user',
        content: [
          {
            text: expect.stringMatching(
              /^<system-reminder>\nHarness runtime note, not a message from the user\.\n\[turn time\]\n[\s\S]*\nThe user writes in English; keep working and replying in English\.\n<\/system-reminder>$/,
            ),
          },
        ],
      })
      expect(request.requestOnlyMessages).toBe(1)
    }
    // Nothing of it is written: the only notes on the ledger are the threshold notes.
    expect(await timeNotes(log)).toEqual([])
    expect(await noteRows(log)).toBe((await limitNotes(log)).length)
    // Each request's history is the start of the next one's, and the system prompt never changes,
    // so the provider's cached prefix survives every new figure.
    for (const [i, request] of provider.requests.entries()) {
      expect(request.system).toBe(provider.requests[0]?.system)
      const next = provider.requests[i + 1]
      const history = request.messages.slice(0, -1)
      if (next) expect(next.messages.slice(0, history.length)).toEqual(history)
    }

    // A later turn without a time limit carries no figure at all, and nothing needs clearing.
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'and now?' }], actor })
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(JSON.stringify(provider.requests.at(-1))).not.toContain('[turn time]')
    expect(provider.requests.at(-1)?.requestOnlyMessages).toBeUndefined()
    expect(await timeNotes(log)).toEqual([])
  })

  it('tells each tool call no more time than the turn has left, less a small margin', async () => {
    // Calls at 0, 30, 90 and 98 s into a 100 s limit; the preset's own call timeout is 120 s.
    const { session, timeouts } = await clocked([30_000, 60_000, 8_000, 0])
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'do it' }],
      actor,
      timeLimitMs: 100_000,
    })
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    expect(timeouts).toEqual([95_000, 65_000, 5_000, 1_000])
    await session.close()
    const plain = await clocked([0])
    await plain.session.enqueue('next-turn', { content: [{ type: 'text', text: 'do it' }], actor })
    await plain.session.run({ until: 'turn-end', signal })
    // An untimed turn keeps the preset timeout, less the kernel's grace.
    expect(plain.timeouts).toEqual([118_000])
    await plain.session.close()
  })

  it('a long timed turn adds no more history rows than its threshold notes', async () => {
    // Forty requests 10 s apart in a 500 s limit: every figure differs, and it reaches 80%.
    const { session, log, provider } = await clocked(Array.from({ length: 39 }, () => 10_000))
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'do it' }],
      actor,
      timeLimitMs: 500_000,
    })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(provider.requests).toHaveLength(40)
    expect(new Set(provider.requests.map(lastTime)).size).toBe(40)
    // The opening note, then 50% and 75%: three rows for forty requests.
    expect(await noteRows(log)).toBe(3)
    expect(await timeNotes(log)).toEqual([])
  })

  it('says the time limit is reached only once the deadline has passed', async () => {
    const { session, provider } = await clocked([120_000])
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'go' }],
      actor,
      timeLimitMs: 100_000,
    })
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    // "go" names no language the script can tell, so the note keeps the wording that names none.
    expect(lastTime(provider.requests[1])).toBe(
      `This turn's 1m40s time limit is reached. End now with a short reply saying what is done, how it was checked and what remains.\n${NOTE_LANGUAGE}`,
    )
  })

  it('counts steps against the step cap and still ends the turn at the cap', async () => {
    const { session, log, provider } = await clocked([0, 0, 0, 0, 0])
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor, maxSteps: 4 })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('max_steps')
    const notes = await limitNotes(log)
    expect(notes).toHaveLength(3)
    expect(notes[0]).toContain('This turn has limits: at most 4 model steps.')
    expect(notes[1]).toContain("50% of this turn's step limit is used: 2 model steps left.")
    expect(notes[2]).toContain("75% of this turn's step limit is used: 1 model step left.")
    // Only a time limit is measured per request.
    expect(JSON.stringify(provider.requests)).not.toContain('[turn time]')
  })

  it('a preset step ceiling alone adds no note, and is reported once the prompt sets a limit of its own', async () => {
    const capped = { ...presetDefaults(), budget: { ...presetDefaults().budget, maxSteps: 10 } }
    const plain = await clocked([60_000], capped)
    await plain.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await plain.session.acceptInput()
    expect((await plain.session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(await limitNotes(plain.log)).toEqual([])
    expect(JSON.stringify(plain.provider.requests)).not.toContain('core:turn-limits')
    expect(JSON.stringify(plain.provider.requests)).not.toContain('[turn time]')
    expect(plain.seen).toEqual([undefined])

    const timed = await clocked([], capped)
    await timed.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'hi' }],
      actor,
      timeLimitMs: 30_000,
    })
    await timed.session.acceptInput()
    await timed.session.run({ until: 'turn-end', signal })
    expect(await limitNotes(timed.log)).toEqual([
      expect.stringContaining(
        'This turn has limits: a time limit of 30s (until 2025-09-07 00:00:30 UTC); at most 10 model steps.',
      ),
    ])
  })

  it('a turn rebuilt after a kill keeps its time limit, measures it correctly and does not repeat a note it already sent', async () => {
    const { session, log, provider } = await clocked([30_000, 25_000, 5_000, 20_000, 15_000, 2_000])
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'do it' }],
      actor,
      timeLimitMs: 100_000,
    })
    await session.acceptInput()
    const readTurn = () => session.turn
    for (let i = 0; i < 100; i++) {
      const out = await session.step()
      if (!session.op()) break
      expect(out.outcome).toBe('running')
      // Simulate the kill at every step boundary: the ledger survives, the in-memory turn does not.
      const op = session.op() as NonNullable<ReturnType<typeof session.op>>
      session.turn = null
      await session.rehydrateTurn(op)
      expect(turnTimeLimit(readTurn())).toEqual({ timeLimitMs: 100_000, deadlineAt: T0 + 100_000 })
    }
    // A rebuilt turn measures against the deadline read back from its own row: every request
    // carries the same figures an unbroken turn sends, and none of them is written.
    expect(provider.requests.map(lastTime)).toEqual(MEASURED)
    expect(await timeNotes(log)).toEqual([])
    const notes = await limitNotes(log)
    expect(notes.map((note) => /^Turn limits\n(\d+%|This turn)/.exec(note)?.[1])).toEqual([
      'This turn',
      '50%',
      '75%',
      '90%',
    ])
  })

  it('refuses a time limit outside 1 ms to one day, or on input that does not open a turn', async () => {
    const { session } = await clocked([])
    for (const timeLimitMs of [0, 1.5, 86_400_001])
      await expect(
        session.enqueue('next-turn', { content: [{ type: 'text', text: 'x' }], actor, timeLimitMs }),
      ).rejects.toThrow(/time limit/)
    await expect(
      session.enqueue('next-step', { content: [{ type: 'text', text: 'x' }], actor, timeLimitMs: 1000 }),
    ).rejects.toThrow(/time limit/)
  })
})
