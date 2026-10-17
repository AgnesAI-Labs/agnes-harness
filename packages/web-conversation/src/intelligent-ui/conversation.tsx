import type { UINode, UITurn } from '@agnes/protocol'
import { questionSubmission } from './question-dock.js'
/** The views a turn's ui_render calls created, named by their persisted result (`…&surface=<id>`). */
export function renderedSurfaceIds(nodes: readonly UINode[], turn: UITurn): string[] {
  const own = new Set(turn.nodeIds)
  return nodes.flatMap((node) => {
    if (node.kind !== 'tool' || node.name !== 'ui_render' || !own.has(node.id)) return []
    const id = /[?&]surface=([A-Za-z0-9_.%-]+)/.exec(node.resultPreview ?? '')?.[1]
    if (!id) return []
    try {
      return [decodeURIComponent(id)]
    } catch {
      return []
    }
  })
}

/** Each asking turn's delivered question answers: the turn rendered the question's surface. */
export function answeredQuestions(
  nodes: readonly UINode[],
  turns: readonly UITurn[],
): Map<string, { nodeId: string; submission: NonNullable<ReturnType<typeof questionSubmission>> }[]> {
  const out = new Map<
    string,
    { nodeId: string; submission: NonNullable<ReturnType<typeof questionSubmission>> }[]
  >()
  const submissions = nodes.flatMap((node) => {
    const submission = questionSubmission(node)
    return submission?.surfaceId.startsWith('card-') ? [{ nodeId: node.id, submission }] : []
  })
  if (!submissions.length) return out
  for (const turn of turns) {
    const rendered = new Set(renderedSurfaceIds(nodes, turn))
    const answered = submissions.filter((item) => rendered.has(item.submission.surfaceId))
    if (answered.length) out.set(turn.id, answered)
  }
  return out
}

export function foldedUserActions(nodes: readonly UINode[]): ReadonlySet<string> {
  const folded = new Set<string>()
  nodes.forEach((node, index) => {
    // ui_submit runs only from a person's surface action, never as the agent's step: the reply
    // does not show it as a tool call. The execution trace keeps it.
    if (node.kind === 'tool' && node.name === 'ui_submit') folded.add(node.id)
    // The ui_submit tool node itself can sit between the queued line and the delivered answers.
    const next = nodes.slice(index + 1).find((item) => item.kind === 'user')
    if (
      node.kind === 'user' &&
      node.system?.source === 'agnes/deferred-invocations' &&
      node.system.type === 'invocation-queued' &&
      String((node.system.data as { invocationId?: unknown } | undefined)?.invocationId ?? '').startsWith(
        'ui:',
      ) &&
      next &&
      questionSubmission(next)?.surfaceId.startsWith('card-')
    )
      folded.add(node.id)
  })
  return folded
}
