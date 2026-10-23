import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PICK_RESPOND, PICK_WRITE } from './helpers/fake-jev.js'
import {
  bootJevLoop,
  callReply,
  continueTurn,
  data,
  jevAnswers,
  jevDataDir,
  ofType,
  rowsOf,
  sideCosts,
  startJev,
  textReply,
  useLoopback,
  violations,
} from './helpers/host.js'

const GOAL = 'Create out.txt saying hi'
type JevRequestState = { goal: string; current_turn_notes: unknown }

describe('agnes.jev across an approval park', () => {
  useLoopback()
  it('keeps the goal and notes after the approval continuation and runs the write once', async () => {
    const fake = await startJev(jevAnswers([PICK_WRITE, PICK_RESPOND]))
    const dataDir = await jevDataDir()
    const kit = await bootJevLoop({
      dataDir,
      fake,
      approval: async () => ({ verdict: 'unavailable', reason: 'no-handler' }),
      main: [callReply('write', { path: 'out.txt', content: 'hi' }), textReply('Wrote out.txt.')],
    })
    try {
      const session = await kit.open('approval')
      const actor = session.d.actor
      await session.enqueue('next-turn', { content: [{ type: 'text', text: GOAL }], actor, kind: 'prompt' })
      await session.enqueue('next-step', { content: [{ type: 'text', text: 'Use plain ASCII.' }], actor })
      expect((await continueTurn(session)).reason).toBe('parked')
      const [decision] = await session.decisions.list()
      if (!decision) throw new Error('the write did not ask for approval')
      await session.decisions.answer(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: 'human-answer',
          response: { option: 'allowed-once', value: null },
        },
        { actor, category: 'human', authorize() {} } as never,
      )
      expect((await continueTurn(session)).reason).toBe('completed')
      expect(readFileSync(join(dataDir, 'out.txt'), 'utf8')).toBe('hi')
      const states = fake.seen.map((seen) => (seen.body as { state: JevRequestState }).state)
      expect(states).toHaveLength(2)
      for (const state of states) {
        expect(state.goal).toBe(GOAL)
        expect(JSON.stringify(state.current_turn_notes)).toContain('Use plain ASCII.')
      }
      const rows = await rowsOf(session)
      const writes = ofType(rows, 'tool/result').filter((r) => JSON.stringify(data(r)).includes('out.txt'))
      expect(writes).toHaveLength(1)
      // The continuation runs under a new Core turn, and the loop keeps its own turn and step ids.
      expect(ofType(rows, 'turn/start').map((r) => data(r).trigger)).toEqual(['prompt', 'approval-resume'])
      expect(sideCosts(rows).map((r) => data(r).effectId)).toEqual(['side:jev:1:0:d0', 'side:jev:1:1:d0'])
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})
