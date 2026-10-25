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
  registry.add(
    readTool(async () => {
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
  return { ...opened, provider }
}

const signal = new AbortController().signal

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

  it('counts steps against the step cap and still ends the turn at the cap', async () => {
    const { session, log } = await clocked([0, 0, 0, 0, 0])
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor, maxSteps: 4 })
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('max_steps')
    const notes = await limitNotes(log)
    expect(notes).toHaveLength(3)
    expect(notes[0]).toContain('This turn has limits: at most 4 model steps.')
    expect(notes[1]).toContain("50% of this turn's step limit is used: 2 model steps left.")
    expect(notes[2]).toContain("75% of this turn's step limit is used: 1 model step left.")
  })

  it('a preset step ceiling alone adds no note, and is reported once the prompt sets a limit of its own', async () => {
    const capped = { ...presetDefaults(), budget: { ...presetDefaults().budget, maxSteps: 10 } }
    const plain = await clocked([60_000], capped)
    await plain.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await plain.session.acceptInput()
    expect((await plain.session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(await limitNotes(plain.log)).toEqual([])
    expect(JSON.stringify(plain.provider.requests)).not.toContain('core:turn-limits')

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
    const { session, log } = await clocked([30_000, 25_000, 5_000, 20_000, 15_000, 2_000])
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
