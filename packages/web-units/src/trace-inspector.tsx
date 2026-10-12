import type { ToolCall, ToolResult, UINode, UITurn } from '@agnes/protocol'
import { Button, IconButton, Tabs } from '@agnes/web-ui'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TraceMeta, TracePanelOptions } from './trace.js'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'
import {
  durationLabel,
  metricLabel,
  metricTokensLabel,
  type TraceRow,
  tokenLabel,
  traceStepLabel,
} from './trace-model.js'
import { RequestTraceView } from './trace-request.js'
import type { TraceRequestMetrics } from './trace-request-metrics.js'

const INSPECTOR_PANE_IDS = ['overview', 'preview', 'raw', 'source'] as const
const PANE_KEY = {
  overview: 'trace.pane.overview',
  preview: 'trace.pane.preview',
  raw: 'trace.pane.raw',
  source: 'trace.pane.source',
  input: 'trace.pane.input',
  output: 'trace.pane.output',
  timing: 'trace.pane.timing',
} as const satisfies Record<string, TraceMessageKey>
export type InspectorPane = keyof typeof PANE_KEY
type ToolDetail = {
  call: ToolCall
  result?: ToolResult
}
export type ToolDetailState =
  | {
      key: string
      status: 'loading'
    }
  | {
      key: string
      status: 'error'
      message: string
    }
  | {
      key: string
      status: 'ready'
      value: ToolDetail
    }

/** Display-only inspector; request lifecycle, selection and image focus stay with Trace. */
export function TraceInspector({
  selectedRow,
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
}: {
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
}) {
  const paneField = (label: string, value: string) => (
    <div className="trace-field" key={label}>
      <div className="trace-field-label">{label}</div>
      <div className="trace-field-value">{value}</div>
    </div>
  )
  const inspectorPaneIds: readonly InspectorPane[] = selectedToolKey
    ? [...INSPECTOR_PANE_IDS, 'input', 'output', 'timing']
    : [...INSPECTOR_PANE_IDS]
  const detailValue = activeToolDetail?.status === 'ready' ? activeToolDetail.value : undefined
  const detailNotice = () =>
    activeToolDetail?.status === 'error' ? (
      <p className="trace-detail-status" role="alert">
        {traceText('trace.detail.readFailed', { message: activeToolDetail.message })}
      </p>
    ) : (
      <p className="trace-detail-status" role="status">
        {activeToolDetail?.status === 'loading'
          ? traceText('trace.detail.loading')
          : traceText('trace.detail.empty')}
      </p>
    )
  const copyDetail = (label: string, value: string) => (
    <Button
      appearance="ghost"
      size="small"
      htmlType="button"
      className="trace-detail-copy"
      disabled={!navigator.clipboard?.writeText}
      onClick={() => void navigator.clipboard.writeText(value)}
    >
      {label}
    </Button>
  )
  const toolResultBlocks = (result: ToolResult) =>
    result.content.map((block, index) => {
      if (block.type === 'text')
        return (
          <pre
            className="trace-pre trace-detail-content"
            // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
            key={`text:${index}`}
          >
            {block.text}
          </pre>
        )
      if (block.type === 'image') {
        const supported = /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)
        const src = supported ? `data:${block.mimeType};base64,${block.data}` : undefined
        return (
          <div
            className="trace-detail-media"
            // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
            key={`image:${index}`}
          >
            {src ? (
              <Button
                appearance="ghost"
                size="small"
                htmlType="button"
                className="trace-image-thumb"
                aria-label={traceText('trace.image.viewResult', { n: index + 1 })}
                onClick={() =>
                  setLightbox({ src, alt: traceText('trace.image.resultAlt', { n: index + 1 }) })
                }
              >
                <img src={src} alt={traceText('trace.image.resultAlt', { n: index + 1 })} />
              </Button>
            ) : (
              traceText('trace.image.mime', { mime: block.mimeType })
            )}
          </div>
        )
      }
      return (
        <p
          className="trace-detail-resource"
          // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
          key={`resource:${index}`}
        >
          {traceText('trace.resource.link', {
            name: `${block.name ?? (block.type === 'resource_link' ? block.uri : '')}${block.mimeType ? ` · ${block.mimeType}` : ''}`,
          })}
        </p>
      )
    })

  return selectedRow ? (
    <aside
      className="trace-inspector"
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (compact && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          closeInspector()
        }
      }}
    >
      <header className="trace-inspector-head">
        <span className={`trace-badge kind-${selectedRow.kind}`}>{selectedRow.badge}</span>
        <h2 className="trace-inspector-title">
          {[
            selectedRow.turn ? traceText('trace.inspector.turn', { turn: selectedRow.turn }) : undefined,
            traceStepLabel(selectedRow.step),
            traceText('trace.inspector.message'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </h2>
        {options.chatToggle && selectedRow.turn !== undefined ? (
          <Button
            appearance="ghost"
            size="small"
            htmlType="button"
            className="trace-detail-copy"
            data-testid="trace-view-chat"
            onClick={() => {
              const turn = snapshot.turns.find((item) => item.turn === selectedRow.turn)
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
        <IconButton
          name="x"
          className="trace-inspector-close"
          label={traceText('trace.closeDetail')}
          onClick={closeInspector}
        />
      </header>
      {selectedRow.review ? (
        <section data-testid="trace-auto-review">
          <p>{traceText('trace.review.model', { model: selectedRow.review.model })}</p>
          <p>
            {traceText('trace.review.decision', {
              decision: selectedRow.review.decision,
              risk: selectedRow.review.risk,
            })}
          </p>
          <p>{selectedRow.review.reason}</p>
          <pre>{JSON.stringify(selectedRow.review, null, 2)}</pre>
        </section>
      ) : null}
      {selectedRow.requestTraceId && snapshot.meta?.sessionId && options.openFactChain ? (
        <Button
          appearance="ghost"
          size="small"
          htmlType="button"
          className="trace-detail-copy"
          data-testid="trace-fact-chain"
          onClick={() => {
            const sessionId = snapshot.meta?.sessionId
            const callId = selectedRow.requestTraceId
            if (sessionId && callId)
              options.openFactChain?.({ sessionId, laneId: 'main', anchor: { kind: 'request', callId } })
          }}
        >
          {traceLocale() === 'zh-CN' ? '查看执行依据' : 'View execution evidence'}
        </Button>
      ) : null}
      {selectedRow.requestTraceId && snapshot.meta?.sessionId && options.readModelRequest ? (
        <RequestTraceView
          key={`${snapshot.meta.sessionId}:${selectedRow.requestTraceId}`}
          sessionId={snapshot.meta.sessionId}
          callId={selectedRow.requestTraceId}
          read={options.readModelRequest}
          {...(options.clearModelRequest ? { clear: options.clearModelRequest } : {})}
          locale={traceLocale()}
        />
      ) : null}
      <Tabs
        className="trace-inspector-tabs-root"
        activeKey={pane}
        items={inspectorPaneIds.map((id) => ({ key: id, label: traceText(PANE_KEY[id]) }))}
        renderTabBar={() => (
          <div className="trace-inspector-tabs">
            {inspectorPaneIds.map((id) => (
              <Button
                appearance="ghost"
                size="small"
                key={id}
                className="trace-tab"
                htmlType="button"
                data-pane={id}
                aria-pressed={pane === id ? 'true' : 'false'}
                onClick={() => selectPane(id)}
              >
                {traceText(PANE_KEY[id])}
              </Button>
            ))}
          </div>
        )}
      />
      <div className="trace-inspector-pane" hidden={pane !== 'overview'}>
        {paneField(traceText('trace.field.source'), selectedRow.source)}
        {paneField(traceText('trace.field.status'), selectedRow.status)}
        {selectedRow.errorCode ? paneField(traceText('trace.field.errorCode'), selectedRow.errorCode) : null}
        {selectedRow.attachments?.length
          ? paneField(
              traceText('trace.field.attachments'),
              selectedRow.attachments.join(traceText('trace.join.list')),
            )
          : null}
        {selectedUserNode?.kind === 'user'
          ? selectedUserNode.content.flatMap((block, index) => {
              if (block.type !== 'image' || !/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)) return []
              const src = `data:${block.mimeType};base64,${block.data}`
              return [
                <Button
                  appearance="ghost"
                  size="small"
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool content blocks are immutable ordered records without IDs.
                  key={`user-image:${index}`}
                  className="trace-image-thumb"
                  htmlType="button"
                  aria-label={traceText('trace.image.viewInput', { n: index + 1 })}
                  onClick={() =>
                    setLightbox({ src, alt: traceText('trace.image.inputAlt', { n: index + 1 }) })
                  }
                >
                  <img src={src} alt={traceText('trace.image.inputAlt', { n: index + 1 })} />
                </Button>,
              ]
            })
          : null}
        {selectedRow.step
          ? paneField(traceText('trace.field.step'), traceStepLabel(selectedRow.step) ?? '')
          : null}
        {selectedRow.durationMs !== undefined || selectedRow.statusCode === 'running'
          ? paneField(traceText('trace.field.duration'), durationLabel(selectedRow.durationMs))
          : null}
        {selectedRow.ttftMs === undefined
          ? null
          : paneField(traceText('trace.field.ttft'), durationLabel(selectedRow.ttftMs))}
        {selectedRow.model === undefined
          ? null
          : paneField(traceText('trace.field.model'), selectedRow.model)}
        {selectedRow.usage === undefined
          ? null
          : paneField(
              traceText('trace.field.turnUsage'),
              tokenLabel(selectedRow.usage.totals, selectedRow.usage.reasoningComplete),
            )}
        {selectedRow.callUsage?.tokens
          ? paneField(
              traceText('trace.field.callUsage'),
              tokenLabel(selectedRow.callUsage.tokens, selectedRow.callUsage.tokens.reasoning !== undefined),
            )
          : null}
        {selectedRequest ? (
          <>
            {paneField(traceText('trace.field.requestOrder'), metricLabel(selectedRequest.requestNumber))}
            {paneField(traceText('trace.field.ledgerOrder'), metricLabel(selectedRequest.ledgerNumber))}
            {paneField(
              traceText('trace.field.cumulativeUsage'),
              metricTokensLabel(selectedRequest.cumulativeTokens),
            )}
            {paneField(
              traceText('trace.field.callDuration'),
              selectedRequest.durationMs.state === 'known'
                ? durationLabel(selectedRequest.durationMs.value)
                : metricLabel(selectedRequest.durationMs),
            )}
            {paneField(
              traceText('trace.field.cumulativeDuration'),
              selectedRequest.cumulativeCallDurationMs.state === 'known'
                ? durationLabel(selectedRequest.cumulativeCallDurationMs.value)
                : metricLabel(selectedRequest.cumulativeCallDurationMs),
            )}
          </>
        ) : null}
      </div>
      <div className="trace-inspector-pane" hidden={pane !== 'preview'}>
        <pre className="trace-pre">{selectedRow.preview || traceText('trace.emptyPreview')}</pre>
      </div>
      <div className="trace-inspector-pane" hidden={pane !== 'raw'}>
        {selectedRow.rawNote ? <p className="trace-raw-note">{selectedRow.rawNote}</p> : null}
        <pre className="trace-pre">{selectedRow.raw || traceText('trace.emptyRaw')}</pre>
      </div>
      <div className="trace-inspector-pane" hidden={pane !== 'source'}>
        {paneField(traceText('trace.field.source'), selectedRow.source)}
      </div>
      {selectedToolKey ? (
        <>
          <div className="trace-inspector-pane" hidden={pane !== 'input'}>
            {pane !== 'input' ? null : detailValue ? (
              <>
                {copyDetail(traceText('trace.detail.copyInput'), JSON.stringify(detailValue.call.args))}
                <pre key="structured-content" className="trace-pre trace-detail-content">
                  {JSON.stringify(detailValue.call.args, null, 2)}
                </pre>
              </>
            ) : (
              detailNotice()
            )}
          </div>
          <div className="trace-inspector-pane" hidden={pane !== 'output'}>
            {pane !== 'output' ? null : !detailValue ? (
              detailNotice()
            ) : !detailValue.result ? (
              <p className="trace-detail-status">{traceText('trace.detail.resultMissing')}</p>
            ) : (
              <>
                {paneField(
                  traceText('trace.field.result'),
                  detailValue.result.isError
                    ? traceText('trace.result.failed')
                    : traceText('trace.result.completed'),
                )}
                {detailValue.result.code
                  ? [paneField(traceText('trace.field.errorCode'), detailValue.result.code)]
                  : []}
                {copyDetail(traceText('trace.detail.copyResult'), JSON.stringify(detailValue.result))}
                {toolResultBlocks(detailValue.result)}
                {detailValue.result.structured === undefined
                  ? []
                  : [
                      <h3 key="structured-heading" className="trace-detail-heading">
                        {traceText('trace.detail.structured')}
                      </h3>,
                      <pre key="structured-content" className="trace-pre trace-detail-content">
                        {JSON.stringify(detailValue.result.structured, null, 2)}
                      </pre>,
                    ]}
              </>
            )}
          </div>
          <div className="trace-inspector-pane" hidden={pane !== 'timing'}>
            {selectedRow.startedAt
              ? paneField(traceText('trace.field.startedAt'), selectedRow.startedAt)
              : null}
            {paneField(
              traceText('trace.field.duration'),
              selectedRow.durationMs === undefined && selectedRow.statusCode !== 'running'
                ? traceText('trace.duration.unknown')
                : durationLabel(selectedRow.durationMs),
            )}
            {selectedRow.ttftMs === undefined
              ? null
              : paneField(traceText('trace.field.ttftDuration'), durationLabel(selectedRow.ttftMs))}
            {selectedRow.ttftMs === undefined || selectedRow.durationMs === undefined
              ? null
              : paneField(
                  traceText('trace.field.generationAfter'),
                  durationLabel(Math.max(0, selectedRow.durationMs - selectedRow.ttftMs)),
                )}
          </div>
        </>
      ) : null}
    </aside>
  ) : (
    <aside className="trace-inspector" hidden={true} />
  )
}
