import type { UsageView } from '@agnes/protocol'
import { type KeyHint, keyHints } from '../components/key-hints.js'
import { fitLine } from '../components/line.js'
import { clipLabel, contextPressure, formatTokenCountShort, sanitizeLabel } from '../format-usage.js'
import { EXTENDED_KEYS, type ExtendedKey, tt } from '../locale-extended.js'
import type { Tone } from '../palette.js'
import type { StatusField, StatusLineConfig } from '../statusline-config.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import type { WorkspaceInfo } from '../workspace-info.js'

/** Below this the composer is the bare `❯` row: the gauge's numbers would no longer fit. */
export const RAIL_MIN_WIDTH = 40
const MIN_BAR = 8
const BRANCH_MIN = 12
const MODEL_MIN = 8
const LABEL_MIN = 4

export type RailState = {
  workspace: WorkspaceInfo
  usage?: UsageView | undefined
  locale: string
  /** Which fields of the status line the user keeps; every one when absent. */
  fields?: Pick<StatusLineConfig, 'shows'> | undefined
  /** The prompt's vim mode, when `/vim` is on: its words, and whether it is normal mode. */
  mode?: { normal: boolean; label: string } | undefined
}

type Part = { text: string; tone?: Tone; bold?: true; italic?: true; chip?: true }
type Chip = {
  model?: string
  path?: string
  sub: string
  worktree?: string
  branch?: string
  detached: boolean
}
type Gauge = { tokens: number; window: number; compactAt?: number; showTokens: boolean }

const width = (parts: readonly Part[]) => parts.reduce((n, part) => n + displayWidth(part.text), 0)
const shortPath = (path: string) => {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1)
  return name && name !== path ? `…/${name}` : path
}

/** Adjacent parts with one style share one SGR span, so a bar is not one escape per cell. */
function paint(parts: readonly Part[], ansi: ThemedAnsi): string {
  const runs: Part[] = []
  for (const part of parts) {
    const last = runs.at(-1)
    if (
      last &&
      last.tone === part.tone &&
      last.bold === part.bold &&
      last.italic === part.italic &&
      last.chip === part.chip
    )
      last.text += part.text
    else runs.push({ ...part })
  }
  return runs
    .map(({ text, tone, bold, italic, chip }) => {
      let out = tone ? ansi.fg(tone, text) : text
      if (bold) out = ansi.bold(out)
      if (italic) out = ansi.italic(out)
      return chip ? ansi.bg('surface', out) : out
    })
    .join('')
}

function chipParts(chip: Chip): Part[] {
  const parts: Part[] = []
  const add = (text: string, tone: Tone, bold?: true) => {
    if (parts.length > 0) parts.push({ text: ' › ', tone: 'faint', chip: true })
    parts.push({ text, tone, chip: true, ...(bold ? { bold } : {}) })
  }
  if (chip.model !== undefined) add(`◆ ${chip.model}`, 'code', true)
  if (chip.path !== undefined) {
    add(chip.path, 'info')
    if (chip.sub) parts.push({ text: `/${chip.sub}`, tone: 'faint', chip: true })
  }
  if (chip.worktree !== undefined) add(chip.worktree ? `⌥ ${chip.worktree}` : '⌥', 'warning')
  if (chip.branch !== undefined) add(`⎇ ${chip.branch}`, chip.detached ? 'warning' : 'success')
  return parts.length === 0 ? [] : [{ text: ' ', chip: true }, ...parts, { text: ' ', chip: true }]
}

/** `─ 23% 230k ━━━──┊── 1M ─╮`; without usage the whole remainder is thin rule. */
function gaugeParts(gauge: Gauge | undefined, bar: number): Part[] {
  if (!gauge) return [{ text: `${'─'.repeat(bar)}─╮`, tone: 'border' }]
  const crossed = gauge.compactAt !== undefined && gauge.tokens >= gauge.compactAt
  const pressure = contextPressure(gauge)
  const tone: Tone =
    crossed || pressure === 'error' ? 'danger' : pressure === 'warning' ? 'warning' : 'accent'
  const used = Math.round(bar * Math.min(1, gauge.tokens / gauge.window))
  const mark =
    gauge.compactAt === undefined || bar === 0
      ? -1
      : Math.min(bar - 1, Math.floor((bar * gauge.compactAt) / gauge.window))
  const cells = Array.from({ length: bar }, (_, i): Part => {
    if (i === mark) return crossed ? { text: '╋', tone: 'danger' } : { text: '┊', tone: 'faint' }
    return i < used ? { text: '━', tone } : { text: '─', tone: 'border' }
  })
  return [
    { text: '─ ', tone: 'border' },
    { text: `${Math.round((gauge.tokens / gauge.window) * 100)}%`, tone, bold: true },
    ...(gauge.showTokens
      ? [{ text: ` ${formatTokenCountShort(gauge.tokens)}`, tone: 'muted' as const }]
      : []),
    { text: ' ' },
    ...cells,
    { text: ` ${formatTokenCountShort(gauge.window)} `, tone: 'muted', bold: true },
    { text: '─╮', tone: 'border' },
  ]
}

/** The composer's top edge: workspace chip, then the context gauge filling the rest. */
export function topRail(state: RailState, frameWidth: number, ansi: ThemedAnsi): string {
  const { workspace: ws, usage } = state
  const show = (field: StatusField): boolean => state.fields?.shows(field) ?? true
  const chip: Chip = {
    ...(usage && show('model') ? { model: sanitizeLabel(usage.model.id) } : {}),
    ...(show('cwd') ? { path: sanitizeLabel(ws.root) } : {}),
    sub: show('cwd') ? sanitizeLabel(ws.subpath) : '',
    ...(ws.worktree === undefined || !show('branch') ? {} : { worktree: sanitizeLabel(ws.worktree) }),
    ...(!show('branch')
      ? {}
      : ws.detached
        ? { branch: `@${sanitizeLabel(ws.detached)}` }
        : ws.branch
          ? { branch: sanitizeLabel(ws.branch) }
          : {}),
    detached: Boolean(ws.detached),
  }
  const gauge: Gauge | undefined =
    usage && show('usage')
      ? {
          tokens: usage.context.tokens,
          window: usage.context.window,
          ...(usage.context.compactAt === undefined ? {} : { compactAt: usage.context.compactAt }),
          showTokens: true,
        }
      : undefined
  const line = (bar: number): Part[] => [
    { text: '╭─', tone: 'border' },
    ...chipParts(chip),
    ...gaugeParts(gauge, bar),
  ]
  const over = () => width(line(MIN_BAR)) - frameWidth
  const clip = (label: string, floor: number) =>
    clipLabel(label, Math.max(floor, displayWidth(label) - over()))
  // Spec order first (worktree, branch, path, token count, model); the rest only keeps arbitrarily
  // long labels inside the 40-column floor.
  const steps: Array<() => void> = [
    () => {
      if (chip.worktree) chip.worktree = ''
    },
    () => {
      if (chip.branch) chip.branch = clip(chip.branch, BRANCH_MIN)
    },
    () => {
      if (chip.path !== undefined) chip.path = shortPath(chip.path)
      chip.sub = ''
    },
    () => {
      if (gauge) gauge.showTokens = false
    },
    () => {
      if (chip.model) chip.model = clip(chip.model, MODEL_MIN)
    },
    () => {
      if (chip.path !== undefined) chip.path = clip(chip.path, LABEL_MIN)
    },
    () => {
      delete chip.branch
      delete chip.worktree
    },
  ]
  for (const step of steps) {
    if (over() <= 0) break
    step()
  }
  const bar = Math.max(0, frameWidth - width(line(0)))
  const painted = paint(line(bar), ansi)
  // Only a nonsensical gauge (a context hundreds of times its window) can still be too wide.
  return width(line(bar)) > frameWidth ? fitLine(painted, frameWidth) : painted
}

/** The composer's bottom edge: thinking level and keys, dropped right to left as space runs out. */
export function bottomRail(state: RailState, frameWidth: number, ansi: ThemedAnsi): string {
  const say = (key: ExtendedKey, vars: Record<string, string> = {}) => tt(key, state.locale, vars)
  const level = state.usage?.model.thinking
  const levelKey = `composer.level.${level}`
  const levelLabel = (EXTENDED_KEYS as readonly string[]).includes(levelKey)
    ? say(levelKey as ExtendedKey)
    : sanitizeLabel(level ?? '')
  // A block for normal mode and a bar for insert, as a vim cursor looks; bold accent against quiet, so mono tells them apart too.
  const mode = state.mode
  const lead: Part[][] = [
    ...(mode
      ? [
          [
            mode.normal
              ? ({ text: `█ ${mode.label}`, tone: 'accent', bold: true } as Part)
              : ({ text: `▏${mode.label}`, tone: 'muted' } as Part),
          ],
        ]
      : []),
    ...(level
      ? [[{ text: say('composer.thinking', { level: levelLabel }), tone: 'muted', italic: true } as Part]]
      : []),
  ]
  const keys: KeyHint[] = [
    { key: '/', label: say('composer.commands') },
    { key: '@', label: say('composer.files') },
    { key: '⏎', label: say('composer.send') },
  ]
  // `╰─` and ` ─╯` take five columns, and at least one space follows `╰─`.
  const room = Math.max(0, frameWidth - 6)
  const leadRow = (): Part[] => lead.flatMap((h, i) => (i === 0 ? h : [{ text: '  ' }, ...h]))
  // The hints have the last claim on the row, so the lead gives way first, from the right, when not even one fits.
  while (
    lead.length > 0 &&
    room - width(leadRow()) - 2 < displayWidth(`${keys.at(-1)?.key} ${keys.at(-1)?.label}`)
  )
    lead.pop()
  const gap = lead.length > 0 ? 2 : 0
  const avail = room - width(leadRow()) - gap
  const hints =
    avail >= displayWidth(`${keys.at(-1)?.key} ${keys.at(-1)?.label}`) ? keyHints(keys, ansi, avail) : ''
  const used = width(leadRow()) + (hints ? gap : 0) + displayWidth(hints)
  return paint(
    [
      { text: '╰─', tone: 'border' },
      { text: ' '.repeat(Math.max(1, frameWidth - 5 - used)) },
      ...leadRow(),
      ...(hints && lead.length > 0 ? [{ text: '  ' }] : []),
    ],
    ansi,
  ).concat(hints, paint([{ text: ' ' }, { text: '─╯', tone: 'border' }], ansi))
}
