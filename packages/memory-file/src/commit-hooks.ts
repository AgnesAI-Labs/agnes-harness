import type { MemoryFile } from '@agnes/extension-api'
import { appendAudit } from './audit.js'
import { fault } from './content.js'
import type { CommitIntent, MemoryPipeline, ViewContext } from './pipeline.js'
import { prepareMemoryProtection } from './preference-conflict.js'

function guardRefusal(pipeline: MemoryPipeline, intent: CommitIntent, ctx: ViewContext) {
  const verdict = pipeline.checkGuards(intent, ctx)
  if (verdict.kind !== 'refuse') return
  const error = Object.assign(
    fault(verdict.code),
    verdict.detail ? { message: `${verdict.code}: ${verdict.detail}` } : {},
  )
  const audit = () => {
    try {
      appendAudit(ctx.meta, {
        at: new Date(ctx.now).toISOString(),
        path: intent.path,
        action: 'refused',
        code: verdict.code,
        origin: intent.origin,
        actor: intent.actor,
        ...(intent.source?.sessionKey ? { sessionKey: intent.source.sessionKey } : {}),
        ...(intent.source?.maintenance ? { maintenance: intent.source.maintenance } : {}),
        beforeHash: intent.before.hash,
        afterHash: intent.candidate.hash,
      })
    } catch {
      // Best-effort refusal audit must not mask guard error.
    }
  }
  return { error, audit }
}

export async function checkProposalGuards(
  pipeline: MemoryPipeline,
  intent: CommitIntent,
  ctx: ViewContext,
  signal: AbortSignal,
): Promise<void> {
  const refusal = guardRefusal(pipeline, intent, ctx)
  if (!refusal) return
  // Commit observers use this same lock for audit sequence allocation and rotation.
  await ctx.meta.store.locked(refusal.audit, signal).catch(() => undefined)
  throw refusal.error
}

/** Recheck policy and metadata capacity under the store lock, then observe the published file. */
export function commitHooks(
  pipeline: MemoryPipeline,
  source: Omit<CommitIntent, 'before' | 'candidate'>,
  context: () => ViewContext,
) {
  return (before: MemoryFile, candidate: MemoryFile) => {
    const intent = { ...source, before, candidate }
    const ctx = context()
    const refusal = intent.origin !== 'human' && guardRefusal(pipeline, intent, ctx)
    if (refusal) {
      refusal.audit()
      throw refusal.error
    }
    prepareMemoryProtection(pipeline, intent, ctx)
    return () => pipeline.runObservers(intent, candidate, context())
  }
}
