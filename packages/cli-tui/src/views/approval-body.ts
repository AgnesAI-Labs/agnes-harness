import { escapeControl, wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import { paintsColour, type ThemedAnsi } from '../theme.js'
import { diffInput, renderDiff } from './diff.js'

/** What an approval is about, as the live dialog and the parked card each learn it. */
export type ApprovalSubject = {
  tool?: string | undefined
  risk?: 'destructive' | 'always' | 'budget' | 'unknown' | undefined
  args?: unknown
}

const SHOWN_VALUE = 60

/** `key=value` for the first few plain arguments: what to say when the request has no summary of its own. */
export function paramSummary(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  return Object.entries(args)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, SHOWN_VALUE)}`)
    .join(', ')
}

/** The one line that names the request: its own summary, else the arguments, else nothing. */
export const approvalHeadline = (summary: unknown, args: unknown): string =>
  (typeof summary === 'string' ? summary.trim() : '') || paramSummary(args)

/** The headline both approval surfaces open with: `▲ Needs approval · <name> [risk]`, warning and bold. */
export function approvalHeading(
  name: string | undefined,
  risk: ApprovalSubject['risk'],
  ansi: ThemedAnsi,
  locale: string,
): string {
  const tag =
    risk === 'destructive' || risk === 'budget'
      ? ` ${ansi.fg(risk === 'destructive' ? 'danger' : 'warning', `[${tt(`approval.risk.${risk}`, locale)}]`)}`
      : ''
  const who = name ? ` ${ansi.fg('faint', '·')} ${ansi.bold(escapeControl(name))}` : ''
  return `${ansi.bold(ansi.fg('warning', `▲ ${tt('approval.needs', locale)}`))}${who}${tag}`
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** The command and working directory of a shell-like call (a string `command` argument); absent fields stay absent. */
export function shellOf(args: unknown): { command: string; cwd?: string } | undefined {
  const a = record(args)
  if (typeof a?.command !== 'string' || a.command.trim() === '') return undefined
  return typeof a.cwd === 'string' && a.cwd !== ''
    ? { command: a.command, cwd: a.cwd }
    : { command: a.command }
}

/**
 * The rows both approval surfaces show under their headline: for a shell-like call the command on its
 * own line (`$ cmd`) with the working directory under it, then, for an edit or write, what it would
 * change. Arguments and summary are external text.
 */
export function approvalBody(
  subject: ApprovalSubject,
  width: number,
  ansi: ThemedAnsi,
  locale: string,
): string[] {
  const shell = shellOf(subject.args)
  const command = shell
    ? wrapKeep(escapeControl(shell.command), width - 2).map((line, i) =>
        fitLine(`${ansi.fg('code', i === 0 ? `$ ${line}` : `  ${line}`)}`, width),
      )
    : []
  const cwd = shell?.cwd ? [fitLine(ansi.fg('muted', escapeControl(shell.cwd)), width)] : []
  const input = subject.tool ? diffInput(subject.tool, subject.args) : undefined
  return [...command, ...cwd, ...(input ? renderDiff(input, width, ansi, locale) : [])]
}

/**
 * Wraps each line of `text` on its own and keeps its leading spaces, which `wrapText` drops: pretty
 * JSON stays readable. An indent wider than half the row is cut back so the text still has room.
 */
export function wrapKeep(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  return text.split('\n').flatMap((line) => {
    const body = line.trimStart()
    const indent = Math.min(line.length - body.length, Math.floor(limit / 2))
    const pad = ' '.repeat(indent)
    return wrapText(body, limit - indent).map((part) => `${pad}${part}`)
  })
}

/** `HH:MM` in the viewer's local time, or nothing when the stamp is absent or not a date. */
export function localTime(stamp: string | undefined): string | undefined {
  const at = stamp ? new Date(stamp) : undefined
  if (!at || Number.isNaN(at.getTime())) return undefined
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** The tool and its arguments out of a parked approval: the node's tool name and its recorded subject. */
export function subjectOf(node: {
  toolName?: string | undefined
  risk?: ApprovalSubject['risk']
  subjectText?: string | undefined
}): ApprovalSubject {
  let call: { name?: unknown; args?: unknown } | undefined
  try {
    call = (JSON.parse(node.subjectText ?? 'null') as { call?: typeof call } | null)?.call
  } catch {
    // A clipped subject is not JSON; the card then has the node's own words only.
  }
  const tool = node.toolName ?? (typeof call?.name === 'string' ? call.name : undefined)
  return { tool, risk: node.risk, args: call?.args }
}

/**
 * The number or letter of an option as a keycap. A chip needs a background to read as one: without
 * colour the brackets carry it, and until the card has settled they are plain brackets for every tier.
 */
export const keycap = (ansi: ThemedAnsi, lit: boolean): ((key: string) => string) =>
  !lit
    ? (key) => `[${key}]`
    : paintsColour(ansi)
      ? (key) => ansi.bg('accent', ansi.fg('onAccent', ` ${key} `))
      : (key) => ansi.bold(`[${key}]`)
