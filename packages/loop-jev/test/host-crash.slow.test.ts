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

/** A stop gate that fails the first completed turn and parks it for review. */
function parkingGate() {
  let failures = 1
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

describe('agnes.jev after a restart while the stop gate holds its answer', () => {
  useLoopback()
  it('neither finishes the parked turn again nor asks again, and starts the next turn afresh', async () => {
    const dataDir = await jevDataDir()
    const fake = await startJev(jevAnswers([PICK_RESPOND]))
    const seams = parkingGate()
    const first = await bootJevLoop({ dataDir, fake, main: [textReply('First answer.')], seams })
    let parked: Event[]
    try {
      const session = await first.open('gate')
      expect((await runTurn(session, 'Answer with evidence')).reason).toBe('parked')
      parked = await rowsOf(session)
      // The loop asked to complete; the stop gate turned that into the park.
      expect(lastSaved(parked)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 1 })
      await crash(first, session)
    } catch (error) {
      await first.host.close()
      throw error
    }
    // Each process reads the scripted replies from the start.
    const second = await bootJevLoop({ dataDir, fake, main: [textReply('Second answer.')], seams })
    try {
      const reopened = await second.open('gate')
      // While the review is open, running the session neither steps the loop nor writes a row.
      expect((await continueTurn(reopened)).reason).toBe('parked')
      expect((await rowsOf(reopened)).length).toBe(parked.length)
      const [decision] = await reopened.decisions.list()
      if (!decision) throw new Error('the stop gate did not ask for a review')
      await reopened.decisions.answer(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: 'human-answer',
          response: { option: 'allowed-once', value: null },
        },
        { actor: reopened.d.actor, category: 'human', authorize() {} } as never,
      )
      // Core ends the approved turn itself: the loop does not finish it a second time.
      expect((await continueTurn(reopened)).reason).toBe('completed')
      const approved = (await rowsOf(reopened)).slice(parked.length)
      // Only Core's rows: no loop checkpoint, event or cost, so the loop was not stepped.
      expect(approved.map((r) => r.type)).toEqual([
        'decision/state',
        'turn/start',
        'decision/state',
        'x/core/decision-checkpoint',
        'turn/end',
      ])
      expect(data(approved[1])).toMatchObject({ trigger: 'approval-resume' })
      expect(ofType(approved, 'turn/end').map((r) => data(r).reason)).toEqual(['completed'])
      expect(fake.seen).toHaveLength(1)
      // The next prompt is a new turn: the saved finish of the parked one is not replayed.
      expect((await runTurn(reopened, 'And now?')).reason).toBe('completed')
      const rows = await rowsOf(reopened)
      expect(fake.seen).toHaveLength(2)
      expect(costs(rows).filter((r) => data(r).purpose === 'inference')).toHaveLength(2)
      expect(ofType(rows, 'assistant/message').map((r) => JSON.stringify(data(r).content))).toEqual([
        expect.stringContaining('First answer.'),
        expect.stringContaining('Second answer.'),
      ])
      expect(lastSaved(rows)).toMatchObject({ stage: 'finish', endReason: 'completed', idTurn: 3 })
      expect(violations(rows)).toEqual([])
    } finally {
      await second.host.close()
    }
  })
})
