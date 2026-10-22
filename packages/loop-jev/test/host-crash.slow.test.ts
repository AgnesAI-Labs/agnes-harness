import type { Event } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { PICK_RESPOND } from './helpers/fake-jev.js'
import {
  bootJevLoop,
  continueTurn,
  costs,
  crash,
  data,
  jevAnswers,
  jevDataDir,
  ofType,
  rowsOf,
  runTurn,
  startJev,
  textReply,
  useLoopback,
  violations,
} from './helpers/host.js'

describe('agnes.jev after a crash during a Jev call', () => {
  useLoopback()
  it('treats the interrupted call as spent and arbitrates next', async () => {
    const dataDir = jevDataDir()
    let hang = true
    const answer = jevAnswers([PICK_RESPOND])
    let arrived!: () => void
    const reached = new Promise<void>((r) => {
      arrived = r
    })
    const fake = await startJev((n, seen) => {
      if (hang) {
        arrived()
        return { hang: true }
      }
      return answer(n - 1, seen)
    })
    const first = await bootJevLoop({
      dataDir,
      fake,
      main: [textReply('ok')],
    })
    try {
      const session = await first.open('crash')
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'go' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      void continueTurn(session).catch(() => undefined)
      await reached
      await crash(first, session)
    } catch (error) {
      await first.host.close()
      throw error
    }
    hang = false
    const second = await bootJevLoop({
      dataDir,
      fake,
      main: [textReply('ok')],
    })
    try {
      const reopened = await second.open('crash')
      expect(second.recovered.flatMap((r) => r.actions)).toEqual([
        { effectId: 'side:jev:1:0:d0', action: 'unknown' },
      ])
      expect((await continueTurn(reopened)).reason).toBe('completed')
      const steps = ofType(await rowsOf(reopened), 'x/agnes/code/jev.step').map((r) => data(r))
      expect(steps[0]).toMatchObject({ route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' })
      expect(steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
      expect(fake.seen).toHaveLength(2)
    } finally {
      await second.host.close()
    }
  })
})

/** Repeated verification failure exhausts one automatic repair without asking a person. */
function failingGate() {
  let failures = 2
  return {
    verifier: {
      verify: async (scope: string) =>
        scope === 'turn' && failures-- > 0
          ? { verdict: 'fail', reasons: ['no evidence'] }
          : { verdict: 'pass', reasons: [] },
    },
    repair: { decide: async () => 'park' },
    approval: {
      ask: async () => ({ ticket: 'review', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    },
  } as never
}

type SavedState = { stage: string; endReason?: string; idTurn: number | null }
const lastSaved = (rows: Event[]) =>
  (data(ofType(rows, 'x/core/loop-checkpoint').at(-1)).checkpoint as { state: SavedState }).state

describe('agnes.jev after a restart following exhausted automatic repair', () => {
  useLoopback()
  it('does not replay the blocked turn or request approval, and starts the next turn afresh', async () => {
    const dataDir = jevDataDir()
    const fake = await startJev(jevAnswers([PICK_RESPOND]))
    const seams = failingGate()
    const first = await bootJevLoop({
      dataDir,
      fake,
      main: [textReply('First answer.'), textReply('Repaired answer.')],
      seams,
    })
    try {
      const session = await first.open('gate')
      expect((await runTurn(session, 'Answer with evidence')).reason).toBe('blocked')
      const rows = await rowsOf(session)
      expect(lastSaved(rows)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 1 })
      expect(ofType(rows, 'repair/decision').map((row) => data(row).decision)).toEqual(['repair', 'park'])
      expect(await session.decisions.list()).toEqual([])
      await crash(first, session)
    } catch (error) {
      await first.host.close()
      throw error
    }
    const second = await bootJevLoop({ dataDir, fake, main: [textReply('Second answer.')], seams })
    try {
      const reopened = await second.open('gate')
      const before = await rowsOf(reopened)
      expect((await continueTurn(reopened)).reason).toBe('completed')
      const resumed = await rowsOf(reopened)
      expect(ofType(resumed, 'turn/end')).toEqual(ofType(before, 'turn/end'))
      expect(costs(resumed)).toEqual(costs(before))
      expect(await reopened.decisions.list()).toEqual([])
      expect(fake.seen).toHaveLength(2)
      expect((await runTurn(reopened, 'And now?')).reason).toBe('completed')
      const rows = await rowsOf(reopened)
      expect(fake.seen).toHaveLength(3)
      expect(costs(rows).filter((row) => data(row).purpose === 'inference')).toHaveLength(3)
      expect(ofType(rows, 'assistant/message').map((row) => JSON.stringify(data(row).content))).toEqual([
        expect.stringContaining('First answer.'),
        expect.stringContaining('Repaired answer.'),
        expect.stringContaining('Second answer.'),
      ])
      expect(lastSaved(rows)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 2 })
      expect(violations(rows)).toEqual([])
    } finally {
      await second.host.close()
    }
  })
})
