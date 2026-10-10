import type { FeedbackItem, FeedbackTarget } from '@agnes/protocol/gen/app-server'
import {
  Button,
  Field,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { feedbackRequest } from './api.js'
import { feedbackCategories, useFeedbackText } from './feedback-locale.js'

export function MessageFeedback({
  sessionId,
  target,
  openEvidence,
}: {
  sessionId: string
  target: FeedbackTarget
  openEvidence(candidateId: string): void
}) {
  const { t } = useFeedbackText()
  const [item, setItem] = useState<FeedbackItem>()
  const [rating, setRating] = useState<'up' | 'down'>('up')
  const [category, setCategory] = useState<FeedbackItem['category']>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(target.messageSeq === null)
  const [reload, setReload] = useState(0)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const { messageSeq, turn } = target
  const changed = !!item && (rating !== item.rating || category !== item.category || note !== item.note)
  useEffect(() => {
    void reload
    const abort = new AbortController()
    lifetime.current = abort
    setItem(undefined)
    setBusy(true)
    setError(false)
    setStatus('')
    void feedbackRequest({ action: 'list', sessionId }, abort.signal)
      .then((result) => {
        const current = result.items.find(
          (value) => value.target.messageSeq === messageSeq && value.target.turn === turn,
        )
        if (abort.signal.aborted) return
        setItem(current)
        setRating(current?.rating ?? 'up')
        setCategory(current?.category ?? '')
        setNote(current?.note ?? '')
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [sessionId, messageSeq, turn, reload])
  async function mutate(action: 'put' | 'withdraw' | 'generate', selected = rating) {
    if (busy || error) return
    const signal = lifetime.current?.signal
    setBusy(true)
    setStatus('')
    setError(false)
    try {
      const result = await feedbackRequest(
        {
          action,
          sessionId,
          target,
          ...(item ? { id: item.id } : {}),
          expectedRevision: item?.revision ?? null,
          ...(action === 'put' ? { rating: selected, category, note } : {}),
        },
        signal,
      )
      if (signal?.aborted) return
      const current = result.items.find(
        (value) => value.target.messageSeq === target.messageSeq && value.target.turn === target.turn,
      )
      setItem(current)
      setRating(current?.rating ?? selected)
      setStatus(action === 'generate' ? 'draft' : action === 'withdraw' ? 'withdrawn' : 'saved')
    } catch {
      if (!signal?.aborted) setError(true)
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }
  const eligible =
    item &&
    !item.withdrawn &&
    target.messageSeq !== null &&
    (item.rating === 'down' || (item.rating === 'up' && item.category === 'do-again'))
  return (
    <section
      className="agnes-message-feedback"
      aria-label={t(target.messageSeq === null ? 'session' : 'title')}
      data-testid={target.messageSeq === null ? 'session-feedback' : 'message-feedback'}
    >
      <fieldset className="agnes-settings-actions feedback-actions" aria-label={t('title')}>
        {(['up', 'down'] as const).map((value) => (
          <Button
            key={value}
            size="small"
            type="text"
            aria-label={t(value)}
            title={t(value)}
            data-testid={`feedback-${value}`}
            aria-pressed={item?.withdrawn === false && item.rating === value}
            disabled={busy || error}
            onClick={() => {
              setExpanded(true)
              setRating(value)
              void mutate('put', value)
            }}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                transform={value === 'down' ? 'rotate(180 12 12)' : undefined}
                d="M7 10v11H3V10ZM7 10l5-7c2 0 2 2 2 3l-1 4h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"
              />
            </svg>
          </Button>
        ))}
        <Button
          size="small"
          type="text"
          aria-label={t('note')}
          title={t('note')}
          data-testid="feedback-details"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16v16H4ZM8 8h8M8 12h8M8 16h5" />
          </svg>
        </Button>
      </fieldset>
      {expanded && (
        <>
          <Field label={t('category')}>
            <SettingsSelect
              aria-label={t('category')}
              data-testid="feedback-category"
              value={category}
              disabled={busy}
              onChange={(e) => setCategory(e.target.value as FeedbackItem['category'])}
            >
              {feedbackCategories.map((value) => (
                <option key={value} value={value}>
                  {t(`category.${value}`)}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          <Field label={t('note')}>
            <SettingsTextArea
              aria-label={t('note')}
              data-testid="feedback-note"
              maxLength={4000}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <SettingsToolbar>
            <Button data-testid="feedback-save" disabled={busy || error} onClick={() => void mutate('put')}>
              {t('save')}
            </Button>
            {item && !item.withdrawn && (
              <Button
                data-testid="feedback-withdraw"
                disabled={busy || error}
                onClick={() => void mutate('withdraw')}
              >
                {t('withdraw')}
              </Button>
            )}
          </SettingsToolbar>
          <p>{t('privacy')}</p>
        </>
      )}
      {eligible && (
        <Button
          data-testid="feedback-generate"
          disabled={busy || changed || error}
          onClick={() => void mutate('generate')}
        >
          {t(busy ? 'generating' : 'generate')}
        </Button>
      )}
      {item?.candidateId && (
        <Button data-testid="feedback-evidence" onClick={() => openEvidence(item.candidateId ?? '')}>
          {t('evidence')}
        </Button>
      )}
      <SettingsState
        hidden={!error && !status}
        tone={error ? 'error' : 'success'}
        role={error ? 'alert' : 'status'}
      >
        {error ? t('error') : status ? t(status) : ''}
      </SettingsState>
      {error && <Button onClick={() => setReload((value) => value + 1)}>{t('reload')}</Button>}
    </section>
  )
}
