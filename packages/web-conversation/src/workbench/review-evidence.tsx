import { AutoReviewConfig, type ToolReviewFact, validateAgainst } from '@agnes/protocol'
import { Button } from '@agnes/web-ui'
import { useState } from 'react'

/** A save is an explicit human rule, never a mutation of the past reviewer fact. */
export function ReviewEvidence({
  name,
  review,
  t,
}: {
  name: string
  review: ToolReviewFact
  t: (key: string) => string
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function override(decision: 'allow' | 'deny' | 'escalate') {
    setBusy(true)
    try {
      const response = await fetch('/admin/api/auto-review', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const value: unknown = await response.json()
      if (!response.ok || !validateAgainst(AutoReviewConfig, value).ok) throw new Error('Unavailable')
      const config = value as AutoReviewConfig
      const overrides = (config.overrides ?? []).filter(
        (rule) => rule.tool !== name || rule.scopeHash !== review.scopeHash,
      )
      overrides.push({ tool: name, scopeHash: review.scopeHash, decision, risk: review.risk })
      const saved = await fetch('/admin/api/auto-review', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, overrides }),
      })
      if (!saved.ok) throw new Error('Unavailable')
      setMessage('facts.ruleSaved')
    } catch {
      setMessage('facts.ruleFailed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section data-testid="review-evidence">
      <p data-testid="reviewer-decision">
        {t(
          review.source === 'human-override'
            ? 'facts.reviewHumanRule'
            : review.decision === 'allow'
              ? 'facts.reviewAllowed'
              : review.decision === 'deny'
                ? 'facts.reviewDenied'
                : 'facts.reviewEscalated',
        )}
        : {review.reason}
      </p>
      <p>
        {review.model} · {review.latencyMs.toFixed(0)} ms · {review.cost} (
        {t(`facts.cost.${review.costSource}`)})
      </p>
      {review.risk !== 'high' && (
        <Button data-testid="review-future-allow" disabled={busy} onClick={() => void override('allow')}>
          {t('facts.futureAllow')}
        </Button>
      )}
      <Button data-testid="review-future-ask" disabled={busy} onClick={() => void override('escalate')}>
        {t('facts.futureAsk')}
      </Button>
      <Button data-testid="review-future-deny" disabled={busy} onClick={() => void override('deny')}>
        {t('facts.futureDeny')}
      </Button>
      {message && <p role={message === 'facts.ruleFailed' ? 'alert' : 'status'}>{t(message)}</p>}
    </section>
  )
}
