import type { JsonValue } from '@agnes/protocol'
import type { SessionImpl } from './session.js'

type Risk = 'budget' | 'destructive' | 'always' | 'unknown'
const RANK: Record<Risk, number> = { budget: 0, destructive: 1, always: 2, unknown: 2 }

/** A hook may raise the risk a person is shown and never lower it. */
export function raisedRisk<R extends Risk>(
  asked: R,
  proposed: Risk | undefined,
): R | 'destructive' | 'always' {
  return proposed !== undefined &&
    proposed !== 'budget' &&
    proposed !== 'unknown' &&
    RANK[proposed] > RANK[asked]
    ? proposed
    : asked
}

/** The platform's own summary of a question whose text a hook rewrote, and who rewrote it. */
export type AskRewrite = { by: string[]; summary: string }

/**
 * One question for a person, after the `approval_request` hooks. The platform's summary stays on the
 * request beside whatever a hook wrote over it, with the sources that wrote it, so the person sees
 * both; the risk only moves up. `hooked: false` asks no hook: a question restored from the ledger
 * was already through them.
 */
export async function hookedAsk<A extends { summary: string; risk: Risk }>(
  s: SessionImpl,
  tool: string,
  argv: JsonValue,
  asked: A,
  hooked = true,
): Promise<{
  asked: A & { risk: A['risk'] | 'destructive' | 'always'; context?: string }
  rewrite?: AskRewrite
}> {
  const answer =
    hooked && s.hooks.approvalRequest
      ? await s.hooks.approvalRequest({
          request: {
            tool,
            argv,
            risk: asked.risk === 'unknown' ? 'always' : asked.risk,
            actor: s.d.actor,
            summary: asked.summary,
          },
        })
      : undefined
  const over = answer?.request
  if (!over) return { asked }
  const summary = over.summary ?? asked.summary
  const rewritten = summary !== asked.summary || over.context !== undefined
  return {
    asked: {
      ...asked,
      risk: raisedRisk(asked.risk, over.risk),
      summary,
      ...(over.context !== undefined ? { context: over.context } : {}),
    },
    ...(rewritten ? { rewrite: { by: [...(answer.rewrittenBy ?? [])], summary: asked.summary } } : {}),
  }
}
