import type { AdminFeedbackResult, FeedbackItem } from '@agnes/protocol/gen/app-server'
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  SearchBar,
  SettingsPageDescription,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
  useAdvancedSettings,
} from '@agnes/web-ui'
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
  const advanced = useAdvancedSettings()
  const filtering = !!session || category !== 'all' || rating !== 'all' || hasCandidate !== 'all'
  return (
    <section data-testid="feedback-admin">
      <SettingsPageDescription>{t('privacy')}</SettingsPageDescription>
      {/* Filtering by session, category or rating is for digging; the list alone is the everyday view. */}
      {advanced || filtering ? (
        <SearchBar
          label={t('sessionFilter')}
          placeholder={t('sessionFilterPlaceholder')}
          value={session}
          onChange={setSession}
          inputProps={{ 'data-testid': 'feedback-session-filter', maxLength: 512 }}
          filters={
            <>
              <SettingsSelect
                aria-label={t('category')}
                data-testid="feedback-category-filter"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="all">
                  {t('category')} · {t('all')}
                </option>
                {feedbackCategories.map((value) => (
                  <option key={value} value={value}>
                    {t(`category.${value}`)}
                  </option>
                ))}
              </SettingsSelect>
              <SettingsSelect
                aria-label={t('ratingFilter')}
                data-testid="feedback-rating-filter"
                value={rating}
                onChange={(event) => setRating(event.target.value)}
              >
                <option value="all">
                  {t('ratingFilter')} · {t('all')}
                </option>
                <option value="up">{t('up')}</option>
                <option value="down">{t('down')}</option>
              </SettingsSelect>
              <SettingsSelect
                aria-label={t('candidateFilter')}
                data-testid="feedback-candidate-filter"
                value={hasCandidate}
                onChange={(event) => setHasCandidate(event.target.value)}
              >
                {['all', 'yes', 'no'].map((value) => (
                  <option key={value} value={value}>
                    {t('candidateFilter')} · {t(value)}
                  </option>
                ))}
              </SettingsSelect>
            </>
          }
          actions={
            <IconButton
              name="refresh-cw"
              label={t('refresh')}
              onClick={() => setRevision((value) => value + 1)}
            />
          }
        />
      ) : (
        <SettingsToolbar>
          <IconButton
            name="refresh-cw"
            label={t('refresh')}
            data-testid="feedback-refresh"
            onClick={() => setRevision((value) => value + 1)}
          />
        </SettingsToolbar>
      )}
      {!result && !error && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {error && <SettingsState tone="error">{t('error')}</SettingsState>}
      {result && (
        <>
          <p className="agnes-settings-summary" data-testid="feedback-counts">
            {t('counts', result.counts)}
          </p>
          {result.truncated && <p>{t('truncated')}</p>}
          {!result.items.length && (
            <EmptyState
              icon={<Icon name="message-square" size={20} />}
              title={t('empty')}
              description={t('emptyHelp')}
            />
          )}
          <ul className="agnes-settings-list">
            {result.items.map((item) => (
              <li className="agnes-settings-row" key={item.id} data-testid="feedback-admin-item">
                <Badge tone={item.rating === 'up' ? 'ok' : 'warn'}>{t(item.rating)}</Badge> ·{' '}
                {t(`category.${item.category}`)} · {item.sessionId} · {item.actor}
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
    </section>
  )
}
