import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  ComparisonMetricsResult,
} from '@agnes/protocol'
import { createComparisonPriceDetails, type PriceDetailsLoader } from './comparison-price-details.js'
import { createComparisonResults } from './comparison-results.js'
import type { Translate } from './jev-locale.js'

const tokenLabelKeys: Record<keyof ComparisonAccountingFamily['tokens'], string> = {
  inputUncached: 'metrics.token.inputUncached',
  cacheRead: 'metrics.token.cacheRead',
  cacheWrite: 'metrics.token.cacheWrite',
  output: 'metrics.token.output',
  reasoning: 'metrics.token.reasoning',
  inputTotal: 'metrics.token.inputTotal',
  total: 'metrics.token.total',
}

const purposeKeys: Record<string, string> = {
  inference: 'metrics.purpose.inference',
  decision: 'metrics.purpose.decision',
  parameters: 'metrics.purpose.parameters',
  arbitration: 'metrics.purpose.arbitration',
  answer: 'metrics.purpose.answer',
  compaction: 'metrics.purpose.compaction',
  title: 'metrics.purpose.title',
  media: 'metrics.purpose.media',
  unknown: 'metrics.purpose.unknown',
}

const sideLabelKeys = { left: 'metrics.side.left', right: 'metrics.side.right' } as const
const sideShortKeys = { left: 'metrics.side.short.left', right: 'metrics.side.short.right' } as const
const familyKeys = { jev: 'metrics.family.jev', llm: 'metrics.family.llm' } as const

function labelFor(keys: Record<string, string>, name: string, t: Translate): string {
  const key = keys[name]
  return key === undefined ? name : t(key)
}

function amount(total: ComparisonAccountingTotal | undefined, t: Translate): string {
  if (total === undefined) return t('metrics.unknown')
  if (total.state === 'complete' && total.value !== null) return String(total.value)
  if (total.state === 'partial' && total.knownSubtotal !== null)
    return t('metrics.partialSubtotal', { value: total.knownSubtotal, missing: total.missing })
  return t('metrics.unknown')
}

/** Equivalent fixed-cut replies must not retire expanded detail readers during polling. */
function metricsSignature(value: ComparisonMetricsResult): string {
  return JSON.stringify(
    { ...value, lanes: [...value.lanes].sort((left, right) => left.side.localeCompare(right.side)) },
    (key, item: unknown) => {
      if (key === 'issues' && Array.isArray(item)) return [...item].sort()
      if (item !== null && typeof item === 'object' && !Array.isArray(item))
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      return item
    },
  )
}

/** Render the wire accounting verbatim; rates, baseline windows and missing values stay backend-owned. */
export function createComparisonMetrics(
  host: HTMLElement,
  loadPriceDetails: PriceDetailsLoader | undefined,
  t: Translate,
) {
  const results = createComparisonResults(host, t)
  const panel = document.createElement('details')
  panel.className = 'comparison-metrics'
  panel.open = false
  const title = document.createElement('summary')
  title.textContent = t('metrics.title.loading')
  const note = document.createElement('p')
  note.setAttribute('role', 'status')
  const body = document.createElement('div')
  body.className = 'comparison-metrics-lanes'
  panel.append(title, note, body)
  host.append(panel)
  let detailReaders: ReturnType<typeof createComparisonPriceDetails>[] = []
  const clearReaders = () => {
    for (const reader of detailReaders) reader.dispose()
    detailReaders = []
  }
  let applied: number | undefined
  let appliedTitle: string | undefined
  let appliedSignature: string | undefined
  return {
    loading(seq: number) {
      results.loading(seq)
      title.textContent = t('metrics.title.syncing', {
        title: appliedTitle ?? t('metrics.title.fallback'),
        seq,
      })
      note.textContent =
        applied === undefined
          ? t('metrics.note.syncing', { seq })
          : t('metrics.note.syncingStale', { seq, applied })
    },
    unavailable(reason: string) {
      results.unavailable(reason)
      title.textContent = t('metrics.title.unavailable', {
        title: appliedTitle ?? t('metrics.title.fallback'),
      })
      note.textContent = reason
    },
    render(value: ComparisonMetricsResult) {
      applied = value.atSeq
      const state = (value: string) =>
        value === 'complete'
          ? t('metrics.state.complete')
          : value === 'partial'
            ? t('metrics.state.partial')
            : t('metrics.state.unknown')
      const brief = value.lanes
        .map(
          (lane) =>
            t('metrics.brief.lane', {
              side: t(sideShortKeys[lane.side]),
              jev: lane.accounting.jev.attempts,
              llm: lane.accounting.llm.attempts,
              state: state(lane.accounting.state),
            }),
        )
        .join(' · ')
      title.textContent = `${t('metrics.title.journal', { n: value.atSeq })}${brief ? ` · ${brief}` : ''}`
      appliedTitle = title.textContent
      note.textContent = t('metrics.note.render')
      panel.dataset.atSeq = String(value.atSeq)
      const signature = metricsSignature(value)
      const rebuild = signature !== appliedSignature
      if (rebuild) {
        appliedSignature = signature
        clearReaders()
        body.replaceChildren()
      }
      results.render(value, rebuild)
      if (!rebuild) return
      for (const side of ['left', 'right'] as const) {
        const section = document.createElement('section')
        section.dataset.side = side
        const heading = document.createElement('h4')
        const lane = value.lanes.find((item) => item.side === side)
        heading.textContent = lane
          ? `${t(sideLabelKeys[side])} · ${lane.runtime.id}@${lane.runtime.version}`
          : `${t(sideLabelKeys[side])} · ${t('metrics.noSessionBinding')}`
        section.append(heading)
        if (lane) {
          const window = document.createElement('p')
          window.textContent = t('metrics.window', {
            after: lane.accounting.afterSeq,
            through: lane.accounting.throughSeq,
            count: lane.members?.length ?? 1,
            tree: lane.treeComplete === true ? t('metrics.tree.complete') : t('metrics.tree.incomplete'),
            state: state(lane.accounting.state),
          })
          section.append(window)
          for (const family of ['jev', 'llm'] as const) {
            const accounting = lane.accounting[family]
            const label = document.createElement('h5')
            label.textContent = t('metrics.familyLabel', {
              family: t(familyKeys[family]),
              count: accounting.attempts,
            })
            const list = document.createElement('dl')
            list.dataset.family = family
            const row = (name: string, text: string) => {
              const key = document.createElement('dt')
              key.textContent = name
              const value = document.createElement('dd')
              value.textContent = text
              list.append(key, value)
            }
            for (const [bucket, tokenKey] of Object.entries(tokenLabelKeys))
              row(t(tokenKey), amount(accounting.tokens[bucket as keyof typeof tokenLabelKeys], t))
            for (const [currency, total] of Object.entries(accounting.costs))
              row(t('metrics.cost.currency', { currency }), amount(total, t))
            if (Object.keys(accounting.costs).length === 0)
              row(
                t('metrics.cost.none'),
                accounting.attempts === 0 ? t('metrics.cost.noRequests') : t('metrics.cost.noEvidence'),
              )
            row(
              t('metrics.currentPrice'),
              accounting.currentPriceAttempts === undefined
                ? t('metrics.unknown')
                : String(accounting.currentPriceAttempts),
            )
            row(t('metrics.unpriced'), String(accounting.unpricedAttempts))
            const outcomes = (counts: NonNullable<typeof accounting.outcomes>) =>
              t('metrics.outcomes', {
                completed: counts.completed,
                failed: counts.failed,
                cancelled: counts.cancelled,
                pending: counts.pending,
                unknown: counts.unknown,
              })
            row(
              t('metrics.outcomesRow'),
              accounting.outcomes ? outcomes(accounting.outcomes) : t('metrics.outcomesUnknown'),
            )
            if (accounting.byPurpose)
              for (const [purpose, value] of Object.entries(accounting.byPurpose))
                row(
                  t('metrics.purposeRow', { purpose: labelFor(purposeKeys, purpose, t) }),
                  t('metrics.purposeValue', { attempts: value.attempts, outcomes: outcomes(value.outcomes) }),
                )
            const billing = accounting.reportedBilling
            if (billing) {
              for (const source of ['gateway', 'estimated'] as const) {
                const report = billing[source]
                const billingLabel = source === 'gateway' ? t('metrics.billing.gateway') : t('metrics.billing.estimated')
                row(
                  t('metrics.billing.amount', { label: billingLabel }),
                  report.attempts === 0 && report.usdMicros.state === 'complete'
                    ? t('metrics.billing.noReports')
                    : amount(report.usdMicros, t),
                )
                row(
                  t('metrics.billing.coverage', { label: billingLabel }),
                  t('metrics.billing.coverageValue', {
                    attempts: report.attempts,
                    subscription: report.subscriptionAttempts,
                    nonSubscription: report.nonSubscriptionAttempts,
                  }),
                )
              }
              row(t('metrics.billing.missingRow'), String(billing.missingAttempts))
            } else row(t('metrics.billing.amountRow'), t('metrics.outcomesUnknown'))
            section.append(label, list)
          }
          if (lane.accounting.issues.length > 0) {
            const issues = document.createElement('details')
            const summary = document.createElement('summary')
            summary.textContent = t('metrics.issues')
            const raw = document.createElement('pre')
            raw.textContent = lane.accounting.issues.join('\n')
            issues.append(summary, raw)
            section.append(issues)
          }
        }
        if (lane && loadPriceDetails) {
          if (lane.members?.length)
            for (const member of lane.members)
              detailReaders.push(
                createComparisonPriceDetails(
                  section,
                  value,
                  {
                    ...lane,
                    sessionId: member.sessionId,
                    runtime: member.runtime,
                    accounting: member.accounting,
                  },
                  loadPriceDetails,
                  member.sessionId === lane.sessionId ? undefined : member.sessionId,
                  t,
                ),
              )
          else
            detailReaders.push(
              createComparisonPriceDetails(section, value, lane, loadPriceDetails, undefined, t),
            )
        }
        body.append(section)
      }
    },
    reset() {
      results.reset()
      clearReaders()
      applied = undefined
      appliedTitle = undefined
      appliedSignature = undefined
      delete panel.dataset.atSeq
      title.textContent = t('metrics.title.loading')
      note.textContent = ''
      body.replaceChildren()
    },
  }
}
