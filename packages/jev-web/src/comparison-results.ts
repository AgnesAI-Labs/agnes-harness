import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  ComparisonMetricsResult,
} from '@agnes/protocol'
import { renderComparisonPrepared } from './comparison-prepared.js'
import type { Translate } from './jev-locale.js'

type Summary = NonNullable<ComparisonMetricsResult['summary']>
type SummaryLane = Summary['lanes'][number]
type Side = 'left' | 'right'

const SIDES: readonly Side[] = ['left', 'right']

const purposeLabelKeys: Record<string, string> = {
  inference: 'results.purpose.inference',
  decision: 'results.purpose.decision',
  parameters: 'results.purpose.parameters',
  arbitration: 'results.purpose.arbitration',
  answer: 'results.purpose.answer',
  compaction: 'results.purpose.compaction',
  title: 'results.purpose.title',
  media: 'results.purpose.media',
  unknown: 'results.purpose.unknown',
}

const purposeOrder = [
  'parameters',
  'arbitration',
  'answer',
  'inference',
  'decision',
  'compaction',
  'title',
  'media',
  'unknown',
] as const

const terminalLabelKeys: Record<SummaryLane['terminalCause'], string> = {
  finished: 'results.terminal.finished',
  cancelled: 'results.terminal.cancelled',
  failed: 'results.terminal.failed',
  unknown: 'results.terminal.unknown',
}

const sideLabelKeys: Record<Side, string> = { left: 'results.side.left', right: 'results.side.right' }

const rows = [
  { key: 'status', labelKey: 'results.row.status' },
  { key: 'elapsed', labelKey: 'results.row.elapsed' },
  { key: 'llm-uncached', labelKey: 'results.row.llmUncached' },
  { key: 'llm-cache', labelKey: 'results.row.llmCache' },
  { key: 'llm-output', labelKey: 'results.row.llmOutput' },
  { key: 'llm-cost', labelKey: 'results.row.llmCost' },
  { key: 'jev-input', labelKey: 'results.row.jevInput' },
  { key: 'jev-output', labelKey: 'results.row.jevOutput' },
  { key: 'jev-cost', labelKey: 'results.row.jevCost' },
  { key: 'cost', labelKey: 'results.row.cost' },
  { key: 'calls', labelKey: 'results.row.calls' },
  { key: 'mix', labelKey: 'results.row.mix' },
  { key: 'answer', labelKey: 'results.row.answer' },
] as const

function sideLabel(side: Side, t: Translate): string {
  return t(sideLabelKeys[side])
}

function settled(
  summary: SummaryLane | undefined,
  lane: ComparisonMetricsResult['lanes'][number] | undefined,
): boolean {
  return (
    summary?.complete === true &&
    summary.run === 'settled' &&
    lane?.accounting.state !== 'unknown' &&
    lane?.accounting.issues.length === 0
  )
}

function incomplete(summary: SummaryLane | undefined, accountingState: string | undefined): boolean {
  return summary?.complete !== true || summary.run !== 'settled' || accountingState === 'unknown'
}

const displayNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)))

function formatTotal(
  total: ComparisonAccountingTotal | undefined,
  t: Translate,
  live: boolean,
  money = false,
): string {
  const number = (value: number) =>
    money ? (value > 0 && value < 0.000001 ? '<0.000001' : value.toFixed(6)) : displayNumber(value)
  if (total === undefined) return t('results.unknown')
  if (total.state === 'complete' && total.value !== null)
    return live ? `${number(total.value)}${t('results.knownFloorSuffix')}` : number(total.value)
  if (total.state === 'partial' && total.knownSubtotal !== null)
    return t('results.partialSubtotal', { value: number(total.knownSubtotal), missing: total.missing })
  return t('results.unknown')
}

function tokenText(total: ComparisonAccountingTotal | undefined, t: Translate, live: boolean): string {
  return live && total?.value === 0 ? t('results.noConfirmedFinal') : formatTotal(total, t, live)
}

function familyText(
  family: ComparisonAccountingFamily | undefined,
  t: Translate,
  done: boolean,
  read: (family: ComparisonAccountingFamily) => string,
): string {
  if (!family) return t('results.unknown')
  if (family.attempts === 0) return done ? t('results.notApplicable') : t('results.unknown')
  return read(family)
}

function priceBasis(family: ComparisonAccountingFamily, t: Translate): string {
  return family.currentPriceAttempts
    ? t('results.currentReprice', { count: family.currentPriceAttempts })
    : ''
}

/** Format already priced backend buckets; the client never recomputes rates. */
function bucketCost(
  family: ComparisonAccountingFamily,
  t: Translate,
  bucket: 'inputUncached' | 'cacheRead' | 'inputTotal' | 'output',
  live: boolean,
): string {
  const values = Object.entries(family.bucketCosts ?? {})
    .filter(
      ([, costs]) =>
        costs[bucket] !== undefined && !(costs[bucket]?.state === 'complete' && costs[bucket]?.value === 0),
    )
    .map(([currency, costs]) => `${currency} ${formatTotal(costs[bucket], t, live, true)}`)
  return values.length ? ` · ${values.join(' / ')}` : ''
}

function multiplierNote(family: ComparisonAccountingFamily, t: Translate): string {
  const values = family.priceMultipliers
  if (family.unpricedAttempts || !values?.length) return ''
  if (values.length > 1) return t('results.multiplier.mixed')
  const m = values[0]
  return m === undefined || m === 1 ? '' : t('results.multiplier.offPeak', { m })
}

function familyCost(family: ComparisonAccountingFamily, t: Translate, live: boolean): string {
  const values = Object.entries(family.costs)
  if (!values.length) return t('results.noPriceEvidence')
  return `${values.map(([currency, total]) => `${currency} ${formatTotal(total, t, live, true)}`).join(' / ')}${multiplierNote(family, t)}${priceBasis(family, t)}`
}

function cacheHit(family: ComparisonAccountingFamily, t: Translate, live: boolean): string {
  const read = family.tokens.cacheRead
  const input = family.tokens.inputTotal
  if (
    read?.state !== 'complete' ||
    read.value === null ||
    input?.state !== 'complete' ||
    input.value === null
  )
    return t('results.hitRate.unknown')
  if (input.value === 0) return t('results.hitRate.na')
  const rate = `${((read.value / input.value) * 100).toFixed(1)}%`
  return live ? t('results.hitRate.live', { rate }) : t('results.hitRate', { rate })
}

function combinedCost(
  lane: ComparisonMetricsResult['lanes'][number] | undefined,
  t: Translate,
  live: boolean,
): string {
  if (!lane?.accounting.totalCosts) return t('results.noTotalCostEvidence')
  const values = Object.entries(lane.accounting.totalCosts)
  if (!values.length) return t('results.noPriceEvidence')
  const current =
    (lane.accounting.llm.currentPriceAttempts ?? 0) + (lane.accounting.jev.currentPriceAttempts ?? 0)
  return `${values.map(([currency, total]) => `${currency} ${formatTotal(total, t, live, true)}`).join(' / ')}${current ? t('results.currentReprice', { count: current }) : ''}`
}

function mix(
  lane: ComparisonMetricsResult['lanes'][number] | undefined,
  t: Translate,
  done: boolean,
  live: boolean,
): string {
  if (!lane) return t('results.unknown')
  const llm = lane.accounting.llm
  if (!llm.byPurpose) return t('results.unknown')
  const counts = new Map(Object.entries(llm.byPurpose).map(([purpose, value]) => [purpose, value.attempts]))
  if (counts.size === 0) {
    if (llm.attempts === 0) return done ? t('results.notApplicable') : t('results.unknown')
    return t('results.unknown')
  }
  const keys = [
    ...purposeOrder.filter((purpose) => counts.has(purpose)),
    ...[...counts.keys()]
      .filter((purpose) => !purposeOrder.includes(purpose as (typeof purposeOrder)[number]))
      .sort(),
  ]
  const text = keys
    .map((purpose) => {
      const labelKey = purposeLabelKeys[purpose]
      const label = labelKey === undefined ? purpose : t(labelKey)
      return `${label} ${counts.get(purpose)}`
    })
    .join(' · ')
  return live ? `${text}${t('results.partialSuffix')}` : text
}

function statusText(summary: SummaryLane | undefined, t: Translate): string {
  if (!summary) return t('results.unknown')
  const phases: Record<string, string> = {
    idle: t('results.phase.idle'),
    running: t('results.phase.running'),
    waiting: t('results.phase.waiting'),
    parked: t('results.phase.parked'),
    recovering: t('results.phase.recovering'),
    failed: t('results.phase.failed'),
    completed: t('results.phase.completed'),
  }
  const runs: Record<string, string> = {
    reserved: t('results.run.reserved'),
    running: t('results.run.running'),
    waiting: t('results.run.waiting'),
    settled: t('results.run.settled'),
    unknown: t('results.run.unknown'),
    none: t('results.run.none'),
  }
  const acceptances: Record<string, string> = {
    accepted: t('results.acceptance.accepted'),
    rejected: t('results.acceptance.rejected'),
    unknown: t('results.acceptance.unknown'),
    none: t('results.acceptance.none'),
  }
  return [
    phases[summary.phase] ?? t('results.statusUnknown'),
    runs[summary.run] ?? t('results.run.unknown'),
    ...(summary.run === 'settled' ? [t(terminalLabelKeys[summary.terminalCause])] : []),
    acceptances[summary.acceptance] ?? t('results.acceptance.unknown'),
  ].join(' · ')
}

function elapsedText(summary: SummaryLane | undefined, t: Translate): string {
  if (!summary || summary.elapsedMs === null) return t('results.unknown')
  const seconds = t('results.seconds', { s: (summary.elapsedMs / 1000).toFixed(1) })
  return summary.complete && summary.run === 'settled' ? seconds : t('results.elapsedLive', { seconds })
}

function cell(
  value: ComparisonMetricsResult | undefined,
  t: Translate,
  side: Side,
  key: (typeof rows)[number]['key'],
): { text: string; answer?: SummaryLane['latestAnswer'] } {
  if (!value) return { text: t('results.unknown') }
  const lane = value.lanes.find((item) => item.side === side)
  const summary = value.summary?.lanes.find((item) => item.side === side)
  const done = settled(summary, lane)
  const live = incomplete(summary, lane?.accounting.state)
  switch (key) {
    case 'status':
      return { text: statusText(summary, t) }
    case 'elapsed':
      return { text: elapsedText(summary, t) }
    case 'llm-uncached':
      return {
        text: familyText(
          lane?.accounting.llm,
          t,
          done,
          (family) =>
            `${tokenText(family.tokens.inputUncached, t, live)}${bucketCost(family, t, 'inputUncached', live)}`,
        ),
      }
    case 'llm-cache':
      return {
        text: familyText(
          lane?.accounting.llm,
          t,
          done,
          (family) =>
            `${tokenText(family.tokens.cacheRead, t, live)}${cacheHit(family, t, live)}${bucketCost(family, t, 'cacheRead', live)}`,
        ),
      }
    case 'llm-output':
      return {
        text: familyText(
          lane?.accounting.llm,
          t,
          done,
          (family) => `${tokenText(family.tokens.output, t, live)}${bucketCost(family, t, 'output', live)}`,
        ),
      }
    case 'jev-input':
      return {
        text: familyText(
          lane?.accounting.jev,
          t,
          done,
          (family) => `${tokenText(family.tokens.inputTotal, t, live)}${bucketCost(family, t, 'inputTotal', live)}`,
        ),
      }
    case 'jev-output':
      return {
        text: familyText(
          lane?.accounting.jev,
          t,
          done,
          (family) => `${tokenText(family.tokens.output, t, live)}${bucketCost(family, t, 'output', live)}`,
        ),
      }
    case 'llm-cost':
      return { text: familyText(lane?.accounting.llm, t, done, (family) => familyCost(family, t, live)) }
    case 'jev-cost':
      return { text: familyText(lane?.accounting.jev, t, done, (family) => familyCost(family, t, live)) }
    case 'cost':
      return { text: combinedCost(lane, t, live) }
    case 'calls': {
      if (!lane) return { text: t('results.unknown') }
      const llm = lane.accounting.llm.attempts
      const jev = lane.accounting.jev.attempts
      if (llm === 0 && jev === 0 && !done) return { text: t('results.unknown') }
      return {
        text: `${t('results.calls', { llm, jev })}${live ? t('results.partialSuffix') : ''}`,
      }
    }
    case 'mix':
      return { text: mix(lane, t, done, live) }
    case 'answer': {
      if (!summary) return { text: t('results.unknown') }
      if (!summary.latestAnswer)
        return { text: summary.complete && summary.run === 'settled' ? t('results.noTurnAnswer') : t('results.unknown') }
      return { text: summary.latestAnswer.text, answer: summary.latestAnswer }
    }
  }
}

function heading(value: ComparisonMetricsResult | undefined, t: Translate, side: Side): string {
  const lane = value?.lanes.find((item) => item.side === side)
  const summary = value?.summary?.lanes.find((item) => item.side === side)
  const runtime = lane
    ? `${lane.runtime.id === 'jevloop' ? 'JevLoop' : lane.runtime.id === 'native' ? 'Native LLM' : lane.runtime.id}@${lane.runtime.version}`
    : t('results.noSessionBinding')
  return `${runtime} · ${sideLabel(side, t)}${summary?.run === 'settled' ? ` · ${t(terminalLabelKeys[summary.terminalCause])}` : ''}`
}

function orderedSides(value: ComparisonMetricsResult | undefined): Side[] {
  return [...SIDES].sort(
    (a, b) =>
      Number(value?.lanes.find((lane) => lane.side === b)?.runtime.id === 'jevloop') -
      Number(value?.lanes.find((lane) => lane.side === a)?.runtime.id === 'jevloop'),
  )
}

function paintTable(table: HTMLTableElement, value: ComparisonMetricsResult | undefined, t: Translate): void {
  table.replaceChildren()
  const caption = document.createElement('caption')
  caption.textContent = value
    ? `${t('results.captionJournal', { n: value.atSeq })}${
        value.summary
          ? ` · ${t('results.captionRounds', { count: value.summary.roundCount })}${value.summary.inputId ? ` · ${t('results.captionInput', { id: value.summary.inputId.slice(0, 8) })}` : ''}`
          : ` · ${t('results.summaryUnknown')}`
      }`
    : t('results.captionLoading')
  const sides = orderedSides(value)
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  const corner = document.createElement('th')
  corner.scope = 'col'
  headRow.append(corner)
  for (const side of sides) {
    const column = document.createElement('th')
    column.scope = 'col'
    column.dataset.side = side
    column.textContent = heading(value, t, side)
    headRow.append(column)
  }
  head.append(headRow)
  const body = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    tr.dataset.resultMetric = row.key
    const label = document.createElement('th')
    label.scope = 'row'
    label.textContent = t(row.labelKey)
    tr.append(label)
    for (const side of sides) {
      const td = document.createElement('td')
      td.dataset.side = side
      const rendered = cell(value, t, side, row.key)
      if (row.key === 'answer' && rendered.answer) {
        const preview = document.createElement('pre')
        preview.className = 'comparison-results-answer'
        preview.textContent = rendered.answer.text
        const actions = document.createElement('div')
        actions.className = 'comparison-results-answer-actions'
        const copy = document.createElement('button')
        copy.type = 'button'
        copy.dataset.copyAnswer = side
        copy.textContent = t('results.copy')
        copy.setAttribute('aria-label', t('results.copyAria', { side: sideLabel(side, t) }))
        actions.append(copy)
        if (rendered.answer.truncated) {
          const mark = document.createElement('span')
          mark.textContent = t('results.truncated')
          actions.append(mark)
        }
        td.append(preview, actions)
        td.dataset.answerSeq = String(rendered.answer.seq)
      } else td.textContent = rendered.text
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(caption, head, body)
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  document.execCommand('copy')
  field.remove()
}

/** Always-visible compact two-column shortcut over one metrics.render payload. */
export function createComparisonResults(host: HTMLElement, t: Translate) {
  const root = document.createElement('section')
  root.className = 'comparison-results'
  root.dataset.state = 'loading'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.className = 'comparison-results-status'
  status.textContent = t('results.loading')
  const note = document.createElement('p')
  note.className = 'comparison-results-note'
  note.textContent = t('results.note')
  const table = document.createElement('table')
  table.className = 'comparison-results-table'
  paintTable(table, undefined, t)
  const prepared = document.createElement('div')
  prepared.className = 'comparison-results-prepared'
  root.append(status, note, table, prepared)
  host.append(root)
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.('button[data-copy-answer]')
    if (!(button instanceof HTMLButtonElement)) return
    const side = button.dataset.copyAnswer
    const preview = button.closest('td')?.querySelector('.comparison-results-answer')?.textContent
    if ((side !== 'left' && side !== 'right') || !preview) return
    void copyText(preview).then(
      () => {
        button.textContent = t('results.copied')
      },
      () => {
        button.textContent = t('results.copyFailed')
      },
    )
  })
  let applied: number | undefined
  const retain = (text: string, state: 'updating' | 'unavailable') => {
    root.dataset.state = state
    status.textContent = text
  }
  return {
    loading(seq: number) {
      retain(
        applied === undefined
          ? t('results.syncing', { seq })
          : t('results.syncingStale', { seq, applied }),
        'updating',
      )
      root.dataset.pendingSeq = String(seq)
    },
    unavailable(reason: string) {
      retain(reason, 'unavailable')
    },
    render(value: ComparisonMetricsResult, rebuild: boolean) {
      applied = value.atSeq
      root.dataset.state = 'ready'
      root.dataset.atSeq = String(value.atSeq)
      delete root.dataset.pendingSeq
      if (value.summary?.inputId) root.dataset.inputId = value.summary.inputId
      else delete root.dataset.inputId
      status.textContent = value.summary
        ? t('results.ready', { n: value.atSeq })
        : t('results.readyNoSummary', { n: value.atSeq })
      if (rebuild) {
        paintTable(table, value, t)
        prepared.replaceChildren()
        for (const side of orderedSides(value)) {
          const lane = value.lanes.find((item) => item.side === side)
          const section = document.createElement('section')
          section.dataset.side = side
          const heading = document.createElement('h4')
          heading.textContent =
            lane?.runtime.id === 'jevloop'
              ? 'JevLoop'
              : lane?.runtime.id === 'native'
                ? 'Native LLM'
                : sideLabel(side, t)
          section.append(heading)
          renderComparisonPrepared(section, lane?.prepared, t)
          prepared.append(section)
        }
      }
    },
    reset() {
      applied = undefined
      prepared.replaceChildren()
      root.dataset.state = 'loading'
      delete root.dataset.atSeq
      delete root.dataset.inputId
      delete root.dataset.pendingSeq
      status.textContent = t('results.loading')
      paintTable(table, undefined, t)
    },
  }
}
