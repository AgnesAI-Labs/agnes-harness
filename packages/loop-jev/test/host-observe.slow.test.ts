import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('agnes.jev with the platform path references', () => {
  useLoopback()
  it('reads a file that ls listed without asking the conversation model for its path', async () => {
    const dataDir = await jevDataDir()
    writeFileSync(join(dataDir, 'notes.txt'), 'remember the milk\n')
    const fake = await startJev(
      jevAnswers([
        PICK_LS,
        {
          phase: 'INSPECT',
          action__inspect: 'read',
          target__inspect__read: 'notes.txt',
          target_mode__inspect__read: 'one',
        },
        PICK_RESPOND,
      ]),
    )
    const kit = await bootJevLoop({ dataDir, fake, main: [textReply('The note says to remember the milk.')] })
    try {
      const session = await kit.open('observe')
      expect((await runTurn(session, 'What does the note say?')).reason).toBe('completed')
      const rows = await rowsOf(session)
      const calls = ofType(rows, 'tool/call').map((r) => data(r))
      expect(calls.map((c) => [c.name, c.args])).toEqual([
        ['ls', { path: '.' }],
        ['read', { path: 'notes.txt', offset: 1, limit: 200 }],
      ])
      expect(data(ofType(rows, 'tool/result')[0]).structured).toMatchObject({
        schema: 'agh.path-references/1',
      })
      expect(sideCosts(rows)).toHaveLength(3)
      expect(costs(rows).filter((r) => data(r).purpose === 'inference')).toHaveLength(1)
      expect(ofType(rows, 'x/agnes/code/jev.step').map((r) => [data(r).route, data(r).bindingMode])).toEqual([
        ['direct', 'defaults'],
        ['direct', 'observed'],
        ['answer', 'llm_parameters'],
      ])
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
  it('reads three listed files in one direct batch', async () => {
    const dataDir = await jevDataDir()
    const files = ['a.md', 'b.md', 'c.md']
    for (const f of files) writeFileSync(join(dataDir, f), `content of ${f}\n`)
    const fake = await startJev(
      jevAnswers([
        PICK_LS,
        {
          phase: 'INSPECT',
          action__inspect: 'read',
          target_mode__inspect__read: 'many',
          include__inspect__read__0: 'include',
          include__inspect__read__1: 'include',
          include__inspect__read__2: 'include',
          // The session's own database files are listed too, after the three markdown files.
          include__inspect__read__3: 'skip',
          include__inspect__read__4: 'skip',
        },
        PICK_RESPOND,
      ]),
    )
    const kit = await bootJevLoop({ dataDir, fake, main: [textReply('All three files were read.')] })
    try {
      const session = await kit.open('observe-batch')
      expect((await runTurn(session, 'Read the markdown files.')).reason).toBe('completed')
      const rows = await rowsOf(session)
      const calls = ofType(rows, 'tool/call').map((r) => data(r))
      expect(calls.map((c) => c.name)).toEqual(['ls', 'read', 'read', 'read'])
      expect(
        calls
          .slice(1)
          .map((c) => (c.args as { path: string }).path)
          .sort(),
      ).toEqual(files)
      const results = ofType(rows, 'tool/result').map((r) => JSON.stringify(data(r)))
      for (const f of files) expect(results.some((t) => t.includes(`content of ${f}`))).toBe(true)
      expect(sideCosts(rows)).toHaveLength(3)
      expect(costs(rows).filter((r) => data(r).purpose === 'inference')).toHaveLength(1)
      expect(ofType(rows, 'x/agnes/code/jev.step').map((r) => [data(r).route, data(r).bindingMode])).toEqual([
        ['direct', 'defaults'],
        ['direct', 'observed'],
        ['answer', 'llm_parameters'],
      ])
      expect(violations(rows)).toEqual([])
    } finally {
      await kit.host.close()
    }
  })
})
