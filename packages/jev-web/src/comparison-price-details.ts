import type {
  ComparisonMetricsResult,
  ComparisonPriceDetailsParams,
  ComparisonPriceDetailsResult,
} from '@agnes/protocol'
import type { Translate } from './jev-locale.js'

export type PriceDetailsLoader = (
  input: ComparisonPriceDetailsParams,
) => Promise<ComparisonPriceDetailsResult>

const purposeKeys: Record<string, string> = {
  inference: 'price.purpose.inference',
  decision: 'price.purpose.decision',
  parameters: 'price.purpose.parameters',
  arbitration: 'price.purpose.arbitration',
  answer: 'price.purpose.answer',
  compaction: 'price.purpose.compaction',
  title: 'price.purpose.title',
  media: 'price.purpose.media',
}

const outcomeKeys: Record<string, string> = {
  pending: 'price.outcome.pending',
  completed: 'price.outcome.completed',
  failed: 'price.outcome.failed',
  cancelled: 'price.outcome.cancelled',
  unknown: 'price.outcome.unknown',
}

const issueKeys: Record<string, string> = {
  pending: 'price.issue.pending',
  missing_quote: 'price.issue.missingQuote',
  observed_model_mismatch: 'price.issue.modelMismatch',
  quote_binding_mismatch: 'price.issue.bindingMismatch',
  invalid_price_interval: 'price.issue.intervalUnknown',
  missing_usage: 'price.issue.missingUsage',
  missing_rate: 'price.issue.missingRate',
  incomplete_evidence: 'price.issue.incompleteEvidence',
}

const bucketKeys = {
  inputUncached: 'price.bucket.inputUncached',
  cacheRead: 'price.bucket.cacheRead',
  cacheWrite: 'price.bucket.cacheWrite',
  output: 'price.bucket.output',
} as const

function labelFor(keys: Record<string, string>, name: string, t: Translate): string {
  const key = keys[name]
  return key === undefined ? name : t(key)
}

const total = (value: ComparisonPriceDetailsResult['entries'][number]['estimate'] | undefined, t: Translate) =>
  value === undefined
    ? t('price.unknown')
    : value.state === 'complete' && value.value !== null
      ? String(value.value)
      : value.knownSubtotal !== null
        ? t('price.subtotal', { value: value.knownSubtotal })
        : t('price.unknown')

/** Lazy pages belong to this exact committed cursor; disposed or older replies never render. */
export function createComparisonPriceDetails(
  host: HTMLElement,
  value: ComparisonMetricsResult,
  lane: ComparisonMetricsResult['lanes'][number],
  load: PriceDetailsLoader | undefined,
  memberSessionId: string | undefined,
  t: Translate,
) {
  const panel = document.createElement('details')
  panel.className = 'comparison-price-details'
  const summary = document.createElement('summary')
  summary.textContent = memberSessionId
    ? t('price.summary.member', { id: memberSessionId })
    : t('price.summary.parent')
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.textContent = load ? t('price.status.idle') : t('price.status.unavailable')
  const body = document.createElement('div')
  const more = document.createElement('button')
  more.type = 'button'
  more.textContent = t('price.more')
  more.hidden = true
  panel.append(summary, status, body, more)
  host.append(panel)
  let disposed = false
  let pending = false
  let loaded = false
  let afterSeq = 0
  let complete = false
  let evidenceComplete = true
  const seen = new Set<string>()
  async function read() {
    if (disposed || pending || complete || !load) return
    pending = true
    more.disabled = true
    status.textContent = t('price.status.reading', {
      at: value.atSeq,
      through: lane.accounting.throughSeq,
    })
    try {
      const page = await load({
        id: value.id,
        side: lane.side,
        atSeq: value.atSeq,
        ...(memberSessionId ? { memberSessionId } : {}),
        afterSeq,
        limit: 25,
        maxBytes: 262144,
      })
      if (disposed) return
      if (
        page.entries.length > 25 ||
        new TextEncoder().encode(JSON.stringify(page.entries)).byteLength > 262144 ||
        page.id !== value.id ||
        page.side !== lane.side ||
        page.atSeq !== value.atSeq ||
        page.sessionId !== lane.sessionId ||
        page.runtime.id !== lane.runtime.id ||
        page.runtime.version !== lane.runtime.version ||
        page.throughSeq !== lane.accounting.throughSeq ||
        page.afterSeq !== afterSeq ||
        page.nextAfterSeq > page.throughSeq ||
        (!page.complete && page.nextAfterSeq <= afterSeq) ||
        (page.complete && page.nextAfterSeq !== page.throughSeq)
      )
        throw new Error('报价详情返回了不同的前缀或缺失分页进度')
      let previous = afterSeq
      for (const entry of page.entries) {
        if (
          entry.originSeq <= previous ||
          entry.originSeq > page.throughSeq ||
          (entry.settledSeq !== null &&
            (entry.settledSeq < entry.originSeq || entry.settledSeq > page.throughSeq)) ||
          seen.has(entry.attemptId)
        )
          throw new Error('报价详情的请求坐标冲突')
        previous = entry.originSeq
      }
      if (!page.complete && page.nextAfterSeq !== previous) throw new Error('报价详情分页跳过了请求')
      for (const entry of page.entries) {
        seen.add(entry.attemptId)
        const row = document.createElement('section')
        const heading = document.createElement('h5')
        heading.textContent = t('price.entry.heading', {
          family: entry.family === 'jev' ? t('price.family.jev') : t('price.family.llm'),
          purpose:
            entry.purpose === null
              ? t('price.purpose.unknown')
              : labelFor(purposeKeys, entry.purpose, t),
          seq: entry.originSeq,
        })
        const model = document.createElement('p')
        model.textContent = t('price.entry.model', {
          route: entry.route ?? t('price.route.unknown'),
          model: entry.model ?? t('price.model.unknown'),
          observed: entry.observedModel ?? t('price.model.unknown'),
          outcome: t(outcomeKeys[entry.outcome] ?? 'price.outcome.unknown'),
        })
        row.append(heading, model)
        const quote = entry.quote
        const price = document.createElement('p')
        price.textContent = quote
          ? t('price.quote', {
              basis:
                entry.priceBasis === 'current'
                  ? t('price.basis.current')
                  : quote.basis === 'configured'
                    ? t('price.basis.configured')
                    : t('price.basis.catalog'),
              currency: quote.policy.currency,
              multiplier: entry.multiplier ?? t('price.unknown'),
              time: new Date(quote.admittedAt).toISOString(),
            })
          : t('price.quote.none')
        row.append(price)
        if (quote) {
          const rates = document.createElement('p')
          rates.textContent = Object.entries(bucketKeys)
            .map(
              ([bucket, key]) =>
                `${t(key)} ${quote.policy.perMillion[bucket as keyof typeof bucketKeys] ?? t('price.unknown')}`,
            )
            .join(' · ')
          row.append(rates)
          if (quote.policy.source) {
            const source = document.createElement('p')
            source.textContent = t('price.source', { checkedAt: quote.policy.source.checkedAt })
            // Rendering cannot make an untrusted persisted URL executable.
            const link = document.createElement('a')
            link.textContent = quote.policy.source.url
            if (quote.policy.source.url.startsWith('https://')) {
              link.href = quote.policy.source.url
              link.target = '_blank'
              link.rel = 'noopener noreferrer'
            }
            source.append(link)
            row.append(source)
          }
          const policy = document.createElement('details')
          const caption = document.createElement('summary')
          caption.textContent =
            entry.priceBasis === 'current'
              ? t('price.policy.current')
              : t('price.policy.historical')
          const raw = document.createElement('pre')
          raw.textContent = JSON.stringify(
            {
              validFrom: quote.policy.validFrom ?? null,
              validUntil: quote.policy.validUntil ?? null,
              offPeak: quote.policy.offPeak ?? null,
            },
            null,
            2,
          )
          policy.append(caption, raw)
          row.append(policy)
        }
        const amounts = document.createElement('p')
        const amountKeys = entry.bucketCosts.inputTotal
          ? { inputTotal: 'price.bucket.inputTotal', output: 'price.bucket.output' }
          : bucketKeys
        amounts.textContent = `${Object.entries(amountKeys)
          .map(
            ([bucket, key]) =>
              `${t(key)} ${total(entry.tokens[bucket as keyof typeof entry.bucketCosts], t)} ${t('price.token')} · ${t('price.cost')} ${total(entry.bucketCosts[bucket as keyof typeof entry.bucketCosts], t)}`,
          )
          .join(
            ' · ',
          )} · ${entry.priceBasis === 'current' ? t('price.basis.currentReprice') : t('price.basis.historical')} ${total(entry.estimate, t)}${quote ? ` ${quote.policy.currency}` : ''}`
        row.append(amounts)
        const reasoning = document.createElement('p')
        reasoning.textContent = t('price.reasoning', {
          total: total(entry.tokens.reasoning, t),
        })
        row.append(reasoning)
        const billing = document.createElement('p')
        billing.textContent = entry.reportedBilling
          ? t('price.billing.reported', {
              source:
                entry.reportedBilling.source === 'gateway'
                  ? t('price.billing.gateway')
                  : t('price.billing.estimated'),
              amount: entry.reportedBilling.usdMicros,
              subscription: entry.reportedBilling.subscription
                ? t('price.subscription.yes')
                : t('price.subscription.no'),
            })
          : t('price.billing.unknown')
        row.append(billing)
        if (entry.issues.length) {
          const issue = document.createElement('details')
          const caption = document.createElement('summary')
          caption.textContent = t('price.issues.caption', {
            reasons: entry.issues
              .map((code) => {
                const key = issueKeys[code]
                return key === undefined ? t('price.issue.invalid') : t(key)
              })
              .join('、'),
          })
          const raw = document.createElement('pre')
          raw.textContent = entry.issues.join('\n')
          issue.append(caption, raw)
          row.append(issue)
        }
        body.append(row)
      }
      afterSeq = page.nextAfterSeq
      complete = page.complete
      loaded = true
      evidenceComplete &&= page.evidenceComplete
      more.hidden = complete
      status.textContent = `${t('price.status.done', {
        at: value.atSeq,
        through: page.throughSeq,
        state: complete ? t('price.status.allRead') : t('price.status.more'),
      })}${evidenceComplete ? '' : t('price.status.incompleteEvidence')}${seen.size === 0 ? t('price.status.noneSeen') : ''}`
    } catch (error) {
      if (!disposed) {
        status.textContent = t('price.status.failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        more.hidden = false
      }
    } finally {
      pending = false
      more.disabled = false
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open && !loaded) void read()
  })
  more.addEventListener('click', () => void read())
  return {
    dispose() {
      disposed = true
    },
  }
}
