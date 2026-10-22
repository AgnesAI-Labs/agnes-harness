import { escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
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

/**
 * The rows both approval surfaces show under their headline: the tool and how risky the request is,
 * then, for an edit or write, what it would change. Arguments and summary are external text.
 */
export function approvalBody(
  subject: ApprovalSubject,
  width: number,
  ansi: ThemedAnsi,
  locale: string,
): string[] {
  const risk =
    subject.risk === 'destructive' || subject.risk === 'budget'
      ? ` ${ansi.fg(subject.risk === 'destructive' ? 'danger' : 'warning', `[${tt(`approval.risk.${subject.risk}`, locale)}]`)}`
      : ''
  const head = subject.tool ? [fitLine(`${ansi.bold(escapeControl(subject.tool))}${risk}`, width)] : []
  const input = subject.tool ? diffInput(subject.tool, subject.args) : undefined
  return [...head, ...(input ? renderDiff(input, width, ansi, locale) : [])]
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
