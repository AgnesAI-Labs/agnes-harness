import type { FactChainAnchor, UINode, UITurn } from '@agnes/protocol'
import { Button, Disclosure, IconButton, Menu, type MenuItem } from '@agnes/web-ui'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { FeedbackProvenance } from './message-feedback/index.js'
import type { TraceMeta, TracePanelOptions } from './trace.js'
import {
  AnswersTable,
  factsFor,
  StepList,
  ToolArgs,
  type ToolDetail,
  ToolResultPane,
  TraceFacts,
  traceClock,
  UiSnapshot,
  UsagePane,
} from './trace-inspector-panes.js'
import { TraceCard, TraceCode, TraceField } from './trace-inspector-parts.js'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'
import { durationLabel, type TraceRow, traceStepLabel } from './trace-model.js'
import { TraceSourceRecord } from './trace-provenance.js'
import {
  RequestCapture,
  RequestContent,
  type RequestTraceState,
  requestBaseline,
  useRequestTrace,
} from './trace-request.js'
import type { TraceRequestMetrics } from './trace-request-metrics.js'
import { TraceReview } from './trace-review.js'

const PANE_KEY = {
  reply: 'trace.pane.reply',
  request: 'trace.pane.request',
  usage: 'trace.pane.usage',
  args: 'trace.pane.args',
  result: 'trace.pane.result',
  snapshot: 'trace.pane.snapshot',
  actionSteps: 'trace.pane.actionSteps',
  steps: 'trace.pane.steps',
  content: 'trace.pane.content',
  source: 'trace.pane.source',
  projected: 'trace.pane.raw',
  input: 'trace.pane.input',
  output: 'trace.pane.output',
} as const satisfies Record<string, TraceMessageKey>
export type InspectorPane = keyof typeof PANE_KEY
export type ToolDetailState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; value: ToolDetail }

/** The one tab row each kind of record gets. Debug views live in the ⋯ menu instead. */
export function inspectorPanes(row: TraceRow, hasRequest: boolean): InspectorPane[] {
  if (row.kind === 'assistant')
    return hasRequest ? ['reply', 'request', 'usage', 'source'] : ['reply', 'usage', 'source']
  if (row.kind === 'context') return ['source', 'content']
  if (row.kind === 'tool') return ['result', 'source', 'args']
  if (row.kind === 'ui') return ['snapshot', 'actionSteps', 'source']
  if (row.kind === 'control' && row.steps) return ['steps', 'source']
  return ['content', 'source']
}

/** Where a newly selected record opens: a failed tool on its error, everything else on its first tab. */
export function defaultPane(row: TraceRow | undefined): InspectorPane {
  if (!row) return 'content'
  if (row.kind === 'tool' && row.statusCode === 'failed') return 'result'
  return inspectorPanes(row, true)[0] ?? 'content'
}

type InspectorProps = {
  selectedRow: TraceRow | undefined
  compact: boolean
  closeInspector(): void
  options: Omit<TracePanelOptions, 'root'>
  snapshot: { turns: readonly UITurn[]; meta?: TraceMeta | undefined }
  selectedToolKey: string | undefined
  activeToolDetail: ToolDetailState | undefined
  pane: InspectorPane
  selectPane(id: InspectorPane): void
  selectedUserNode: UINode | undefined
  selectedRequest: TraceRequestMetrics | undefined
  setLightbox(value: { src: string; alt: string }): void
  /** The record a link asked for, when the trace was opened from one. */
  focus?: FactChainAnchor | undefined
}

/** Owns the model-request read for an assistant row, so its tabs and ⋯ items share one result. */
function RequestScope({
  sessionId,
  callId,
  read,
  children,
}: {
  sessionId: string
  callId: string
  read: NonNullable<TracePanelOptions['readModelRequest']>
  children(state: RequestTraceState): ReactNode
}) {
  return children(useRequestTrace({ sessionId, callId, read, locale: traceLocale() }))
}

/** Display-only inspector; request lifecycle, selection and image focus stay with Trace. */
export function TraceInspector(props: InspectorProps) {
  const row = props.selectedRow
  if (!row) return <aside className="trace-inspector" hidden={true} />
  const sessionId = props.snapshot.meta?.sessionId
  const read = props.options.readModelRequest
  if (row.kind === 'assistant' && row.requestTraceId && sessionId && read)
    return (
      <RequestScope
        key={`${sessionId}:${row.requestTraceId}`}
        sessionId={sessionId}
        callId={row.requestTraceId}
        read={read}
      >
        {(request) => <InspectorView {...props} row={row} request={request} />}
      </RequestScope>
    )
  return <InspectorView {...props} row={row} request={undefined} />
}

function InspectorView({
  row,
  request,
  compact,
  closeInspector,
  options,
  snapshot,
  selectedToolKey,
  activeToolDetail,
  pane,
  selectPane,
  selectedUserNode,
  selectedRequest,
  setLightbox,
  focus,
}: InspectorProps & { row: TraceRow; request: RequestTraceState | undefined }) {
  const anchor = row.requestTraceId
    ? ({ kind: 'request', callId: row.requestTraceId } as const)
    : row.tool?.toolUseId
      ? ({ kind: 'tool', toolUseId: row.tool.toolUseId } as const)
      : undefined
  const sourceAnchor = focus?.kind === 'authoring' ? focus : anchor
  const detail = activeToolDetail?.status === 'ready' ? activeToolDetail.value : undefined
  const notice =
    activeToolDetail?.status === 'error' ? (
      <p className="trace-detail-status" role="alert">
        {traceText('trace.detail.readFailed', { message: activeToolDetail.message })}
      </p>
    ) : activeToolDetail?.status === 'loading' ? (
      <p className="trace-detail-status" role="status">
        {traceText('trace.detail.loading')}
      </p>
    ) : null
  const panes = inspectorPanes(row, Boolean(request))
  const sessionId = snapshot.meta?.sessionId
  const more: MenuItem[] = [
    { id: 'projected', label: traceText('trace.pane.raw'), onSelect: () => selectPane('projected') },
    ...(selectedToolKey
      ? [
          { id: 'input', label: traceText('trace.pane.input'), onSelect: () => selectPane('input') },
          { id: 'output', label: traceText('trace.pane.output'), onSelect: () => selectPane('output') },
        ]
      : []),
    ...(request && sessionId
      ? [
          {
            id: 'compare-previous',
            label: request.t('comparePrevious'),
            disabled: !request.previous && request.compare === 'none',
            onSelect: () => {
              request.setCompare('previous')
              selectPane('request')
            },
          },
          {
            id: 'compare-fixed',
            label: request.t('compareFixed'),
            disabled: !requestBaseline.get() || requestBaseline.get()?.callId === request.selectedCall,
            onSelect: () => {
              request.setCompare('fixed')
              selectPane('request')
            },
          },
          {
            id: 'compare-pin',
            label: request.t('baseline'),
            onSelect: () => requestBaseline.pin({ sessionId, callId: request.selectedCall }),
          },
          ...(request.compare !== 'none'
            ? [
                {
                  id: 'compare-off',
                  label: request.t('compareOff'),
                  onSelect: () => request.setCompare('none'),
                },
              ]
            : []),
          ...(requestBaseline.get()
            ? [{ id: 'compare-clear', label: request.t('clear'), onSelect: () => requestBaseline.clear() }]
            : []),
        ]
      : []),
  ]
  const started = row.startedAt ? Date.parse(row.startedAt) : Number.NaN
  const meta = [
    row.durationMs !== undefined || row.statusCode === 'running' ? durationLabel(row.durationMs) : undefined,
    row.ttftMs === undefined ? undefined : `${traceText('trace.fact.ttft')} ${durationLabel(row.ttftMs)}`,
    row.turn ? traceText('trace.inspector.turn', { turn: row.turn }) : undefined,
    traceStepLabel(row.step),
    Number.isFinite(started) ? traceClock(row.startedAt) : undefined,
  ].filter(Boolean)
  const userImages =
    selectedUserNode?.kind === 'user'
      ? selectedUserNode.content.flatMap((block, index) => {
          if (block.type !== 'image' || !/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)) return []
          const src = `data:${block.mimeType};base64,${block.data}`
          const alt = traceText('trace.image.inputAlt', { n: index + 1 })
          return [
            <Button
              appearance="ghost"
              size="small"
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are immutable ordered records without IDs.
              key={`user-image:${index}`}
              className="trace-image-thumb"
              htmlType="button"
              aria-label={traceText('trace.image.viewInput', { n: index + 1 })}
              onClick={() => setLightbox({ src, alt })}
            >
              <img src={src} alt={alt} />
            </Button>,
          ]
        })
      : []
  const body = (): ReactNode => {
    switch (pane) {
      case 'reply':
        return (
          <TraceCode label={traceText('trace.pane.reply')} value={row.raw || traceText('trace.emptyRaw')} />
        )
      case 'request':
        return request ? <RequestContent state={request} /> : null
      case 'usage':
        return <UsagePane row={row} metrics={selectedRequest} request={request} />
      case 'args':
        return <ToolArgs row={row} {...(detail ? { detail } : {})} notice={notice} />
      case 'result':
        return (
          <ToolResultPane
            row={row}
            {...(detail ? { detail } : {})}
            notice={notice}
            setLightbox={setLightbox}
          />
        )
      case 'snapshot':
        return <UiSnapshot row={row} />
      case 'actionSteps':
      case 'steps':
        return <StepList steps={row.steps ?? []} />
      case 'content':
        return (
          <>
            {row.answers?.length ? <AnswersTable answers={row.answers} /> : null}
            <TraceCode
              label={traceText('trace.pane.content')}
              value={row.preview || traceText('trace.emptyPreview')}
            />
            {row.attachments?.length ? (
              <TraceCard title={traceText('trace.field.attachments')}>
                <p className="trace-card-line">{row.attachments.join(traceText('trace.join.list'))}</p>
                {row.rawNote ? <p className="trace-raw-note">{row.rawNote}</p> : null}
              </TraceCard>
            ) : null}
            {userImages.length ? (
              <TraceCard title={traceText('trace.card.images')}>
                <div className="trace-thumbs">{userImages}</div>
              </TraceCard>
            ) : null}
          </>
        )
      case 'source':
        return (
          <>
            <TraceCard title={traceText('trace.pane.source')}>
              <dl className="trace-fields">
                <TraceField label={traceText('trace.field.source')} value={row.source} />
                {row.tool ? <TraceField label={traceText('trace.fact.tool')} value={row.tool.name} /> : null}
                {row.model ? <TraceField label={traceText('trace.field.model')} value={row.model} /> : null}
                {row.actor ? <TraceField label={traceText('trace.fact.actor')} value={row.actor} /> : null}
                {row.errorCode ? (
                  <TraceField label={traceText('trace.field.errorCode')} value={row.errorCode} />
                ) : null}
              </dl>
            </TraceCard>
            {row.review ? (
              <TraceCard title={traceText('trace.card.review')} testId="trace-auto-review">
                <Disclosure variant="plain" summary={traceText('trace.facts.technical')}>
                  <TraceReview name={row.tool?.name ?? row.source} review={row.review} />
                </Disclosure>
              </TraceCard>
            ) : null}
            {focus?.kind === 'authoring' && sessionId ? (
              <FeedbackProvenance sessionId={sessionId} candidateId={focus.candidateId} />
            ) : null}
            {sourceAnchor && sessionId && options.readFactChain ? (
              <TraceCard title={traceText('trace.provenance.title')}>
                <TraceSourceRecord
                  sessionId={sessionId}
                  anchor={sourceAnchor}
                  read={options.readFactChain}
                  loadArtifact={options.loadArtifact}
                  review={!row.review}
                />
              </TraceCard>
            ) : null}
            {request ? <RequestCapture state={request} clear={options.clearModelRequest} /> : null}
          </>
        )
      case 'projected':
        return (
          <>
            {row.rawNote ? <p className="trace-raw-note">{row.rawNote}</p> : null}
            <TraceCode label={traceText('trace.pane.raw')} value={row.raw || traceText('trace.emptyRaw')} />
            {row.review ? (
              <TraceCode label={traceText('trace.code.json')} value={JSON.stringify(row.review, null, 2)} />
            ) : null}
          </>
        )
      case 'input':
        return detail ? (
          <TraceCode
            label={traceText('trace.code.json')}
            value={JSON.stringify(detail.call.args, null, 2)}
            copyLabel={traceText('trace.detail.copyInput')}
            copyValue={JSON.stringify(detail.call.args)}
            className="trace-detail-content"
          />
        ) : (
          (notice ?? <p className="trace-detail-status">{traceText('trace.detail.empty')}</p>)
        )
      case 'output':
        return detail?.result ? (
          <TraceCode
            label={traceText('trace.code.json')}
            value={JSON.stringify(detail.result, null, 2)}
            copyLabel={traceText('trace.detail.copyResult')}
            copyValue={JSON.stringify(detail.result)}
            className="trace-detail-content"
          />
        ) : (
          (notice ?? <p className="trace-detail-status">{traceText('trace.detail.resultMissing')}</p>)
        )
    }
  }
  return (
    <aside
      className="trace-inspector"
      data-kind={row.kind}
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (compact && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          closeInspector()
        }
      }}
    >
      <header className="trace-inspector-head">
        <div className="trace-inspector-titlebar">
          <span className={`trace-badge kind-${row.kind}`}>{row.badge}</span>
          <h2 className="trace-inspector-title" title={row.title}>
            {row.title}
          </h2>
          {options.chatToggle && row.turn !== undefined ? (
            <Button
              appearance="ghost"
              size="small"
              htmlType="button"
              className="trace-detail-copy"
              data-testid="trace-view-chat"
              onClick={() => {
                const turn = snapshot.turns.find((item) => item.turn === row.turn)
                options.chatToggle?.click()
                const target = [
                  ...(options.conversation?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? []),
                ].find((item) => item.dataset.turnId === turn?.id)
                target?.scrollIntoView?.({ block: 'center' })
              }}
            >
              {traceText('trace.jump.chat')}
            </Button>
          ) : null}
          <Menu
            label={traceText('trace.inspector.more')}
            items={more}
            trigger={
              <IconButton
                name="ellipsis"
                className="trace-inspector-more"
                data-testid="trace-inspector-more"
                label={traceText('trace.inspector.more')}
              />
            }
          />
          <IconButton
            name="x"
            className="trace-inspector-close"
            label={traceText('trace.closeDetail')}
            onClick={closeInspector}
          />
        </div>
        <p className="trace-inspector-meta">
          <span className="trace-status-tag" data-status={row.statusCode}>
            {row.status}
          </span>
          {meta.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </p>
      </header>
      <TraceFacts facts={factsFor(row, selectedRequest, detail)} />
      <div className="trace-inspector-tabs" role="tablist" aria-label={row.title}>
        {panes.map((id) => (
          <Button
            appearance="ghost"
            size="small"
            key={id}
            className="trace-tab"
            htmlType="button"
            role="tab"
            data-pane={id}
            aria-selected={pane === id}
            onClick={() => selectPane(id)}
          >
            {traceText(PANE_KEY[id])}
          </Button>
        ))}
        {panes.includes(pane) ? null : (
          <span className="trace-tab trace-tab-debug" data-pane={pane} aria-current="true">
            {traceText(PANE_KEY[pane])}
          </span>
        )}
      </div>
      <div className="trace-inspector-body" role="tabpanel">
        <div className="trace-inspector-pane" data-pane={pane} data-testid="trace-inspector-pane">
          {body()}
        </div>
      </div>
    </aside>
  )
}
