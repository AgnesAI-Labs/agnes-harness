import { presetDefaults } from '@agnes/core-common/step/preset'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
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
  registry.add(
    readTool(async (_args, ctx) => {
      seen.push(ctx.turnTimeLimit)
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
  return { ...opened, provider, seen }
}

const signal = new AbortController().signal

const TURN_TIME = '[turn time]\n'

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

type Request = ReturnType<typeof fakeProvider>['requests'][number]
/** The last measured-time note a request carries. */
const lastTime = (request: Request | undefined): string | undefined =>
  JSON.stringify(request?.messages ?? [])
    .split(JSON.stringify(TURN_TIME).slice(1, -1))
    .at(-1)
    ?.split('"')[0]

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
      `Turn limits\nThis turn has limits: ${limits}. When one is reached the turn ends, and what is finished and checked by then is the result. Plan the work to fit, and do the core of the request first.`,
      `Turn limits\n50% of this turn's time limit is used: about 50s left (until 2025-09-07 00:01:40 UTC). Prioritise the core requirement: if its result is not in place yet, put a working version in place and check it before refining anything.\nLimits for this turn: ${limits}.`,
      `Turn limits\n75% of this turn's time limit is used: about 25s left (until 2025-09-07 00:01:40 UTC). Finish the core requirement now and verify it; skip optional extras and further exploration.\nLimits for this turn: ${limits}.`,
      `Turn limits\n90% of this turn's time limit is used: about 10s left (until 2025-09-07 00:01:40 UTC). Wrap up: leave the work in its best checked state and end with a short reply saying what is done, how it was checked and what remains.\nLimits for this turn: ${limits}.`,
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

  it('tells every request of a timed turn its measured time, as a short note the cache keeps', async () => {
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

    const at = (used: string, left: string) =>
      `${used} of this turn's 1m40s time limit used, ${left} left. This remaining time is measured at this request and is authoritative: do not conclude that the time limit is reached unless this note says so.`
    const measured = [
      at('0s', 'about 1m40s'),
      at('30s', 'about 1m10s'),
      at('50s', 'about 40s'),
      at('1m00s', 'about 40s'),
      at('1m20s', 'about 20s'),
      at('1m30s', 'less than 10s'),
      at('1m30s', 'less than 10s'),
    ]
    expect(provider.requests.map(lastTime)).toEqual(measured)
    // The last two requests measure the same figure, so the second adds no note of its own.
    expect(await timeNotes(log)).toEqual(measured.slice(0, 6))
    // Kept as history: each request's messages are the start of the next one's, and the system
    // prompt never changes, so the provider's cached prefix survives every new figure.
    for (const [i, request] of provider.requests.entries()) {
      expect(request.system).toBe(provider.requests[0]?.system)
      const next = provider.requests[i + 1]
      if (next) expect(next.messages.slice(0, request.messages.length)).toEqual(request.messages)
    }

    // A later turn without a time limit marks the old figure as no longer current, once.
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'and now?' }], actor })
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect((await timeNotes(log)).slice(6)).toEqual(['(none)'])
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
    expect(lastTime(provider.requests[1])).toBe(
      "This turn's 1m40s time limit is reached. End now with a short reply saying what is done, how it was checked and what remains.",
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

  it('a turn rebuilt after a kill keeps its time limit and does not repeat a note it already sent', async () => {
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
    // A rebuilt turn measures afresh at each request and never writes the same figure twice.
    const times = await timeNotes(log)
    expect(times).toHaveLength(6)
    expect(new Set(times).size).toBe(6)
    expect(lastTime(provider.requests.at(-1))).toContain('less than 10s left')
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
