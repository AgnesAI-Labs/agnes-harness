import type { ToolCall, ToolResult } from '@agnes/protocol'
import { Button, Icon } from '@agnes/web-ui'
import { TraceCard, TraceCode, TraceField } from './trace-inspector-parts.js'
import { traceLocale, traceText } from './trace-locale.js'
import {
  durationLabel,
  metricLabel,
  metricTokensLabel,
  type TraceRow,
  type TraceRowStep,
  tokenLabel,
} from './trace-model.js'
import { type RequestTraceState, RequestUsage } from './trace-request.js'
import type { TraceRequestMetrics } from './trace-request-metrics.js'
import { toolLabel } from './trace-summary.js'

export type ToolDetail = { call: ToolCall; result?: ToolResult }
type Lightbox = (value: { src: string; alt: string }) => void

const clock = (at: string | undefined, seconds = true): string | undefined => {
  const time = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(traceLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      }).format(time)
    : undefined
}
export const traceClock = clock
const bytes = (text: string): string =>
  text.length < 1024 ? `${text.length} B` : `${(text.length / 1024).toFixed(1)} KB`

/** Up to four facts a reader looks for first, chosen by record kind; absent values are left out. */
export function factsFor(
  row: TraceRow,
  request: TraceRequestMetrics | undefined,
  detail: ToolDetail | undefined,
): Array<[string, string]> {
  const facts: Array<[string, string | undefined]> = []
  if (row.kind === 'assistant') {
    const tokens = row.callUsage?.tokens
    facts.push(
      [
        traceText('trace.fact.tokens'),
        tokens
          ? traceText('trace.value.tokens', {
              input: tokens.input.toLocaleString(traceLocale()),
              output: tokens.output.toLocaleString(traceLocale()),
            })
          : undefined,
      ],
      [
        traceText('trace.fact.cacheRead'),
        tokens?.cacheRead ? tokens.cacheRead.toLocaleString(traceLocale()) : undefined,
      ],
      [
        traceText('trace.fact.credits'),
        row.callUsage?.credits === undefined
          ? undefined
          : traceText('trace.value.credits', {
              n: row.callUsage.credits,
              source: traceText(
                row.callUsage.creditSource === 'gateway' ? 'trace.value.gateway' : 'trace.value.estimated',
              ),
            }),
      ],
      [traceText('trace.fact.model'), row.model],
      [traceText('trace.fact.ttft'), row.ttftMs === undefined ? undefined : durationLabel(row.ttftMs)],
      [
        traceText('trace.field.requestOrder'),
        request?.requestNumber.state === 'known' ? metricLabel(request.requestNumber) : undefined,
      ],
    )
  } else if (row.kind === 'tool' && row.tool) {
    const result = detail?.result
    const text = result
      ? result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      : (row.tool.result ?? '')
    facts.push(
      [traceText('trace.fact.tool'), `${toolLabel(row.tool.name)} · ${row.tool.name}`],
      [
        traceText('trace.fact.review'),
        row.review
          ? traceText('trace.value.review', { decision: row.review.decision, risk: row.review.risk })
          : undefined,
      ],
      [
        traceText('trace.fact.result'),
        row.statusCode === 'failed'
          ? (row.errorCode ?? traceText('trace.result.failed'))
          : text
            ? traceText('trace.value.lines', { n: text.split('\n').length, size: bytes(text) })
            : undefined,
      ],
      [
        traceText('trace.fact.duration'),
        row.durationMs === undefined && row.statusCode !== 'running'
          ? traceText('trace.duration.unknown')
          : durationLabel(row.durationMs),
      ],
    )
  } else if (row.kind === 'ui') {
    const steps = row.steps ?? []
    facts.push(
      [
        traceText('trace.fact.surface'),
        row.surface?.title
          ? row.surface.revision
            ? traceText('trace.value.revision', { title: row.surface.title, n: row.surface.revision })
            : row.surface.title
          : undefined,
      ],
      [traceText('trace.fact.action'), steps.at(-1)?.label],
      [traceText('trace.fact.from'), row.source],
      [
        traceText('trace.fact.approval'),
        row.surface?.action
          ? traceText(
              steps.some((step) => step.statusCode === 'waiting')
                ? 'trace.value.approvalNeeded'
                : 'trace.value.approvalNone',
            )
          : undefined,
      ],
    )
  } else if (row.kind === 'control') {
    facts.push(
      [traceText('trace.fact.kind'), row.badge],
      [traceText('trace.fact.outcome'), row.status],
      [
        traceText('trace.fact.actor'),
        row.actor ? traceText('trace.control.youActor', { actor: row.actor }) : row.source,
      ],
      [traceText('trace.fact.time'), clock(row.startedAt)],
    )
  } else {
    facts.push(
      [traceText('trace.fact.source'), row.source],
      [
        traceText('trace.fact.length'),
        row.preview ? traceText('trace.value.chars', { n: row.raw.length || row.preview.length }) : undefined,
      ],
      [
        traceText('trace.field.attachments'),
        row.attachments?.length ? String(row.attachments.length) : undefined,
      ],
      [traceText('trace.fact.time'), clock(row.startedAt)],
    )
  }
  return facts.filter((fact): fact is [string, string] => Boolean(fact[1])).slice(0, 4)
}

export function TraceFacts({ facts }: { facts: Array<[string, string]> }) {
  if (facts.length === 0) return null
  return (
    <dl className="trace-facts" data-testid="trace-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="trace-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Recorded states in order, each with its time. */
export function StepList({ steps }: { steps: readonly TraceRowStep[] }) {
  return (
    <ol className="trace-steps" data-testid="trace-steps">
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: recorded steps are an immutable ordered list.
        <li key={index} className="trace-step" data-status={step.statusCode}>
          <Icon
            name={
              step.statusCode === 'failed'
                ? 'circle-alert'
                : step.statusCode === 'completed'
                  ? 'circle-check'
                  : 'clock'
            }
            size={16}
          />
          <span>{step.label}</span>
          {step.at ? <time dateTime={step.at}>{clock(step.at)}</time> : null}
        </li>
      ))}
    </ol>
  )
}

const argValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** A tool's arguments, field by field, from the full record or else the session's short copy. */
export function ToolArgs({
  row,
  detail,
  notice,
}: {
  row: TraceRow
  detail?: ToolDetail
  notice: React.ReactNode
}) {
  const args = detail?.call.args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>)
    return (
      <>
        <TraceCard title={traceText('trace.pane.args')}>
          <dl className="trace-fields">
            {entries
              .filter(([, value]) => {
                const text = argValue(value)
                return text.length <= 120 && !text.includes('\n')
              })
              .map(([key, value]) => (
                <TraceField key={key} label={key} value={argValue(value)} />
              ))}
          </dl>
        </TraceCard>
        {entries
          .filter(([, value]) => {
            const text = argValue(value)
            return text.length > 120 || text.includes('\n')
          })
          .map(([key, value]) => (
            <TraceCode key={key} label={key} value={argValue(value)} />
          ))}
        <TraceCode
          label={traceText('trace.code.json')}
          value={JSON.stringify(args, null, 2)}
          copyLabel={traceText('trace.detail.copyInput')}
          copyValue={JSON.stringify(args)}
          className="trace-detail-content"
        />
      </>
    )
  }
  return (
    <>
      {notice}
      {row.tool?.args ? (
        <>
          <TraceCode label={traceText('trace.pane.args')} value={row.tool.args} />
          <p className="trace-raw-note">{traceText('trace.note.tool')}</p>
        </>
      ) : null}
    </>
  )
}

/** A failed call's recorded error, shown before anything else in «结果». */
export function ToolError({ row }: { row: TraceRow }) {
  return (
    <TraceCard title={traceText('trace.card.error')} testId="trace-tool-error">
      <dl className="trace-fields">
        {row.errorCode ? (
          <TraceField label={traceText('trace.field.errorCode')} value={row.errorCode} />
        ) : null}
        <TraceField
          label={traceText('trace.field.error')}
          value={row.errorMessage ?? traceText('trace.error.unrecorded')}
        />
      </dl>
    </TraceCard>
  )
}

export function ToolResultPane({
  row,
  detail,
  notice,
  setLightbox,
}: {
  row: TraceRow
  detail?: ToolDetail
  notice: React.ReactNode
  setLightbox: Lightbox
}) {
  const result = detail?.result
  return (
    <>
      {row.statusCode === 'failed' ? <ToolError row={row} /> : null}
      {result ? (
        <>
          {result.content.map((block, index) => {
            if (block.type === 'text')
              return (
                <TraceCode
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
                  key={`text:${index}`}
                  label={traceText('trace.code.text')}
                  value={block.text}
                  className="trace-detail-content"
                />
              )
            if (block.type === 'image') {
              const supported = /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)
              const src = supported ? `data:${block.mimeType};base64,${block.data}` : undefined
              const alt = traceText('trace.image.resultAlt', { n: index + 1 })
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
                <div className="trace-detail-media" key={`image:${index}`}>
                  {src ? (
                    <Button
                      appearance="ghost"
                      size="small"
                      htmlType="button"
                      className="trace-image-thumb"
                      aria-label={traceText('trace.image.viewResult', { n: index + 1 })}
                      onClick={() => setLightbox({ src, alt })}
                    >
                      <img src={src} alt={alt} />
                    </Button>
                  ) : (
                    traceText('trace.image.mime', { mime: block.mimeType })
                  )}
                </div>
              )
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
              <p className="trace-detail-resource" key={`resource:${index}`}>
                {traceText('trace.resource.link', {
                  name: `${block.name ?? (block.type === 'resource_link' ? block.uri : '')}${block.mimeType ? ` · ${block.mimeType}` : ''}`,
                })}
              </p>
            )
          })}
          {result.structured === undefined ? null : (
            <TraceCode
              label={traceText('trace.detail.structured')}
              value={JSON.stringify(result.structured, null, 2)}
              className="trace-detail-content"
            />
          )}
        </>
      ) : detail ? (
        <>
          <p className="trace-detail-status">{traceText('trace.detail.resultMissing')}</p>
          {row.tool?.result ? (
            <TraceCode label={traceText('trace.pane.result')} value={row.tool.result} />
          ) : null}
        </>
      ) : (
        <>
          {notice}
          {row.tool?.result ? (
            <>
              <TraceCode label={traceText('trace.pane.result')} value={row.tool.result} />
              <p className="trace-raw-note">{traceText('trace.note.tool')}</p>
            </>
          ) : null}
        </>
      )}
    </>
  )
}

/** What the trace knows about a business-UI view: its title, revision, recorded state and answers. */
export function UiSnapshot({ row }: { row: TraceRow }) {
  return (
    <TraceCard title={traceText('trace.pane.snapshot')} testId="trace-ui-snapshot">
      <dl className="trace-fields">
        {row.surface?.title ? (
          <TraceField label={traceText('trace.fact.surface')} value={row.surface.title} />
        ) : null}
        {row.surface?.revision ? (
          <TraceField label={traceText('trace.fact.revision')} value={row.surface.revision} />
        ) : null}
        <TraceField label={traceText('trace.field.status')} value={row.steps?.at(-1)?.label ?? row.status} />
      </dl>
    </TraceCard>
  )
}

export function AnswersTable({ answers }: { answers: ReadonlyArray<readonly [string, string]> }) {
  return (
    <TraceCard title={traceText('trace.ui.answers')} testId="trace-answers">
      <dl className="trace-fields">
        {answers.map(([field, value]) => (
          <TraceField key={field} label={field} value={value} />
        ))}
      </dl>
    </TraceCard>
  )
}

/** «用量»: this call's tokens, its place in the session's billing order, and the request's tokens. */
export function UsagePane({
  row,
  metrics,
  request,
}: {
  row: TraceRow
  metrics: TraceRequestMetrics | undefined
  request: RequestTraceState | undefined
}) {
  const field = (label: string, value: string) => <TraceField key={label} label={label} value={value} />
  return (
    <>
      <TraceCard title={traceText('trace.card.usage')}>
        <dl className="trace-fields">
          {row.callUsage?.tokens
            ? field(
                traceText('trace.field.callUsage'),
                tokenLabel(row.callUsage.tokens, row.callUsage.tokens.reasoning !== undefined),
              )
            : null}
          {row.usage
            ? field(
                traceText('trace.field.turnUsage'),
                tokenLabel(row.usage.totals, row.usage.reasoningComplete),
              )
            : null}
          {metrics ? (
            <>
              {field(traceText('trace.field.requestOrder'), metricLabel(metrics.requestNumber))}
              {field(traceText('trace.field.ledgerOrder'), metricLabel(metrics.ledgerNumber))}
              {field(traceText('trace.field.cumulativeUsage'), metricTokensLabel(metrics.cumulativeTokens))}
              {field(
                traceText('trace.field.callDuration'),
                metrics.durationMs.state === 'known'
                  ? durationLabel(metrics.durationMs.value)
                  : metricLabel(metrics.durationMs),
              )}
              {field(
                traceText('trace.field.cumulativeDuration'),
                metrics.cumulativeCallDurationMs.state === 'known'
                  ? durationLabel(metrics.cumulativeCallDurationMs.value)
                  : metricLabel(metrics.cumulativeCallDurationMs),
              )}
            </>
          ) : null}
          {row.ttftMs === undefined
            ? null
            : field(traceText('trace.field.ttftDuration'), durationLabel(row.ttftMs))}
          {row.ttftMs === undefined || row.durationMs === undefined
            ? null
            : field(
                traceText('trace.field.generationAfter'),
                durationLabel(Math.max(0, row.durationMs - row.ttftMs)),
              )}
        </dl>
      </TraceCard>
      {request ? <RequestUsage state={request} /> : null}
    </>
  )
}
