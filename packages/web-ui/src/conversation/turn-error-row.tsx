import type { UITurn } from '@agnes/protocol'
import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import type { Translate } from '../locales/index.js'
import { Button } from '../ui/button.js'
import { Disclosure } from '../ui/disclosure.js'
import { Icon } from '../ui/icon.js'
import { turnErrorMessageFacts, turnErrorView } from './turn-error.js'

/** Host operations the error row offers: send the same input again, or open where it is fixed. */
export interface TurnErrorActions {
  onRetry?: (turn: UITurn) => void | Promise<void>
  onOpenSettings?: (target: 'account' | 'model') => void
  /** Why retry cannot run right now (a turn is running, the connection is offline). */
  retryDisabledReason?: string
  /** Included in the copied detail so a report can be traced back to its session. */
  sessionId?: string
}

export interface TurnErrorRowProps {
  turn: UITurn
  t: Translate
  actions?: TurnErrorActions | undefined
}

const COPIED_MS = 1600

/**
 * The failure line under a turn: one sentence of what happened, the two safe facts from the
 * redacted message, the actions that fit this kind of failure, and the raw record one level down.
 */
export function TurnErrorRow({ turn, t, actions }: TurnErrorRowProps) {
  const view = turnErrorView(turn)
  const facts = turnErrorMessageFacts(view.detail?.message)
  const detail = view.detail
  const retry = view.actions.includes('retry') ? actions?.onRetry : undefined
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const onRetry = () => {
    if (!retry || pending.current) return
    pending.current = true
    setBusy(true)
    const clear = () => {
      pending.current = false
      setBusy(false)
    }
    try {
      void Promise.resolve(retry(turn)).finally(clear)
    } catch {
      clear()
    }
  }
  const factLine = facts.requestId
    ? t('turn.error.meta', { status: facts.status ?? '', requestId: facts.requestId })
    : facts.status
      ? t('turn.error.metaStatus', { status: facts.status })
      : ''
  const copyLines = detail
    ? [
        `${t('turn.error.detail.code')}: ${detail.code ?? ''}`,
        `${t('turn.error.detail.reason')}: ${detail.reason ?? ''}`,
        `${t('turn.error.detail.message')}: ${detail.message ?? ''}`,
        `${t('turn.error.detail.turn')}: ${turn.id}`,
        ...(actions?.sessionId ? [`${t('turn.error.detail.session')}: ${actions.sessionId}`] : []),
      ]
    : []

  return (
    <>
      <div className="turn-error" role="alert">
        <Icon className="turn-error-icon" name="circle-alert" size={16} />
        <div className="turn-error-copy">
          <p className="turn-error-sentence">{t(`turn.error.class.${view.kind}`)}</p>
          {factLine && <p className="turn-error-meta">{factLine}</p>}
        </div>
        <div className="turn-error-actions">
          {view.actions.includes('retry') && retry && (
            <Button
              htmlType="button"
              appearance="ghost"
              size="small"
              title={t('turn.error.action.retryTitle')}
              loading={busy}
              {...(actions?.retryDisabledReason
                ? { disabled: true, disabledReason: actions.retryDisabledReason }
                : {})}
              onClick={onRetry}
            >
              {t('turn.error.action.retry')}
            </Button>
          )}
          {view.actions.includes('account') && actions?.onOpenSettings && (
            <Button
              htmlType="button"
              appearance="ghost"
              size="small"
              onClick={() => actions.onOpenSettings?.('account')}
            >
              {t('turn.error.action.account')}
            </Button>
          )}
          {view.actions.includes('model') && actions?.onOpenSettings && (
            <Button
              htmlType="button"
              appearance="ghost"
              size="small"
              onClick={() => actions.onOpenSettings?.('model')}
            >
              {t('turn.error.action.model')}
            </Button>
          )}
        </div>
      </div>
      {detail && (
        <Disclosure
          variant="plain"
          className="turn-error-detail"
          data-testid="turn-error-detail"
          summary={t('turn.error.detail.label')}
        >
          <div className="turn-error-detail-body">
            <pre>{copyLines.join('\n')}</pre>
            <Button
              htmlType="button"
              appearance="ghost"
              size="small"
              icon={<Icon name="copy" size={16} />}
              onClick={() => {
                void copyText(copyLines.join('\n'), document).then((ok) => {
                  if (!ok) return
                  if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
                  setCopied(true)
                  copiedTimer.current = setTimeout(() => {
                    copiedTimer.current = undefined
                    setCopied(false)
                  }, COPIED_MS)
                })
              }}
            >
              {copied ? t('turn.error.detail.copied') : t('turn.error.detail.copy')}
            </Button>
          </div>
        </Disclosure>
      )}
    </>
  )
}
