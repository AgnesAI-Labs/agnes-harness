import type { AdminFeedbackResult, FeedbackItem } from '@agnes/protocol/gen/app-server'
import { Button, Field, SettingsCard, SettingsInput, SettingsSelect } from '@agnes/web-ui'
import { feedbackCategories, feedbackRequest, useFeedbackText } from '@agnes/web-units/message-feedback'
import { useEffect, useState } from 'react'

export function FeedbackAdminPanel() {
  const { t } = useFeedbackText()
  const [session, setSession] = useState('')
  const [category, setCategory] = useState('all')
  const [rating, setRating] = useState('all')
  const [hasCandidate, setHasCandidate] = useState('all')
  const [result, setResult] = useState<AdminFeedbackResult>()
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    void revision
    const abort = new AbortController()
    setError(false)
    setResult(undefined)
    void feedbackRequest(
      {
        action: 'list',
        ...(session ? { sessionId: session } : {}),
        ...(category !== 'all' ? { category: category as FeedbackItem['category'] } : {}),
        ...(rating !== 'all' ? { rating: rating as FeedbackItem['rating'] } : {}),
        ...(hasCandidate !== 'all' ? { hasCandidate: hasCandidate === 'yes' } : {}),
      },
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) setResult(value)
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
    return () => abort.abort()
  }, [session, category, rating, hasCandidate, revision])
  return (
    <SettingsCard title={t('admin')} data-testid="feedback-admin">
      <p>{t('privacy')}</p>
      <Field label={t('sessionFilter')}>
        <SettingsInput
          aria-label={t('sessionFilter')}
          data-testid="feedback-session-filter"
          value={session}
          maxLength={512}
          onChange={(event) => setSession(event.target.value)}
        />
      </Field>
      <Field label={t('category')}>
        <SettingsSelect
          aria-label={t('category')}
          data-testid="feedback-category-filter"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="all">{t('all')}</option>
          {feedbackCategories.map((value) => (
            <option key={value} value={value}>
              {t(`category.${value}`)}
            </option>
          ))}
        </SettingsSelect>
      </Field>
      <Field label={t('ratingFilter')}>
        <SettingsSelect
          aria-label={t('ratingFilter')}
          data-testid="feedback-rating-filter"
          value={rating}
          onChange={(event) => setRating(event.target.value)}
        >
          <option value="all">{t('all')}</option>
          <option value="up">{t('up')}</option>
          <option value="down">{t('down')}</option>
        </SettingsSelect>
      </Field>
      <Field label={t('candidateFilter')}>
        <SettingsSelect
          aria-label={t('candidateFilter')}
          data-testid="feedback-candidate-filter"
          value={hasCandidate}
          onChange={(event) => setHasCandidate(event.target.value)}
        >
          {['all', 'yes', 'no'].map((value) => (
            <option key={value} value={value}>
              {t(value)}
            </option>
          ))}
        </SettingsSelect>
      </Field>
      <Button onClick={() => setRevision((value) => value + 1)}>{t('refresh')}</Button>
      {error && <p role="alert">{t('error')}</p>}
      {result && (
        <>
          <p data-testid="feedback-counts">{t('counts', result.counts)}</p>
          {result.truncated && <p>{t('truncated')}</p>}
          {!result.items.length && <p>{t('empty')}</p>}
          <ul>
            {result.items.map((item) => (
              <li key={item.id} data-testid="feedback-admin-item">
                <strong>{t(item.rating)}</strong> · {t(`category.${item.category}`)} · {item.sessionId} ·{' '}
                {item.actor}
                <p>{item.note}</p>
                {item.withdrawn && <p>{t('withdrawn')}</p>}
                {item.candidateId && (
                  <p>
                    {t('candidate')}: {item.candidateId}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsCard>
  )
}
