import type { UINode } from '@agnes/protocol'
import { useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { Button } from '../../ui/button.js'

type RefinementRun = Extract<UINode, { kind: 'refinement-run' }>

/**
 * How a withdrawal request ended: done, refused because an entry changed after the run (`changed`,
 * the `kind/id` of those entries), refused for another reason the session gave, or failed outright.
 */
export type RefinementWithdrawOutcome =
  | { kind: 'withdrawn' }
  | { kind: 'changed-since'; changed?: readonly string[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }

/** Withdraws the applied run whose applied row is `appliedSeq`; the host makes the request. */
export type RefinementWithdraw = (appliedSeq: number) => Promise<RefinementWithdrawOutcome>

const REFUSALS = new Set(['not-found', 'not-applied', 'is-rollback', 'rejected', 'child-session', 'closing'])

function outcomeText(outcome: RefinementWithdrawOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'withdrawn':
      return t('timeline.refinement.withdraw.done')
    case 'changed-since':
      return outcome.changed && outcome.changed.length > 0
        ? t('timeline.refinement.withdraw.changedNames', { names: outcome.changed.join(', ') })
        : t('timeline.refinement.withdraw.changed')
    case 'refused':
      return t('timeline.refinement.withdraw.refused', {
        reason: REFUSALS.has(outcome.reason)
          ? t(`timeline.refinement.withdraw.reason.${outcome.reason}`)
          : outcome.reason,
      })
    case 'failed':
      return t('timeline.refinement.withdraw.failed', { message: outcome.message })
  }
}

/** The entries a run changed, by name only; the entries' text is never part of the timeline. */
function changes(node: RefinementRun, t: Translate): string {
  const named = (op: 'upsert' | 'delete') =>
    (node.edits ?? []).filter((edit) => edit.op === op).map((edit) => `${edit.kind}/${edit.id}`)
  const saved = named('upsert')
  const removed = named('delete')
  return [
    saved.length > 0 ? t('timeline.refinement.saved', { names: saved.join(', ') }) : '',
    removed.length > 0 ? t('timeline.refinement.removed', { names: removed.join(', ') }) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * One background experience review as a line in the conversation: what asked for it, how it stands
 * or ended and why, which saved entries it changed, and whether that was withdrawn since. An applied
 * run not yet withdrawn offers to withdraw it when the host can, and says how that ended.
 */
export function RefinementRunNote({
  node,
  t,
  withdraw,
}: {
  node: RefinementRun
  t: Translate
  withdraw?: RefinementWithdraw | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  const text = [
    t(`timeline.refinement.state.${node.state}`, {
      trigger: t(`timeline.refinement.trigger.${node.trigger}`),
    }),
    node.reason ? t('timeline.refinement.reason', { reason: node.reason }) : '',
    changes(node, t),
    node.withdrawn ? t('timeline.refinement.withdrawn') : '',
  ]
    .filter(Boolean)
    .join(' ')
  const appliedSeq = node.appliedSeq
  const offer = withdraw && node.state === 'applied' && appliedSeq !== undefined && !node.withdrawn
  const onWithdraw = async () => {
    if (!withdraw || appliedSeq === undefined || busy) return
    setBusy(true)
    try {
      setResult(outcomeText(await withdraw(appliedSeq), t))
    } catch (error) {
      setResult(
        outcomeText({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }, t),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="node-body" role="status" data-testid="refinement-run-notice" data-state={node.state}>
        {text}
      </div>
      {offer && (
        <Button
          htmlType="button"
          appearance="ghost"
          size="small"
          loading={busy}
          data-testid="refinement-withdraw"
          onClick={() => void onWithdraw()}
        >
          {t('timeline.refinement.withdraw')}
        </Button>
      )}
      {result && (
        <div className="node-body" role="status" data-testid="refinement-withdraw-result">
          {result}
        </div>
      )}
    </>
  )
}
