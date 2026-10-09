import type { FeedbackItem, FeedbackTarget } from '@agnes/protocol/gen/app-server'
import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { Button, Field, SettingsSelect, SettingsTextArea } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { feedbackRequest } from './api.js'
import { feedbackCategories, useFeedbackText } from './locales.js'

export function MessageFeedback({ sessionId, target }: { sessionId: string; target: FeedbackTarget }) {
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
  const targetKey = JSON.stringify(target)
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
          (value) => value.target.messageSeq === target.messageSeq && value.target.turn === target.turn,
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
  }, [sessionId, targetKey, reload])
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
      aria-label={t(target.messageSeq === null ? 'session' : 'title')}
      data-testid={target.messageSeq === null ? 'session-feedback' : 'message-feedback'}
    >
      <fieldset aria-label={t('title')}>
        {(['up', 'down'] as const).map((value) => (
          <Button
            key={value}
            size="small"
            data-testid={`feedback-${value}`}
            aria-pressed={item?.withdrawn === false && item.rating === value}
            disabled={busy || error}
            onClick={() => {
              setExpanded(true)
              setRating(value)
              void mutate('put', value)
            }}
          >
            {t(value)}
          </Button>
        ))}
        <Button
          size="small"
          data-testid="feedback-details"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t('note')}
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
        <Button
          data-testid="feedback-evidence"
          onClick={() => {
            if (
              !factChainLinks.open({
                sessionId,
                laneId: 'main',
                anchor: { kind: 'authoring', candidateId: item.candidateId ?? '' },
              })
            )
              workbenchNavigation.open('facts')
          }}
        >
          {t('evidence')}
        </Button>
      )}
      <p role={error ? 'alert' : 'status'}>{error ? t('error') : status ? t(status) : ''}</p>
      {error && <Button onClick={() => setReload((value) => value + 1)}>{t('reload')}</Button>}
    </section>
  )
}
