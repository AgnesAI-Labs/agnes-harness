import type { UINode } from '@agnes/protocol'
import { useId, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { Button } from '../../ui/button.js'
import { Icon } from '../../ui/icon.js'
import {
  type RefinementSave,
  type RefinementSaveEntry,
  RefinementSaveNote,
  saveOutcomeText,
} from './refinement-save.js'

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

function outcomeText(
  outcome: Exclude<RefinementWithdrawOutcome, { kind: 'withdrawn' }>,
  t: Translate,
): string {
  switch (outcome.kind) {
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

function reviewReason(reason: string, t: Translate): string {
  const key = `timeline.refinement.runReason.${reason}`
  const label = t(key)
  return t('timeline.refinement.reason', {
    reason: label === key ? t('timeline.refinement.runReason.other') : label,
  })
}

function changeCount(action: 'saved' | 'removed', count: number, t: Translate): string {
  return count ? t(`timeline.refinement.count.${action}.${count === 1 ? 'one' : 'many'}`, { count }) : ''
}

export function hasRefinementDetails(node: RefinementRun, withdraw: RefinementWithdraw | undefined): boolean {
  return (
    node.state === 'applied' &&
    !node.withdrawn &&
    ((node.edits?.length ?? 0) > 0 || (!!withdraw && node.appliedSeq !== undefined))
  )
}

/**
 * The review's status and its applied changes. The host owns each action and its receipt.
 */
export function RefinementRunNote({
  node,
  t,
  withdraw,
  save,
  saves,
}: {
  node: RefinementRun
  t: Translate
  withdraw?: RefinementWithdraw | undefined
  save?: RefinementSaveEntry | undefined
  saves?: readonly RefinementSave[] | undefined
}) {
  const detailsId = useId()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RefinementWithdrawOutcome>()
  const [hasStartedSave, setHasStartedSave] = useState(false)
  const trigger = t(`timeline.refinement.trigger.${node.trigger}`)
  const withdrawn = node.withdrawn || result?.kind === 'withdrawn'
  const edits = node.edits ?? []
  const { appliedSeq } = node
  const canWithdraw = !!withdraw && appliedSeq !== undefined
  const expandable = result?.kind !== 'withdrawn' && hasRefinementDetails(node, withdraw)
  const notice = { 'data-testid': 'refinement-run-notice', 'data-state': node.state }
  const reason = node.reason ? reviewReason(node.reason, t) : undefined

  const onWithdraw = async () => {
    if (!withdraw || appliedSeq === undefined || busy) return
    setBusy(true)
    try {
      setResult(await withdraw(appliedSeq))
    } catch (error) {
      setResult({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!expandable) {
    return (
      <div className="node-body" role="status" {...notice}>
        {withdrawn
          ? t('timeline.refinement.withdrawn', { trigger })
          : [t(`timeline.refinement.state.${node.state}`, { trigger }), reason].filter(Boolean).join(' ')}
      </div>
    )
  }

  const saved = edits.filter((edit) => edit.op === 'upsert').length
  const summary = edits.length
    ? [
        t('timeline.refinement.title', { trigger }),
        changeCount('saved', saved, t),
        changeCount('removed', edits.length - saved, t),
      ]
        .filter(Boolean)
        .join(' · ')
    : t('timeline.refinement.state.applied', { trigger })
  return (
    <div className="refinement-run">
      <Button
        htmlType="button"
        appearance="ghost"
        size="small"
        className="refinement-summary"
        {...notice}
        aria-expanded={expanded}
        aria-controls={detailsId}
        title={summary}
        onClick={() => setExpanded((open) => !open)}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <span>{summary}</span>
      </Button>
      <div className="refinement-details" id={detailsId} hidden={!expanded}>
        {reason && <p>{reason}</p>}
        {edits.length > 0 && (
          <ul className="refinement-edits">
            {edits.map(({ kind, id, op, workflow }) => {
              const label = t(`timeline.refinement.entryKind.${kind}`)
              return (
                <li key={`${kind}/${id}`}>
                  <div className="refinement-entry">
                    <span className="refinement-entry-kind">{label}</span>
                    <span translate="no">{id}</span>
                    {op === 'delete' && <small>{t('timeline.refinement.entryRemoved')}</small>}
                    {workflow && <small>{t('timeline.refinement.workflow')}</small>}
                  </div>
                  {save && op === 'upsert' && kind !== 'subagent' && (
                    <SaveEntry
                      kind={kind}
                      id={id}
                      name={`${label} ${id}`}
                      save={save}
                      t={t}
                      onSaveStart={() => setHasStartedSave(true)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {saves?.map((receipt) =>
          hasStartedSave && receipt.initiator === 'user' ? null : (
            <RefinementSaveNote key={receipt.id} node={receipt} t={t} />
          ),
        )}
        {canWithdraw && (
          <div className="refinement-actions">
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
          </div>
        )}
        {result && (
          <div className="node-body" role="status" data-testid="refinement-withdraw-result">
            {outcomeText(result, t)}
          </div>
        )}
      </div>
    </div>
  )
}

/** One kept entry's "save to workspace" action and how it ended. */
function SaveEntry(props: {
  kind: 'memory' | 'prompt' | 'skill'
  id: string
  name: string
  save: RefinementSaveEntry
  onSaveStart: () => void
  t: Translate
}) {
  const { kind, id, name, save, onSaveStart, t } = props
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  const onSave = async (target?: 'user') => {
    if (busy) return
    onSaveStart()
    setBusy(true)
    try {
      setResult(saveOutcomeText(await (target ? save(kind, id, target) : save(kind, id)), t))
    } catch (error) {
      setResult(
        saveOutcomeText(
          { kind: 'failed', message: error instanceof Error ? error.message : String(error) },
          t,
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="refinement-actions">
        <Button
          htmlType="button"
          appearance="ghost"
          size="small"
          loading={busy}
          data-testid="refinement-save-entry"
          aria-label={t('timeline.refinementSave.entry', { name })}
          onClick={() => void onSave()}
        >
          {t('timeline.refinementSave.workspaceAction')}
        </Button>
        {kind !== 'skill' && (
          <Button
            htmlType="button"
            appearance="ghost"
            size="small"
            loading={busy}
            data-testid="refinement-save-entry-user"
            aria-label={t('timeline.refinementSave.entryUser', { name })}
            onClick={() => void onSave('user')}
          >
            {t('timeline.refinementSave.userAction')}
          </Button>
        )}
      </div>
      {result && (
        <div className="node-body" role="status" data-testid="refinement-save-result">
          {result}
        </div>
      )}
    </>
  )
}
