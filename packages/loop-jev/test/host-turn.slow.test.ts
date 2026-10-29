import { describe, expect, it } from 'vitest'
import { PICK_LS, PICK_RESPOND } from './helpers/fake-jev.js'
import {
  bootJevLoop,
  costs,
  data,
  jevAnswers,
  jevDataDir,
  ofType,
  rowsOf,
  runTurn,
  sideCosts,
  startJev,
  textReply,
  useLoopback,
  violations,
} from './helpers/host.js'

describe('agnes.jev in a real host with a loopback Jev', () => {
  useLoopback()
  it('lists the workspace without the model, then answers with one inference request', async () => {
    const fake = await startJev(jevAnswers([PICK_LS, PICK_RESPOND]))
    const kit = await bootJevLoop({
      dataDir: await jevDataDir(),
      fake,
      main: [textReply('The workspace has a credentials folder.')],
    })
    try {
      const session = await kit.open('turn')
      expect((await runTurn(session, 'What is in this workspace?')).reason).toBe('completed')
      const rows = await rowsOf(session)
      expect(sideCosts(rows)).toHaveLength(2)
      expect(costs(rows).filter((r) => data(r).purpose === 'inference')).toHaveLength(1)
      const [call] = ofType(rows, 'tool/call')
      expect(data(call)).toMatchObject({ name: 'ls', args: { path: '.' } })
      expect(JSON.stringify(data(ofType(rows, 'tool/result')[0]))).toContain('credentials/')
      const before = rows.filter((r) => r.seq < (call?.seq ?? 0) && r.type === 'assistant/message').at(-1)
      expect(data(before).content).toEqual([])
      // The host adds its own time context; the loop's note is the only other runtime context.
      const notes = ofType(rows, 'user/message')
        .filter((r) => data(r).kind === 'runtime_context')
        .map((r) => JSON.stringify(data(r)))
      expect(notes.filter((t) => !t.includes('[hook context]'))).toEqual([
        expect.stringContaining('[answer request]'),
      ])
      // One model request in this turn; that every request keeps the same tool bytes and extends the
      // previous one is pinned by the kernel test "keeps every request a prefix of the next with the
      // same tool bytes".
      expect(ofType(rows, 'request/header')).toHaveLength(1)
      expect(ofType(rows, 'x/agnes/code/jev.step').map((r) => data(r).route)).toEqual(['direct', 'answer'])
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})
