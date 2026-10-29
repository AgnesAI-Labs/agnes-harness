import type { UINode, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { TuiTheme } from '../src/theme.js'
import { PlanPanel } from '../src/views/plan-panel.js'

type S = 'pending' | 'in_progress' | 'completed'
const ansi = new TuiTheme('mono').ansi(createAnsi('none'))
const call = (id: string, steps: Array<[string, S]>, argsPreview?: string): UINode => ({
  kind: 'tool',
  id,
  seq: 1,
  toolUseId: id,
  name: 'update_plan',
  status: 'completed',
  summary: '',
  argsPreview: argsPreview ?? JSON.stringify({ plan: steps.map(([step, status]) => ({ step, status })) }),
})
const tl = (nodes: UINode[], running = false, sessionId = 's'): UITimeline =>
  ({
    sessionId,
    generation: 1,
    upto: 1,
    opState: running ? { turn: 1 } : null,
    nodes,
    turns: [],
  }) as unknown as UITimeline
const seven = (done: number): Array<[string, S]> =>
  Array.from({ length: 7 }, (_, i) => [
    `step ${i}`,
    i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  ])

const panel = (locale = 'en') => new PlanPanel(ansi, locale)

describe('PlanPanel', () => {
  it('draws each step with the plan card marks', () => {
    const p = panel()
    p.apply(
      tl(
        [
          call('p', [
            ['read', 'completed'],
            ['write', 'in_progress'],
            ['test', 'pending'],
          ]),
        ],
        true,
      ),
    )
    expect(p.render(60)).toEqual([' [x] read'.padEnd(60), ' [>] write'.padEnd(60), ' [ ] test'.padEnd(60)])
  })

  it('shows a window around the step in progress and counts the rest, in at most six rows', () => {
    const p = panel()
    p.apply(tl([call('p', seven(3))], true))
    const rows = p.render(60).map((row) => row.trim())
    expect(rows).toEqual(['[x] step 1', '[x] step 2', '[>] step 3', '[ ] step 4', '[ ] step 5', '… 2 more'])
    p.apply(tl([call('p', seven(0))], true))
    expect(p.render(60).map((row) => row.trim())).toEqual([
      '[>] step 0',
      '[ ] step 1',
      '[ ] step 2',
      '[ ] step 3',
      '[ ] step 4',
      '… 2 more',
    ])
  })

  it('shrinks to a one-line summary on a narrow screen', () => {
    const p = panel()
    p.apply(tl([call('p', seven(3))], true))
    expect(p.render(30).map((row) => row.trim())).toEqual(['Plan 3/7'])
  })

  it('keeps the finished summary until the next turn begins, and not for an old finished plan', () => {
    const p = panel()
    p.apply(tl([call('p', seven(2))], true))
    p.apply(
      tl(
        [
          call(
            'p',
            seven(7).map(([step]) => [step, 'completed'] as [string, S]),
          ),
        ],
        true,
      ),
    )
    expect(p.render(60).map((row) => row.trim())).toEqual(['Plan 7/7 ✓'])
    // The turn ends: still there.
    p.apply(
      tl(
        [
          call(
            'p',
            seven(7).map(([step]) => [step, 'completed'] as [string, S]),
          ),
        ],
        false,
      ),
    )
    expect(p.render(60)).toHaveLength(1)
    // The next turn starts: gone, and it stays gone while that turn runs.
    const done = call(
      'p',
      seven(7).map(([step]) => [step, 'completed'] as [string, S]),
    )
    p.apply(tl([done], true))
    p.apply(tl([done], true))
    expect(p.render(60)).toEqual([])
    // A plan found already finished in an idle session (a resume) has nothing to show either.
    const resumed = panel()
    resumed.apply(tl([done], false))
    expect(resumed.render(60)).toEqual([])
  })

  it('clears on a switch of session and when the plan call cannot be parsed', () => {
    const p = panel()
    p.apply(tl([call('p', seven(1))], true))
    expect(p.render(60).length).toBeGreaterThan(0)
    p.apply(tl([], true, 'other'))
    expect(p.render(60)).toEqual([])
    p.apply(tl([call('p', [], '{"plan":[{"step":"a","sta…')], true))
    expect(p.render(60)).toEqual([])
    p.apply(tl([call('q', seven(1))], true))
    p.reset()
    expect(p.render(60)).toEqual([])
  })

  it('/todos goes auto, show, hide and back, accepts a name, and refuses anything else', () => {
    const p = panel()
    const steps: Array<[string, S]> = [
      ['a', 'completed'],
      ['b', 'completed'],
    ]
    p.apply(tl([call('p', steps)], false))
    expect(p.render(60)).toEqual([])
    expect(p.setMode()).toContain('always shown')
    expect(p.render(60)).toHaveLength(1)
    expect(p.setMode()).toContain('hidden')
    p.apply(tl([call('q', seven(1))], true))
    expect(p.render(60)).toEqual([])
    expect(p.setMode()).toContain('automatic')
    expect(p.render(60).length).toBeGreaterThan(1)
    expect(p.setMode('hide')).toContain('hidden')
    expect(p.setMode('nope')).toBeUndefined()
    expect(panel('zh-CN').setMode('show')).toBe('计划面板：始终显示')
  })

  it('writes the summaries in Chinese', () => {
    const p = panel('zh-CN')
    p.apply(tl([call('p', seven(3))], true))
    expect(p.render(30)[0]?.trim()).toBe('计划 3/7')
  })
})
