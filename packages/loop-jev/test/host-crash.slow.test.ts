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
    const dataDir = await jevDataDir()
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

/** Reject both the answer and its automatic repair, then allow the next turn. */
function blockingGate() {
  let failures = 2
  return {
    verifier: {
      verify: async (scope: string) =>
        scope === 'turn' && failures-- > 0
          ? { verdict: 'fail', reasons: ['no evidence'] }
          : { verdict: 'pass', reasons: [] },
    },
    repair: { decide: async () => 'park' },
  } as never
}

type SavedState = { stage: string; endReason?: string; idTurn: number | null }
const lastSaved = (rows: Event[]) =>
  (data(ofType(rows, 'x/core/loop-checkpoint').at(-1)).checkpoint as { state: SavedState }).state

describe('agnes.jev after a restart following verifier exhaustion', () => {
  useLoopback()
  it('keeps the blocked turn closed without approval and starts the next turn afresh', async () => {
    const dataDir = await jevDataDir()
    const fake = await startJev(jevAnswers([PICK_RESPOND]))
    const seams = blockingGate()
    const first = await bootJevLoop({ dataDir, fake, main: [textReply('First answer.')], seams })
    let blocked: Event[]
    try {
      const session = await first.open('gate')
      expect((await runTurn(session, 'Answer with evidence')).reason).toBe('blocked')
      blocked = await rowsOf(session)
      expect(await session.decisions.list()).toEqual([])
      expect(ofType(blocked, 'x/core/verifier-recovery').map((r) => data(r).handling)).toEqual([
        'repair',
        'blocked',
      ])
      // The loop asked to complete; Core rejected completion after one automatic repair.
      expect(lastSaved(blocked)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 1 })
      await crash(first, session)
    } catch (error) {
      await first.host.close()
      throw error
    }
    // Each process reads the scripted replies from the start.
    const second = await bootJevLoop({ dataDir, fake, main: [textReply('Second answer.')], seams })
    try {
      const reopened = await second.open('gate')
      // The closed blocked turn must not replay its saved finish or generate a review.
      await continueTurn(reopened)
      const resumed = await rowsOf(reopened)
      expect(resumed.slice(0, blocked.length)).toEqual(blocked)
      expect(resumed.slice(blocked.length).map((r) => r.type)).toEqual(['x/core/loop-checkpoint'])
      expect(lastSaved(resumed)).toMatchObject({ stage: 'idle', idTurn: 1 })
      await continueTurn(reopened)
      expect(await rowsOf(reopened)).toEqual(resumed)
      expect(await reopened.decisions.list()).toEqual([])
      expect(fake.seen).toHaveLength(2)
      // A fresh prompt is a new turn, independent of the rejected answer and its repair.
      expect((await runTurn(reopened, 'And now?')).reason).toBe('completed')
      const rows = await rowsOf(reopened)
      expect(fake.seen).toHaveLength(3)
      expect(costs(rows).filter((r) => data(r).purpose === 'inference')).toHaveLength(3)
      expect(ofType(rows, 'assistant/message').map((r) => JSON.stringify(data(r).content))).toEqual([
        expect.stringContaining('First answer.'),
        expect.stringContaining('First answer.'),
        expect.stringContaining('Second answer.'),
      ])
      expect(lastSaved(rows)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 2 })
      expect(violations(rows)).toEqual([])
    } finally {
      await second.host.close()
    }
  })
})
