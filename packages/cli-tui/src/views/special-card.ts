import type { UINode, UISpan, UITimeline } from '@agnes/protocol'
import { tt } from '../locale-extended.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

/** Tools that get a card of their own; the same grouping the Web conversation uses. */
export type CardKind = 'plan' | 'agent' | 'job' | 'workflow'

/** What the timeline knows of a card beyond its own node: a child's live status and run time. */
export type CardFacts = { status?: string; durationMs?: number }

export type PlanStep = { text: string; status: 'todo' | 'doing' | 'done' | 'blocked' }

// `todo` is the plan tool this repository ships; `update_plan` is the name other plan tools use.
const PLAN_TOOLS = new Set(['update_plan', 'todo'])
const JOB_TOOLS = new Set(['job_list', 'job_output', 'job_kill'])
const WORKFLOW_TOOLS = new Set(['workflow', 'workflow_status'])

export function cardKind(node: ToolNode): CardKind | undefined {
  if (PLAN_TOOLS.has(node.name)) return 'plan'
  if (node.delegatedTask || node.name.startsWith('subagent_')) return 'agent'
  if (JOB_TOOLS.has(node.name)) return 'job'
  if (node.name === 'shell' && node.resultPreview?.startsWith('background job ')) return 'job'
  if (WORKFLOW_TOOLS.has(node.name)) return 'workflow'
  return undefined
}

const STEP_STATUS: Record<string, PlanStep['status']> = {
  pending: 'todo',
  todo: 'todo',
  in_progress: 'doing',
  doing: 'doing',
  completed: 'done',
  done: 'done',
  blocked: 'blocked',
}

/**
 * The plan's steps as the tool was called with them. The projection carries only a 2048-character
 * preview of the arguments, so a very long plan arrives cut off, does not parse, and has no steps here.
 */
export function planSteps(node: ToolNode): PlanStep[] | undefined {
  let args: unknown
  try {
    args = JSON.parse(node.argsPreview ?? '')
  } catch {
    return undefined
  }
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const list = record.items ?? record.plan ?? record.steps
  if (!Array.isArray(list)) return undefined
  const steps = list.flatMap((item: unknown): PlanStep[] => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const text = [row.content, row.text, row.step, row.title].find((v) => typeof v === 'string')
    const status =
      typeof row.status === 'string' && Object.hasOwn(STEP_STATUS, row.status)
        ? STEP_STATUS[row.status]
        : undefined
    return typeof text === 'string' ? [{ text, status: status ?? 'todo' }] : []
  })
  return steps.length > 0 ? steps : undefined
}

/** Each subagent's status and run time by child key, from the trace spans of the projected turns. */
export function childFacts(timeline: UITimeline): Map<string, CardFacts> {
  const facts = new Map<string, CardFacts>()
  const visit = (span: UISpan): void => {
    if (span.kind === 'subagent' && span.childSessionKey) {
      // Like the Web card, the child's latest turn says more than the span that spawned it.
      const latest = span.children.filter((child) => child.kind === 'turn').at(-1)
      const durationMs = span.durationMs ?? latest?.durationMs
      facts.set(span.childSessionKey, {
        status: latest?.status ?? span.status,
        ...(durationMs === undefined ? {} : { durationMs }),
      })
    }
    for (const child of span.children) visit(child)
  }
  for (const turn of timeline.turns) if (turn.trace) visit(turn.trace)
  return facts
}

/** The words a special card's headline is made of: its kind, what it is about, and one line on it. */
export function cardHead(
  node: ToolNode,
  kind: CardKind,
  locale: string,
): { label: string; subject: string; summary: string } {
  const title = node.delegatedRole?.title
  return {
    label: tt(`card.${kind}`, locale),
    subject:
      kind === 'agent'
        ? ((locale === 'zh-CN' ? title?.['zh-CN'] : undefined) ?? title?.en ?? '')
        : kind === 'plan'
          ? ''
          : node.name,
    summary: kind === 'agent' ? (node.delegatedTask?.task ?? node.summary) : node.summary,
  }
}
