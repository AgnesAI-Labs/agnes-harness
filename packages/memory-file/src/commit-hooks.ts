import type { MemoryFile } from '@agnes/extension-api'
import { appendAudit } from './audit.js'
import { fault, hash } from './content.js'
import type { CommitIntent, MemoryClock, MemoryPipeline, ViewContext } from './pipeline.js'
import { prepareMemoryProtection } from './preference-conflict.js'
import { retrievalOf } from './recall.js'

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

export type VerifyCommitView = (before: MemoryFile, ctx: ViewContext) => void

/** Recheck policy and metadata capacity under the store lock, then observe the published file. */
export function commitHooks(
  pipeline: MemoryPipeline,
  source: Omit<CommitIntent, 'before' | 'candidate'>,
  context: (now: number) => ViewContext,
  clock: MemoryClock,
  verifyView?: VerifyCommitView,
  operation: 'write' | 'delete' = 'write',
) {
  return (before: MemoryFile, candidate: MemoryFile) => {
    const intent = { ...source, before, candidate }
    const ctx = context(clock())
    verifyView?.(before, ctx)
    const refusal = intent.origin !== 'human' && guardRefusal(pipeline, intent, ctx)
    if (refusal) {
      refusal.audit()
      throw refusal.error
    }
    if (operation === 'delete')
      return () => {
        const now = clock()
        try {
          const retrieval = retrievalOf(pipeline)
          if (retrieval) {
            const live = context(now)
            retrieval.refreshIndex({
              ...live,
              files: live.files.filter((entry) => entry.path !== intent.path),
            })
          }
        } finally {
          appendAudit(ctx.meta, {
            at: new Date(now).toISOString(),
            path: intent.path,
            action: 'delete',
            origin: intent.origin,
            actor: intent.actor,
            ...(intent.source ? { sessionKey: intent.source.sessionKey } : {}),
            ...(intent.source?.maintenance ? { maintenance: intent.source.maintenance } : {}),
            beforeHash: before.hash,
            afterHash: hash('delete:' + before.hash),
          })
        }
      }
    prepareMemoryProtection(pipeline, intent, ctx)
    return () => {
      const now = clock()
      let postCtx: ViewContext
      try {
        postCtx = context(now)
      } catch {
        // External file changes can prevent enumeration after rename. Preserve the commit for observers.
        const byPath = new Map(ctx.files.map((file) => [file.path, file]))
        byPath.set(candidate.path, candidate)
        const files = [...byPath.values()]
        postCtx = { ...ctx, now, files, ...(ctx.layer === 'user' ? { userFiles: files } : {}) }
      }
      pipeline.runObservers(intent, candidate, postCtx)
    }
  }
}
