import type {
  ModelRequestClearParams,
  ModelRequestClearResult,
  ModelRequestParams,
  ModelRequestResult,
  ModelRequestSnapshot,
} from '@agnes/protocol'
import {
  Button,
  createCatalogTranslator,
  Field,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

import { requestTraceCatalog } from './trace-request-locale.js'

const panes = ['system', 'tools', 'messages', 'params', 'tokens', 'raw'] as const
type Pane = (typeof panes)[number]
let comparison: { sessionId: string; callId: string } | undefined
function value(snapshot: ModelRequestSnapshot, pane: Pane, attemptIndex = -1): string {
  const attempt = snapshot.attempts[attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex]
  if (pane === 'system') return snapshot.system
  return JSON.stringify(
    pane === 'tokens'
      ? {
          providerActual: attempt ? attempt.providerActualTokens : snapshot.tokens.providerActual,
          estimated: attempt ? attempt.estimatedTokens : snapshot.tokens.estimated,
          response: attempt?.response ?? snapshot.response,
        }
      : pane === 'raw'
        ? (attempt?.wire ?? null)
        : snapshot[pane],
    null,
    2,
  )
}
/** Bounded line diff; large blocks use a whole-block comparison instead of quadratic matching. */
export function requestDiff(
  before: string,
  after: string,
): { kind: 'same' | 'removed' | 'added'; text: string; key: string }[] {
  const a = before.split('\n'),
    b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++
  return [
    { kind: 'same', key: 'opening', text: a.slice(0, start).join('\n') },
    { kind: 'removed', key: 'removed', text: a.slice(start, a.length - end).join('\n') },
    { kind: 'added', key: 'added', text: b.slice(start, b.length - end).join('\n') },
    { kind: 'same', key: 'closing', text: end ? a.slice(a.length - end).join('\n') : '' },
  ].filter((part) => part.text) as ReturnType<typeof requestDiff>
}
export function RequestTraceView({
  sessionId,
  callId,
  read,
  locale = 'en',
  clear,
}: {
  sessionId: string
  callId: string
  locale?: 'en' | 'zh-CN'
  read(params: ModelRequestParams, signal?: AbortSignal): Promise<ModelRequestResult>
  clear?: (params: ModelRequestClearParams) => Promise<ModelRequestClearResult>
}) {
  const t = createCatalogTranslator(requestTraceCatalog, locale)
  const [attemptIndex, setAttemptIndex] = useState(-1)
  const [confirmClear, setConfirmClear] = useState(false)
  const [selectedCall, setSelectedCall] = useState(callId)
  const [calls, setCalls] = useState<NonNullable<ModelRequestResult['calls']>>([])
  const [result, setResult] = useState<ModelRequestResult>()
  const [error, setError] = useState(false)
  const [pane, setPane] = useState<Pane>('system')
  const [diff, setDiff] = useState(false)
  const [copied, setCopied] = useState(false)
  const [baseline, setBaseline] = useState(false)
  const [comparisonInput, setComparisonInput] = useState(comparison)
  useEffect(() => {
    const pending = new AbortController()
    setResult(undefined)
    setError(false)
    setAttemptIndex(-1)
    setConfirmClear(false)
    const compare =
      comparisonInput && (comparisonInput.callId !== selectedCall || comparisonInput.sessionId !== sessionId)
        ? comparisonInput
        : undefined
    void read({ sessionId, callId: selectedCall, ...(compare ? { compare } : {}) }, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setResult(value)
      })
      .catch(() => {
        if (!pending.signal.aborted) setError(true)
      })
    return () => pending.abort()
  }, [sessionId, selectedCall, read, comparisonInput])
  useEffect(() => {
    const pending = new AbortController()
    void read({ sessionId }, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setCalls(value.calls ?? [])
      })
      .catch(() => undefined)
    return () => pending.abort()
  }, [sessionId, read])
  const snapshot = result?.snapshot
  const previous = result?.previous
  const attempt = snapshot?.attempts[attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex]
  const rawUnavailable = attempt?.wire == null
  const currentText = snapshot ? value(snapshot, pane, attemptIndex) : ''
  return (
    <section className="request-trace" data-testid="request-trace" aria-label={t('title')}>
      <h3>{t('title')}</h3>
      {calls.length > 1 && (
        <Field label={t('call')} htmlFor={`request-trace-${callId}-call`}>
          <SettingsSelect
            id={`request-trace-${callId}-call`}
            data-testid="request-trace-call"
            value={selectedCall}
            onChange={(event) => {
              setSelectedCall(event.currentTarget.value)
              setDiff(false)
            }}
          >
            {calls.map((call, index) => (
              <option key={call.id} value={call.id}>
                {index + 1} ·{' '}
                {t(
                  call.kind === 'inference'
                    ? 'task'
                    : call.kind === 'compaction'
                      ? 'compaction'
                      : call.kind === 'summary'
                        ? 'summary'
                        : 'other',
                )}{' '}
                · {call.model}
              </option>
            ))}
          </SettingsSelect>
        </Field>
      )}
      {error ? (
        <SettingsState tone="error">{t('failed')}</SettingsState>
      ) : !result ? (
        <SettingsState>{t('loading')}</SettingsState>
      ) : !snapshot ? (
        <SettingsState>{t('missing')}</SettingsState>
      ) : (
        <>
          <SettingsDetails
            title={t(snapshot.capture === 'final-provider-body' ? 'wire' : 'adapter')}
            compact
            data-testid="request-trace-capture"
          >
            <p>
              {t('local')} {snapshot.redacted && t('redacted')} {snapshot.incomplete && t('incomplete')}
            </p>
            <p>{t('privacy')}</p>
            <p>{t('hashBasis')}</p>
            <SettingsCode label={t('details')}>
              {JSON.stringify(
                {
                  parentCallId: snapshot.id,
                  generationId: snapshot.generationId,
                  promptHash: snapshot.promptHash,
                  toolSchemaHash: snapshot.toolSchemaHash,
                  memoryRevision: snapshot.memoryRevision,
                  memoryHash: snapshot.memoryHash,
                  messagesHash: snapshot.messagesHash,
                  sourceHashes: snapshot.sourceHashes,
                  compactionBoundary: snapshot.compactionBoundary,
                  attempt: attempt ? { ...attempt, wire: undefined } : null,
                },
                null,
                2,
              )}
            </SettingsCode>
            {clear && (
              <SettingsToolbar>
                <SettingsCheckbox
                  label={t('confirmDelete')}
                  data-testid="request-trace-delete-confirm"
                  checked={confirmClear}
                  onChange={(event) => setConfirmClear(event.currentTarget.checked)}
                />
                <Button
                  data-testid="request-trace-delete"
                  disabled={!confirmClear}
                  onClick={() => {
                    void clear({ sessionId, callId: selectedCall })
                      .then(() => {
                        setResult({ snapshot: null, previous: null, unavailable: 'not-retained' })
                        setCalls(calls.filter((call) => call.id !== selectedCall))
                      })
                      .catch(() => setError(true))
                  }}
                >
                  {t('delete')}
                </Button>
              </SettingsToolbar>
            )}
          </SettingsDetails>
          {snapshot.attempts.length > 1 && (
            <Field label={t('attempt')} htmlFor={`request-trace-${callId}-attempt`}>
              <SettingsSelect
                id={`request-trace-${callId}-attempt`}
                data-testid="request-trace-attempt"
                value={attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex}
                onChange={(event) => {
                  setAttemptIndex(Number(event.currentTarget.value))
                  setDiff(false)
                }}
              >
                {snapshot.attempts.map((attempt, index) => (
                  <option key={attempt.attemptId} value={index}>
                    {index + 1} · {t(attempt.status === 'failed' ? 'failedAttempt' : attempt.status)} ·{' '}
                    {attempt.adapter.api}
                  </option>
                ))}
              </SettingsSelect>
            </Field>
          )}
          <div className="request-trace-controls">
            <div role="tablist" aria-label={t('title')} className="request-trace-tabs">
              {panes.map((name) => (
                <Button
                  key={name}
                  role="tab"
                  aria-selected={pane === name}
                  aria-controls={`request-trace-${callId}-panel`}
                  id={`request-trace-${callId}-${name}`}
                  data-testid={`request-trace-tab-${name}`}
                  type={pane === name ? 'primary' : 'default'}
                  onClick={() => {
                    setPane(name)
                    setCopied(false)
                  }}
                >
                  {t(name)}
                </Button>
              ))}
            </div>
            <SettingsToolbar>
              <SettingsCheckbox
                label={t('diff')}
                data-testid="request-trace-diff"
                checked={diff}
                disabled={!previous}
                onChange={(event) => setDiff(event.currentTarget.checked)}
              />
              <Button
                data-testid="request-trace-baseline"
                onClick={() => {
                  comparison = { sessionId, callId: selectedCall }
                  setBaseline(true)
                }}
              >
                {t(baseline ? 'selected' : 'baseline')}
              </Button>
              {comparison && (
                <Button
                  onClick={() => {
                    comparison = undefined
                    setBaseline(false)
                    setComparisonInput(undefined)
                  }}
                >
                  {t('clear')}
                </Button>
              )}
              <Button
                data-testid="request-trace-copy"
                disabled={!navigator.clipboard?.writeText || (pane === 'raw' && rawUnavailable)}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(currentText)
                    .then(() => setCopied(true))
                    .catch(() => setError(true))
                }}
              >
                {t(copied ? 'copied' : 'copy')}
              </Button>
            </SettingsToolbar>
          </div>
          {!previous && <p>{t('noPrevious')}</p>}
          <div
            role="tabpanel"
            id={`request-trace-${callId}-panel`}
            aria-labelledby={`request-trace-${callId}-${pane}`}
            data-testid="request-trace-content"
          >
            <p>{t(pane === 'raw' ? 'wire' : pane === 'tokens' ? 'tokenScope' : 'logical')}</p>
            {pane === 'raw' && rawUnavailable ? (
              <SettingsState>
                {t('wireMissing')} ·{' '}
                {t(
                  attempt?.wireUnavailable === 'capture-limit'
                    ? 'limit'
                    : attempt?.wireUnavailable === 'not-sent'
                      ? 'not-sent'
                      : attempt?.wireUnavailable === 'capture-failed'
                        ? 'captureFailed'
                        : 'unsupported',
                )}
              </SettingsState>
            ) : pane === 'tokens' ? (
              <>
                <SettingsCode label={t('actual')}>
                  {JSON.stringify(
                    attempt ? attempt.providerActualTokens : snapshot.tokens.providerActual,
                    null,
                    2,
                  ) ?? t('missingTokens')}
                </SettingsCode>
                <SettingsCode label={t('estimated')}>
                  {JSON.stringify(attempt ? attempt.estimatedTokens : snapshot.tokens.estimated, null, 2) ??
                    t('missingTokens')}
                </SettingsCode>
                {!(attempt ? attempt.providerActualTokens : snapshot.tokens.providerActual) && (
                  <p>{t('missingTokens')}</p>
                )}
              </>
            ) : diff && previous ? (
              <>
                <p>{t(value(previous, pane) === currentText ? 'unchanged' : 'changed')}</p>
                <SettingsCode
                  label={t(pane)}
                  className="request-trace-json"
                  data-testid="request-trace-diff-content"
                >
                  {requestDiff(value(previous, pane), currentText).map((part) =>
                    part.kind === 'removed' ? (
                      <del key={part.key}>
                        {part.text}
                        {'\n'}
                      </del>
                    ) : part.kind === 'added' ? (
                      <ins key={part.key}>
                        {part.text}
                        {'\n'}
                      </ins>
                    ) : (
                      <span key={part.key}>
                        {part.text}
                        {'\n'}
                      </span>
                    ),
                  )}
                </SettingsCode>
              </>
            ) : pane === 'system' ? (
              <>
                {snapshot.sections.map((section) => (
                  <SettingsDetails key={section.id} title={section.id} compact open>
                    <p data-testid="request-trace-source">{section.source}</p>
                    <SettingsCode label={t(pane)} className="request-trace-json">
                      {section.text}
                    </SettingsCode>
                  </SettingsDetails>
                ))}
                <SettingsDetails title={t('raw')} compact>
                  <SettingsCode label={t(pane)} className="request-trace-json">
                    {snapshot.system}
                  </SettingsCode>
                </SettingsDetails>
              </>
            ) : (
              <SettingsCode label={t(pane)} className="request-trace-json">
                {currentText}
              </SettingsCode>
            )}
          </div>
        </>
      )}
    </section>
  )
}
