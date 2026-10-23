import type { UsageView } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { displayWidth } from '../src/terminal.js'
import { TuiTheme } from '../src/theme.js'
import { bottomRail, type RailState, topRail } from '../src/views/composer-rail.js'
import type { WorkspaceInfo } from '../src/workspace-info.js'

const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))
const COLOUR = new TuiTheme('dark').ansi(createAnsi('256'))

const usage = (
  tokens: number,
  compactAt?: number,
  thinking: UsageView['model']['thinking'] = 'high',
): UsageView => ({
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  context: {
    tokens,
    window: 1_000_000,
    autoCompact: compactAt !== undefined,
    ...(compactAt ? { compactAt } : {}),
  },
  model: { route: 'agnes', id: 'GLM-5.3-Flash', thinking },
})
const LANE: WorkspaceInfo = {
  root: '~/agnes-harness',
  subpath: 'packages/web',
  worktree: 'lane-a',
  branch: 'feat/agh-plugin-core',
}
const state = (over: Partial<RailState> = {}): RailState => ({
  workspace: LANE,
  usage: usage(230_000, 850_000),
  locale: 'en',
  ...over,
})
/** The gauge cells between the numbers and the window label. */
const bar = (line: string) => /% (?:\S+ )?([━─┊╋]+) 1M ─╮$/.exec(line)?.[1] ?? ''

describe('composer rail top edge', () => {
  it('draws model, workspace and the gauge at full width', () => {
    const line = topRail(state(), 200, PLAIN)
    expect(
      line.startsWith(
        '╭─ ◆ GLM-5.3-Flash › ~/agnes-harness/packages/web › ⌥ lane-a › ⎇ feat/agh-plugin-core ─ 23% 230k ',
      ),
    ).toBe(true)
    expect(line.endsWith(' 1M ─╮')).toBe(true)
    expect(displayWidth(line)).toBe(200)
  })

  it('fills every width exactly, whatever the labels', () => {
    const hostile: WorkspaceInfo = {
      root: `~/${'很长的仓库名'.repeat(12)}`,
      subpath: 'a/'.repeat(40),
      worktree: 'w'.repeat(80),
      branch: `feat/${'x'.repeat(120)}\x1b[31m\u202e`,
    }
    const fixtures: RailState[] = [
      state(),
      state({ usage: undefined }),
      state({ workspace: { root: '/', subpath: '' } }),
      state({ workspace: { root: '~/r', subpath: '', detached: '16f42a3' } }),
      state({
        workspace: hostile,
        usage: { ...usage(990_000, 850_000), model: { route: 'r', id: 'm'.repeat(90), thinking: 'xhigh' } },
      }),
    ]
    for (const fixture of fixtures)
      for (let width = 39; width <= 220; width++)
        for (const ansi of [PLAIN, COLOUR]) {
          expect(displayWidth(topRail(fixture, width, ansi)), `top ${width}`).toBe(width)
          expect(displayWidth(bottomRail(fixture, width, ansi)), `bottom ${width}`).toBe(width)
        }
  })

  it('degrades worktree, branch, path, token count, then model; keeps percent and window', () => {
    const lost = (line: string) => [
      !line.includes('⌥ lane-a'),
      !line.includes('⎇ feat/agh-plugin-core'),
      !line.includes('~/agnes-harness/packages/web'),
      !line.includes(' 230k '),
      !line.includes('GLM-5.3-Flash'),
    ]
    const seen = new Set<string>()
    for (let width = 200; width >= 39; width--) {
      const line = topRail(state(), width, PLAIN)
      const flags = lost(line)
      // A later step never happens before every earlier one has.
      expect(flags, `${width}: ${line}`).toEqual([...flags].sort((a, b) => Number(b) - Number(a)))
      expect(line).toContain('23%')
      expect(line).toContain(' 1M ─╮')
      seen.add(flags.join())
    }
    expect(seen.size).toBe(6)
    expect(topRail(state(), 80, PLAIN)).toMatch(
      /^╭─ ◆ GLM-5\.3-Flash › …\/agnes-harness › ⌥ › ⎇ feat\/agh-pl… ─ 23% /,
    )
  })

  it.each([
    ['normal', 120_000, 'accent'],
    ['warning past 70%', 780_000, 'warning'],
    ['danger past 90%', 930_000, 'danger'],
  ] as const)('%s', (_name, tokens, tone) => {
    const line = topRail(state({ usage: usage(tokens) }), 120, COLOUR)
    expect(line).toContain(COLOUR.bold(COLOUR.fg(tone, `${Math.round(tokens / 10_000)}%`)))
    const [open] = COLOUR.fg(tone, '━').split('━')
    expect(line).toContain(`${open}━`)
  })

  it('marks the compaction point and crosses it once the context is past it', () => {
    const at = (tokens: number, compactAt?: number, ansi = PLAIN) =>
      topRail(
        { workspace: { root: '~/r', subpath: '' }, usage: usage(tokens, compactAt), locale: 'en' },
        120,
        ansi,
      )
    const before = bar(at(120_000, 850_000))
    expect(before.length).toBeGreaterThan(50)
    expect(before.indexOf('┊')).toBe(Math.floor(before.length * 0.85))
    expect(before.lastIndexOf('━') + 1).toBe(Math.round(before.length * 0.12))
    const after = bar(at(600_000, 500_000))
    expect(after).toContain('╋')
    expect(after).not.toContain('┊')
    // Crossing the mark is red even below the 90% tier.
    expect(at(600_000, 500_000, COLOUR)).toContain(COLOUR.bold(COLOUR.fg('danger', '60%')))
    expect(bar(at(120_000))).toMatch(/^━+─+$/)
  })

  it('without usage shows only the workspace and a thin rule', () => {
    const line = topRail(state({ usage: undefined }), 100, PLAIN)
    expect(line).toMatch(/^╭─ ~\/agnes-harness\/packages\/web › ⌥ lane-a › ⎇ feat\/agh-plugin-core ─+╮$/)
  })

  it('shows a detached HEAD as its short commit in the warning tone, and no git as the bare path', () => {
    const detached = state({ workspace: { root: '~/agnes-harness', subpath: '', detached: '16f42a3' } })
    expect(topRail(detached, 120, PLAIN)).toContain('› ~/agnes-harness › ⎇ @16f42a3 ─')
    expect(topRail(detached, 120, COLOUR)).toContain(COLOUR.fg('warning', '⎇ @16f42a3'))
    const plain = topRail(state({ workspace: { root: '~/Downloads/notes', subpath: '' } }), 120, PLAIN)
    expect(plain).toContain('◆ GLM-5.3-Flash › ~/Downloads/notes ─ 23%')
    expect(plain).not.toMatch(/[⌥⎇]/)
  })

  it('never lets control or bidi characters from git or the daemon reach the terminal', () => {
    const line = topRail(
      state({
        workspace: {
          root: '~/r\x07',
          subpath: 'x\n',
          worktree: 'w\x1b]0;t\x07',
          branch: 'b\x1b[31m\u202eevil',
        },
        usage: { ...usage(1), model: { route: 'r', id: 'm\x1b[2J', thinking: 'high' } },
      }),
      160,
      PLAIN,
    )
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u)
    expect(line).toContain('⎇ b[31mevil')
  })
})

describe('composer rail bottom edge', () => {
  it('shows the thinking level and keys, dropping keys right to left before the level', () => {
    const zh = state({ locale: 'zh-CN' })
    expect(bottomRail(zh, 80, PLAIN)).toMatch(/^╰─ +思考 高 {2}\/ 命令 {2}@ 文件 {2}⏎ 发送 ─╯$/)
    expect(bottomRail(state(), 80, PLAIN)).toMatch(
      /^╰─ +thinking high {2}\/ commands {2}@ files {2}⏎ send ─╯$/,
    )
    const kept = [80, 40, 32, 24, 18, 10].map((w) => bottomRail(zh, w, PLAIN).replace(/^╰─ */, ''))
    expect(kept).toEqual([
      '思考 高  / 命令  @ 文件  ⏎ 发送 ─╯',
      '思考 高  / 命令  @ 文件  ⏎ 发送 ─╯',
      '思考 高  / 命令  @ 文件 ─╯',
      '思考 高  / 命令 ─╯',
      '思考 高 ─╯',
      '─╯',
    ])
    expect(bottomRail(state({ usage: undefined }), 80, PLAIN)).not.toContain('thinking')
  })
})

describe('composer rail with fields turned off', () => {
  const hide = (...hidden: string[]) => ({ shows: (field: string) => !hidden.includes(field) })
  const top = (...hidden: string[]) =>
    topRail(state({ fields: hide(...hidden) as RailState['fields'] }), 200, PLAIN)

  it('leaves out the model, the directory, the branch and the gauge one by one, and keeps the width', () => {
    expect(top('model')).not.toContain('GLM-5.3-Flash')
    expect(top('model')).toContain('~/agnes-harness/packages/web')
    expect(top('cwd')).not.toContain('agnes-harness')
    expect(top('cwd')).toContain('GLM-5.3-Flash')
    expect(top('branch')).not.toContain('feat/agh-plugin-core')
    expect(top('branch')).not.toContain('lane-a')
    expect(top('usage')).not.toContain('23%')
    expect(top('usage')).toContain('GLM-5.3-Flash')
    for (const hidden of [['model'], ['cwd'], ['branch'], ['usage'], ['model', 'cwd', 'branch', 'usage']])
      expect(displayWidth(top(...hidden))).toBe(200)
    expect(top('model', 'cwd', 'branch', 'usage')).toBe(`╭─${'─'.repeat(197)}╮`)
  })
})
