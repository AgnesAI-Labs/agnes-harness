import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tableMarkdown, taskRows } from './recompute.js'
import { buildReport, readRunRecords } from './report.js'
import type { EvalTask, PromptWindow, RunRecord } from './types.js'

const win = (session: number, prompt: number, trapHit: boolean): PromptWindow => ({
  session,
  prompt,
  ran: true,
  trapHit,
  checksPassed: true,
})
const run = (setting: 'on' | 'off', rep: number, hits: boolean[], taskId = 'dir-demo'): RunRecord => ({
  system: 'agh',
  taskId,
  category: 'directory',
  setting,
  rep,
  exit: 'ok',
  windows: hits.map((hit, i) => win(0, i, hit)),
  refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
  harnessLookups: 0,
  compactions: 0,
  usage: { requests: 0, unknown: 0, tokens: 0, costUsd: 0 },
})

describe('recompute', () => {
  it('counts sessions with a real first failure and those where it recurs, per arm', () => {
    const rows = taskRows([
      run('on', 1, [true, false, false]),
      run('on', 2, [false, false, false]),
      run('off', 1, [true, true, false]),
      run('off', 2, [false, true, false]),
    ])
    expect(rows).toEqual([
      {
        taskId: 'dir-demo',
        on: { runs: 2, sessions: 2, firstFailure: 1, recurs: 0 },
        off: { runs: 2, sessions: 2, firstFailure: 2, recurs: 1 },
      },
    ])
    expect(tableMarkdown(rows)).toContain('| dir-demo | 2 | 1 | 0 | 2 | 2 | 1 |')
  })

  it('shows how many runs and tasks the undefined value excludes, per arm', () => {
    const { json, markdown } = buildReport([
      run('on', 1, [true, false, false]),
      run('on', 2, [false, false, false]),
      run('off', 1, [false, false, false]),
      run('off', 2, [false, false, false]),
      run('on', 1, [false, false, false], 'dir-other'),
      run('off', 1, [false, false, false], 'dir-other'),
    ])
    const excluded = (json as { systems: { agh: { repeatErrorDrop: { excluded: unknown } } } }).systems.agh
      .repeatErrorDrop.excluded
    expect(excluded).toEqual({
      on: { runs: 2, tasks: 1, of: 3 },
      off: { runs: 3, tasks: 2, of: 3 },
    })
    expect(markdown).toContain('on 2 of 3 runs, 1 tasks left without a value; off 3 of 3 runs, 2 tasks left')
  })

  it('reads a run folder without writing into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsi-recompute-'))
    try {
      const task: EvalTask = {
        id: 'dir-demo',
        category: 'directory',
        description: 'd',
        trap: { signatures: ['boom'], reproduce: 'x', note: 'n' },
        sessions: [{ prompts: [{ text: 'go', checks: [], solution: [] }] }],
      }
      const runDir = join(dir, 'dir-demo.on.r1')
      mkdirSync(join(runDir, 'sessions'), { recursive: true })
      const rows = [
        {
          seq: 1,
          type: 'user/message',
          lane: 'main',
          origin: 'user',
          data: { content: [{ type: 'text', text: 'go' }] },
        },
        {
          seq: 2,
          type: 'tool/call',
          lane: 'main',
          origin: 'model',
          data: { toolUseId: 'a', name: 'shell', args: { command: './x' } },
        },
        {
          seq: 3,
          type: 'tool/result',
          lane: 'main',
          origin: 'tool:shell',
          data: {
            toolUseId: 'a',
            isError: true,
            content: [{ type: 'text', text: '[stderr]\nboom\n\n[exit 2]' }],
          },
        },
      ]
      writeFileSync(
        join(runDir, 'sessions', 's1.events.jsonl'),
        rows.map((r) => JSON.stringify(r)).join('\n'),
      )
      writeFileSync(
        join(runDir, 'outcome.json'),
        JSON.stringify({
          runId: 'dir-demo.on.r1',
          system: 'agh',
          // a path from another machine: found by name under the run's own sessions folder
          sessions: [
            {
              exitCode: 0,
              timedOut: false,
              stdoutFile: 'x',
              sessionFiles: ['/elsewhere/sessions/s1.events.jsonl'],
            },
          ],
          checks: [],
        }),
      )
      const before = readdirSync(runDir).sort()
      const records = readRunRecords(dir, new Map([[task.id, task]]))
      expect(records[0]?.windows[0]?.trapHit).toBe(true)
      expect(readdirSync(runDir).sort()).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
