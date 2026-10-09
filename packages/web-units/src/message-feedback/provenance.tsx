import type { FeedbackGrowth, FeedbackItem } from '@agnes/protocol/gen/app-server'
import { Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { feedbackRequest } from './api.js'
import { useFeedbackText } from './feedback-locale.js'

export function FeedbackProvenance({ sessionId, candidateId }: { sessionId: string; candidateId?: string }) {
  const { t } = useFeedbackText()
  const [growth, setGrowth] = useState<FeedbackGrowth[]>([])
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [reload, setReload] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void reload
    const abort = new AbortController()
    setGrowth([])
    setFailed(false)
    void feedbackRequest({ action: 'list', sessionId }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setGrowth(value.growth)
          setItems(value.items)
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true)
      })
    return () => abort.abort()
  }, [sessionId, reload])
  const entries = growth.filter((item) => !candidateId || item.candidateId === candidateId)
  if (!entries.length && !failed) return null
  return (
    <section aria-label={t('chain')} data-testid="feedback-provenance">
      <h3>{t('chain')}</h3>
      <Button size="small" data-testid="feedback-refresh-provenance" onClick={() => setReload((v) => v + 1)}>
        {t('refreshChain')}
      </Button>
      {failed && <p role="alert">{t('error')}</p>}
      {entries.map((item) => (
        <ol key={item.candidateId}>
          <li>
            {t('source')}: {item.feedbackId} · {item.feedbackRevision} → {item.messageSeq}
          </li>
          <li>
            {t('candidate')}: {item.packageId || item.candidateId}
          </li>
          <li>
            {t('review')}:{' '}
            {t(
              item.state === 'unavailable'
                ? 'unavailable'
                : item.state === 'published'
                  ? 'approved'
                  : item.state === 'rejected'
                    ? 'rejected'
                    : 'pending',
            )}
            {item.reviewer ? ` · ${item.reviewer}` : ''}
          </li>
          <li>
            {t('published')}:{' '}
            {item.state === 'published' ? `${item.packageId}@${item.version}` : t('pending')}
          </li>
          <li>
            <details>
              <summary>{t('details')}</summary>
              <p>
                {t('draftHash')}:{' '}
                {items.find((value) => value.id === item.feedbackId && value.candidateId === item.candidateId)
                  ?.candidateHash ?? '—'}
              </p>
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </details>
          </li>
        </ol>
      ))}
    </section>
  )
}
