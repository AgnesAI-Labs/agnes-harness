import { presetDefaults } from '@agnes/core-common/step/preset'
import type { VerifierVerdict } from '@agnes/core-effects/effects/seams'
import { describe, expect, it } from 'vitest'
import { progressCheckText } from '../src/execution/turn/progress-check.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { noteLanguageLine } from '../src/request/note-language.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const T0 = 1_757_203_200_000
const PREFIX = '[progress check]\n'
const signal = new AbortController().signal

type Call = { fail?: boolean; newFiles?: number; seconds?: number }
type Log = Awaited<ReturnType<typeof openSession>>['log']

/**
 * A session whose model calls `read` once per step, `calls.length` times, then answers. Each call
 * can fail, record new files the way the official write tool does, or move the clock. `stalledAt`
 * makes the step verifier report repeated writes for that step, as loop-hygiene does.
 */
async function checked(
  calls: Call[],
  opts: { everySteps?: number; stalledAt?: number; presetDefault?: boolean } = {},
) {
  let now = T0
  const script = [...calls]
  const registry = new ToolRegistry()
  const verifierInputs: Array<{ scope: string; history: boolean }> = []
  let stepVerdicts = 0
  const seams = fakeSeams()
  seams.verifier = {
    verify: async (scope, input): Promise<VerifierVerdict> => {
      verifierInputs.push({ scope, history: (input as { history?: unknown }).history !== undefined })
      if (scope !== 'step') return { verdict: 'pass', reasons: [] }
      stepVerdicts++
      return stepVerdicts === opts.stalledAt
        ? { verdict: 'needs_revision', reasons: ['repeated_write:3'] }
        : { verdict: 'pass', reasons: [] }
    },
  }
  let log: Log | undefined
  registry.add(
    readTool(async (_args, ctx) => {
      const call = script.shift() ?? {}
      now += (call.seconds ?? 0) * 1000
      for (let i = 0; i < (call.newFiles ?? 0); i++)
        await log?.append([
          {
            type: 'x/agnes/tools-core/file-change',
            origin: 'system',
            trust: 'trusted',
            actor,
            ignorable: true,
            data: { version: 1, turn: ctx.session.turn ?? 0, path: `f${i}`, existed: false },
          },
        ])
      return call.fail
        ? { content: [{ type: 'text' as const, text: 'failed' }], isError: true }
        : { content: [{ type: 'text' as const, text: 'ok' }] }
    }),
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const provider = fakeProvider([...calls.map(() => toolTurn('read', {})), textTurn('done')])
  // Checks are off by default; every test but the default-off ones turns them on.
  const preset = opts.presetDefault
    ? presetDefaults()
    : { ...presetDefaults(), progressCheck: { everySteps: opts.everySteps ?? 20 } }
  const opened = await openSession({ provider, registry, preset, seams, clock: () => now })
  log = opened.log
  return { ...opened, provider, verifierInputs }
}

/** Every progress check the ledger recorded, in order, without its prefix. */
async function checks(log: Log): Promise<string[]> {
  const rows = await log.scan({ type: 'user/message', limit: 1000 })
  return rows
    .map((row) => (row.data as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '')
    .filter((text) => text.startsWith(PREFIX))
    .map((text) => text.slice(PREFIX.length))
}

/** An English prompt ("do it"), so the checks name English. */
const limited = { content: [{ type: 'text' as const, text: 'do it' }], actor, maxSteps: 40 }
const quiet = (n: number): Call[] => Array.from({ length: n }, () => ({}))

describe('progress checks', () => {
  it.each([
    ['under a prompt limit', limited],
    [
      'unattended',
      {
        content: [{ type: 'text' as const, text: 'go' }],
        actor: { ...actor, attrs: { interaction: 'unattended' } },
      },
    ],
  ])('are off by default: a turn %s gets none', async (_name, input) => {
    expect(presetDefaults().progressCheck).toEqual({ everySteps: 0 })
    // Thirty quiet steps, five failures in a row and nine new files: every trigger would fire.
    const calls: Call[] = [
      ...quiet(25),
      ...Array.from({ length: 5 }, () => ({ fail: true })),
      { newFiles: 9 },
    ]
    const { session, log, provider, verifierInputs } = await checked(calls, {
      presetDefault: true,
      stalledAt: 3,
    })
    await session.enqueue('next-turn', input)
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(provider.requests.length).toBeGreaterThan(30)
    expect(await checks(log)).toEqual([])
    expect(JSON.stringify(provider.requests)).not.toContain('[progress check]')
    // Step verdicts read the step alone, as they do when checks are off.
    expect(verifierInputs.some((v) => v.history)).toBe(false)
  })

  it('once turned on, asks every N model steps in a turn under a prompt limit, as a note before the next action', async () => {
    const { session, log, provider, verifierInputs } = await checked(quiet(9), { everySteps: 4 })
    await session.enqueue('next-turn', limited)
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(await checks(log)).toEqual([
      progressCheckText(1, 1, 5, '4 model steps so far in this turn.', 'English'),
      progressCheckText(2, 1, 10, '4 model steps since the last progress check.', 'English'),
    ])
    expect(await checks(log)).toEqual([
      `Progress check 1 (turn 1, step 5)
4 model steps so far in this turn. Before your next action, answer in three short lines:
1. Done-check: the check that proves this request is done, and whether it passes now.
2. Progress: what changed in that check's result since this turn began.
3. Decision: FINISH (it passes: stop and report), CONTINUE (name the next concrete step) or SWITCH (this approach is not moving the result: name the more direct approach you take instead), and why.
${noteLanguageLine('English')}`,
      expect.stringContaining("what changed in that check's result since the last progress check."),
    ])
    // The check is the request's last message, so it is what the model reads right before it acts.
    const last = (i: number) => JSON.stringify(provider.requests[i]?.messages.at(-1))
    expect(last(4)).toContain('Progress check 1')
    expect(last(9)).toContain('Progress check 2')
    for (const request of provider.requests) expect(request.system).toBe(provider.requests[0]?.system)
    // Step verdicts in such a turn see the turn's recent history.
    expect(verifierInputs.filter((v) => v.scope === 'step').every((v) => v.history)).toBe(true)
  })

  it.each([
    ['unattended', { interaction: 'unattended' }, 2],
    ['interactive', {}, 0],
  ])('fires for an %s turn without limits only when nobody attends it', async (_name, attrs, expected) => {
    const input = { content: [{ type: 'text' as const, text: 'go' }], actor: { ...actor, attrs } }
    const { session, log, provider, verifierInputs } = await checked(quiet(9), { everySteps: 4 })
    await session.enqueue('next-turn', input)
    await session.acceptInput()
    expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    expect(await checks(log)).toHaveLength(expected)
    if (expected === 0) {
      // An ordinary interactive turn is untouched: no note, and step verdicts read the step alone.
      expect(JSON.stringify(provider.requests)).not.toContain('[progress check]')
      expect(verifierInputs.some((v) => v.history)).toBe(false)
    }
  })

  it('asks early after a run of failed tool results', async () => {
    const { session, log } = await checked([
      ...Array.from({ length: 5 }, () => ({ fail: true })),
      ...quiet(3),
    ])
    await session.enqueue('next-turn', limited)
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    expect(await checks(log)).toEqual([
      progressCheckText(1, 1, 6, '5 tool results in a row failed.', 'English'),
    ])
  })

  it('asks early once the model has created many new files, after a few steps', async () => {
    const { session, log } = await checked([{ newFiles: 8 }, ...quiet(5)])
    await session.enqueue('next-turn', limited)
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    // Eight files land in the first step; the check waits for three steps to have passed.
    expect(await checks(log)).toEqual([
      progressCheckText(1, 1, 4, '8 new files were created so far in this turn.', 'English'),
    ])
  })

  it('asks early when a step verdict sees repeated writes', async () => {
    const { session, log } = await checked(quiet(6), { stalledAt: 3 })
    await session.enqueue('next-turn', limited)
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    expect(await checks(log)).toEqual([
      progressCheckText(1, 1, 4, 'The same change was made several times in a row.', 'English'),
    ])
  })

  it('never shares a request with the time-limit wrap-up, and stops asking after it', async () => {
    // A 100 s limit: four quick steps, then a long call that reaches 95% just as a check falls due.
    const calls: Call[] = [...quiet(3), { seconds: 95 }, ...quiet(4)]
    const { session, log, provider } = await checked(calls, { everySteps: 4 })
    await session.enqueue('next-turn', { ...limited, timeLimitMs: 100_000 })
    await session.acceptInput()
    await session.run({ until: 'turn-end', signal })
    expect(await checks(log)).toEqual([])
    expect(JSON.stringify(provider.requests[4]?.messages)).toContain('90% of this turn')
  })

  it('a turn rebuilt after a kill does not send a check it already sent', async () => {
    const { session, log } = await checked(quiet(9), { everySteps: 4 })
    await session.enqueue('next-turn', limited)
    await session.acceptInput()
    for (let i = 0; i < 100; i++) {
      await session.step()
      const op = session.op()
      if (!op) break
      session.turn = null
      await session.rehydrateTurn(op)
    }
    expect((await checks(log)).map((text) => text.split('\n', 1)[0])).toEqual([
      'Progress check 1 (turn 1, step 5)',
      'Progress check 2 (turn 1, step 10)',
    ])
  })
})
