import type { UINode } from '@agnes/protocol'
import type { Translate } from '../../locales/index.js'

type RefinementSave = Extract<UINode, { kind: 'refinement-save' }>

/** Refusal reasons this client can say in words; a later one is shown as the host named it. */
const REASONS = new Set([
  'refinement-off',
  'user-revoked',
  'unconfirmed',
  'source-rules',
  'static-check',
  'memory-off',
  'memory-full',
  'unsupported-provider',
  'subagent-review-unavailable',
  'child-session',
  'unavailable',
  'conflict',
  'approval-expired',
])

/**
 * How a "save to workspace" asked from a review line ended: the receipt the host wrote (its outcome and,
 * when refused, why), a refusal before any receipt (for example the entry is no longer in the session),
 * or a failure to ask at all.
 */
export type RefinementSaveOutcome =
  | { kind: 'receipt'; state: RefinementSave['state']; reason?: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }

/** Saves one entry of this session to its workspace, as the user's own save; the host makes the request. */
export type RefinementSaveEntry = (
  kind: 'memory' | 'prompt' | 'skill',
  id: string,
) => Promise<RefinementSaveOutcome>

const reasonText = (reason: string, t: Translate): string =>
  t('timeline.refinement.reason', {
    reason: REASONS.has(reason) ? t(`timeline.refinementSave.reason.${reason}`) : reason,
  })

/**
 * One save of task experience into the workspace, in words: how it ended, who asked for it, and why it
 * was refused. A save waiting for approval says where to answer it; one that ended unknown says its
 * paragraph stays hidden until a person repairs or removes it. Never the entry's text or the file.
 */
export function saveText(
  save: Pick<RefinementSave, 'state' | 'initiator'> & { reason?: string | undefined },
  t: Translate,
): string {
  return [
    t(`timeline.refinementSave.state.${save.state}`),
    save.initiator
      ? t('timeline.refinementSave.by', { who: t(`timeline.refinementSave.initiator.${save.initiator}`) })
      : '',
    save.state === 'awaiting-approval' ? t('timeline.refinementSave.awaiting') : '',
    save.state === 'unknown' ? t('timeline.refinementSave.unknownHint') : '',
    save.reason ? reasonText(save.reason, t) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** What the per-entry save button reports once the host answered. */
export function saveOutcomeText(outcome: RefinementSaveOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'receipt':
      return saveText({ state: outcome.state, reason: outcome.reason }, t)
    case 'refused':
      return t('timeline.refinementSave.refused', {
        reason: REASONS.has(outcome.reason)
          ? t(`timeline.refinementSave.reason.${outcome.reason}`)
          : outcome.reason === 'not-found'
            ? t('timeline.refinementSave.notFound')
            : outcome.reason,
      })
    case 'failed':
      return t('timeline.refinementSave.failed', { message: outcome.message })
  }
}

export function RefinementSaveNote({ node, t }: { node: RefinementSave; t: Translate }) {
  return (
    <div className="node-body" role="status" data-testid="refinement-save-notice" data-state={node.state}>
      {saveText(node, t)}
    </div>
  )
}
