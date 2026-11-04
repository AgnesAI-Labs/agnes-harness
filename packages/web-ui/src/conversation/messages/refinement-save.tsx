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
  'user-memory-budget',
  'model-cannot-write-user',
  'workflow-run-unavailable',
  'workflow-run-not-completed',
  'workflow-definition-too-large',
  'workflow-already-saved',
])
/** The outcomes a promotion to user memory can have; any other is said as for the workspace. */
const USER_STATES = new Set(['saved', 'refused', 'unknown'])

/**
 * How a "save to workspace" asked from a review line ended: the receipt the host wrote (its outcome and,
 * when refused, why), a refusal before any receipt (for example the entry is no longer in the session),
 * or a failure to ask at all.
 */
export type RefinementSaveOutcome =
  | {
      kind: 'receipt'
      state: RefinementSave['state']
      reason?: string
      /** `user-memory` when the receipt is for a save to user memory (the workspace otherwise). */
      target?: 'user-memory'
      userMemoryRead?: boolean
      initiator?: RefinementSave['initiator']
    }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }

/**
 * Saves one entry of this session to its workspace, or with `target: 'user'` to user memory, as the user's
 * own save; the host makes the request.
 */
export type RefinementSaveEntry = (
  kind: 'memory' | 'prompt' | 'skill',
  id: string,
  target?: 'user',
) => Promise<RefinementSaveOutcome>

const reasonText = (reason: string, t: Translate, user = false): string =>
  t('timeline.refinement.reason', {
    reason:
      user && reason === 'user-revoked'
        ? t('timeline.refinementSave.user.revoked')
        : REASONS.has(reason)
          ? t(`timeline.refinementSave.reason.${reason}`)
          : reason,
  })

/**
 * One save of task experience into the workspace or user memory, in words: how it ended, who asked for
 * it, and why it was refused. A save waiting for approval says where to answer it; one that ended unknown
 * says its paragraph stays hidden until a person repairs or removes it; a promotion to user memory says
 * it reaches every workspace that reads user memory, where to withdraw it, and when this workspace does
 * not read it. Never the entry's text or the file.
 */
export function saveText(
  save: Pick<RefinementSave, 'state'> & {
    initiator?: RefinementSave['initiator'] | undefined
    reason?: string | undefined
    target?: RefinementSave['target'] | undefined
    userMemoryRead?: boolean | undefined
  },
  t: Translate,
): string {
  const user = save.target === 'user-memory' && USER_STATES.has(save.state)
  return [
    user
      ? t(
          save.state === 'saved' && save.initiator === 'user'
            ? 'timeline.refinementSave.user.state.savedByRequest'
            : `timeline.refinementSave.user.state.${save.state}`,
        )
      : t(`timeline.refinementSave.state.${save.state}`),
    save.initiator && !(user && save.state === 'saved' && save.initiator === 'user')
      ? t('timeline.refinementSave.by', { who: t(`timeline.refinementSave.initiator.${save.initiator}`) })
      : '',
    save.state === 'awaiting-approval' ? t('timeline.refinementSave.awaiting') : '',
    save.state === 'unknown' ? t('timeline.refinementSave.unknownHint') : '',
    user && save.state === 'saved' ? t('timeline.refinementSave.user.withdraw') : '',
    user && save.state === 'saved' && save.userMemoryRead === false
      ? t('timeline.refinementSave.user.notRead')
      : '',
    save.reason ? reasonText(save.reason, t, user) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** What the per-entry save button reports once the host answered. */
export function saveOutcomeText(outcome: RefinementSaveOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'receipt':
      return saveText(
        {
          state: outcome.state,
          initiator: outcome.initiator,
          reason: outcome.reason,
          target: outcome.target,
          userMemoryRead: outcome.userMemoryRead,
        },
        t,
      )
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
