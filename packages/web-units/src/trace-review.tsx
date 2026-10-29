import { AutoReviewConfig, type ToolReviewFact, validateAgainst } from '@agnes/protocol'
import { Button, fallbackT, reportSuccess, StatusMessage } from '@agnes/web-ui'
import { useState } from 'react'
import { traceText } from './trace-locale.js'

const REVIEW_ENDPOINT = '/admin/api/auto-review'

/**
 * Saves an explicit rule for future calls of this tool with this exact scope. It never edits the
 * recorded review: the past stays as it was, and the rule replaces any earlier one for the scope.
 */
export async function saveFutureRule(
  name: string,
  review: ToolReviewFact,
  decision: 'allow' | 'deny' | 'escalate',
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(REVIEW_ENDPOINT, { credentials: 'same-origin', cache: 'no-store' })
  const value: unknown = await response.json()
  if (!response.ok || !validateAgainst(AutoReviewConfig, value).ok) throw new Error('Unavailable')
  const config = value as AutoReviewConfig
  const overrides = (config.overrides ?? []).filter(
    (rule) => rule.tool !== name || rule.scopeHash !== review.scopeHash,
  )
  overrides.push({ tool: name, scopeHash: review.scopeHash, decision, risk: review.risk })
  const saved = await request(REVIEW_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, overrides }),
  })
  if (!saved.ok) throw new Error('Unavailable')
}

/** The authorization decision for a call and the three future-call rules: allow, ask me, deny. */
export function TraceReview({ name, review }: { name: string; review: ToolReviewFact }) {
  const [message, setMessage] = useState<'failed' | undefined>()
  const [busy, setBusy] = useState(false)
  const [failedDecision, setFailedDecision] = useState<'allow' | 'deny' | 'escalate'>('escalate')
  const save = async (decision: 'allow' | 'deny' | 'escalate') => {
    setBusy(true)
    try {
      await saveFutureRule(name, review, decision)
      setMessage(undefined)
      reportSuccess('future-rule', traceText('trace.facts.ruleSaved'))
    } catch {
      setFailedDecision(decision)
      setMessage('failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="trace-review" data-testid="review-evidence">
      <p className="trace-card-line" data-testid="reviewer-decision">
        <strong>{traceText('trace.facts.authorization')}</strong>{' '}
        {traceText(
          review.source === 'human-override'
            ? 'trace.facts.reviewHumanRule'
            : review.decision === 'allow'
              ? 'trace.facts.reviewAllowed'
              : review.decision === 'deny'
                ? 'trace.facts.reviewDenied'
                : 'trace.facts.reviewEscalated',
        )}
        : {review.reason}
      </p>
      <p className="trace-raw-note">
        {traceText('trace.facts.reviewer', {
          model: review.model,
          ms: review.latencyMs.toFixed(0),
          cost: review.cost,
          source: traceText(
            review.costSource === 'gateway'
              ? 'trace.value.gateway'
              : review.costSource === 'estimated'
                ? 'trace.value.estimated'
                : 'trace.provenance.unknown',
          ),
        })}
      </p>
      <dl data-testid="review-scope-preview">
        <dt>{traceText('trace.facts.scopeArgs')}</dt>
        <dd>
          <pre>{review.scopePreview?.args ?? traceText('trace.provenance.unknown')}</pre>
        </dd>
        <dt>{traceText('trace.facts.scopeDirectory')}</dt>
        <dd>{review.scopePreview?.cwd ?? traceText('trace.provenance.unknown')}</dd>
        <dt>{traceText('trace.facts.scopeMode')}</dt>
        <dd>{review.scopePreview?.mode ?? traceText('trace.provenance.unknown')}</dd>
      </dl>
      <div className="trace-review-rules">
        <span>{traceText('trace.facts.future')}</span>
        {review.risk !== 'high' ? (
          <Button
            size="small"
            data-testid="review-future-allow"
            loading={busy}
            disabled={busy}
            onClick={() => void save('allow')}
          >
            {traceText('trace.facts.futureAllow')}
          </Button>
        ) : null}
        <Button
          size="small"
          data-testid="review-future-ask"
          loading={busy}
          disabled={busy}
          onClick={() => void save('escalate')}
        >
          {traceText('trace.facts.futureAsk')}
        </Button>
        <Button
          size="small"
          data-testid="review-future-deny"
          loading={busy}
          disabled={busy}
          onClick={() => void save('deny')}
        >
          {traceText('trace.facts.futureDeny')}
        </Button>
      </div>
      {message ? (
        <StatusMessage
          kind="error"
          action={{ label: fallbackT('ui.retry'), onSelect: () => void save(failedDecision), busy }}
        >
          {traceText('trace.facts.ruleFailed')}
        </StatusMessage>
      ) : null}
    </section>
  )
}
