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
  promptSourceLabel,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
  Tabs,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'

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
function tokenSummary(tokens: unknown, missing: string): string {
  if (!tokens || typeof tokens !== 'object') return missing
  const values = tokens as Record<string, unknown>
  return (
    ['input', 'output']
      .filter((key) => typeof values[key] === 'number')
      .map((key) => `${key === 'input' ? '↑' : '↓'} ${values[key]}`)
      .join(' · ') || missing
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
  const root = useRef<HTMLElement>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < 520)
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  const [compareMode, setCompareMode] = useState<'none' | 'previous' | 'fixed'>('none')
  const [copied, setCopied] = useState(false)
  const [comparisonInput, setComparisonInput] = useState(comparison)
  useEffect(() => {
    const pending = new AbortController()
    setResult(undefined)
    setError(false)
    setConfirmClear(false)
    const compare =
      compareMode === 'fixed' &&
      comparisonInput &&
      (comparisonInput.callId !== selectedCall || comparisonInput.sessionId !== sessionId)
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
  }, [sessionId, selectedCall, read, comparisonInput, compareMode])
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
  const diff = compareMode !== 'none'
  const attempt = snapshot?.attempts[attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex]
  const rawUnavailable = attempt?.wire == null
  const currentText = snapshot ? value(snapshot, pane, attemptIndex) : ''
  const content = snapshot ? (
    <div data-testid="request-trace-content">
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
            <SettingsDetails
              key={section.id}
              title={
                <span data-testid="request-trace-source" title={`${section.id} · ${section.source}`}>
                  {promptSourceLabel(section.id, section.source, locale)}
                </span>
              }
              compact
              open={section.id !== 'core:untrusted-envelope'}
            >
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
  ) : null
  return (
    <section ref={root} className="request-trace" data-testid="request-trace" aria-label={t('title')}>
      {error ? (
        <SettingsState tone="error">{t('failed')}</SettingsState>
      ) : !result ? (
        <SettingsState>{t('loading')}</SettingsState>
      ) : !snapshot ? (
        <SettingsState>{t('missing')}</SettingsState>
      ) : (
        <>
          <header className="request-trace-header">
            <h3>{t('title')}</h3>
            <div className="request-trace-summary" data-testid="request-trace-summary">
              <strong>
                {typeof snapshot.params === 'object' && snapshot.params && 'model' in snapshot.params
                  ? String(snapshot.params.model ?? t('unknown'))
                  : t('unknown')}
              </strong>
              <span>
                {t('attemptCount', {
                  n: attempt ? (attemptIndex < 0 ? snapshot.attempts.length : attemptIndex + 1) : 0,
                  total: snapshot.attempts.length,
                })}
              </span>
              <span>
                {t(attempt?.status === 'failed' ? 'failedAttempt' : (attempt?.status ?? 'unknown'))}
              </span>
              <span>
                {t('actual')}:{' '}
                {tokenSummary(
                  attempt ? attempt.providerActualTokens : snapshot.tokens.providerActual,
                  t('unknown'),
                )}
              </span>
              <span>
                {t('estimated')}:{' '}
                {tokenSummary(attempt ? attempt.estimatedTokens : snapshot.tokens.estimated, t('unknown'))}
              </span>
              <time dateTime={snapshot.createdAt} title={snapshot.createdAt}>
                {new Date(snapshot.createdAt).toLocaleString(locale)}
              </time>
            </div>
            <div className="request-trace-selectors">
              {calls.length > 1 && (
                <Field label={t('call')} htmlFor={`request-trace-${callId}-call`}>
                  <SettingsSelect
                    id={`request-trace-${callId}-call`}
                    data-testid="request-trace-call"
                    value={selectedCall}
                    onChange={(event) => {
                      setSelectedCall(event.currentTarget.value)
                      setAttemptIndex(-1)
                      setCompareMode('none')
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

              {snapshot.attempts.length > 1 && (
                <Field label={t('attempt')} htmlFor={`request-trace-${callId}-attempt`}>
                  <SettingsSelect
                    id={`request-trace-${callId}-attempt`}
                    data-testid="request-trace-attempt"
                    value={attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex}
                    onChange={(event) => {
                      setAttemptIndex(Number(event.currentTarget.value))
                      setCompareMode('none')
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
            </div>
            <div className="request-trace-actions">
              <label htmlFor={`request-trace-${callId}-compare`}>{t('compare')}</label>
              <SettingsSelect
                id={`request-trace-${callId}-compare`}
                data-testid="request-trace-compare"
                value={compareMode}
                onChange={(event) => {
                  const mode = event.currentTarget.value
                  if (mode === 'pin') {
                    comparison = { sessionId, callId: selectedCall }
                    setComparisonInput(comparison)
                    setCompareMode('none')
                  } else if (mode === 'clear') {
                    comparison = undefined
                    setComparisonInput(undefined)
                    setCompareMode('none')
                  } else setCompareMode(mode as 'none' | 'previous' | 'fixed')
                }}
              >
                <option value="none">{t('none')}</option>
                <option value="previous" disabled={!previous}>
                  {t('previousRequest')}
                </option>
                <option
                  value="fixed"
                  disabled={
                    !comparisonInput ||
                    (comparisonInput.sessionId === sessionId && comparisonInput.callId === selectedCall)
                  }
                >
                  {t('fixedBaseline')}
                </option>
                <optgroup label={t('baselineActions')}>
                  <option value="pin">{t('baseline')}</option>
                  <option value="clear" disabled={!comparisonInput}>
                    {t('clear')}
                  </option>
                </optgroup>
              </SettingsSelect>
              <Button
                data-testid="request-trace-copy"
                aria-label={t(copied ? 'copied' : 'copy')}
                title={t(copied ? 'copied' : 'copy')}
                size="small"
                disabled={!navigator.clipboard?.writeText || (pane === 'raw' && rawUnavailable)}
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                    <path d="M16 8V4H4v12h4" />
                  </svg>
                }
                onClick={() => {
                  void navigator.clipboard
                    .writeText(currentText)
                    .then(() => setCopied(true))
                    .catch(() => setError(true))
                }}
              />
              {copied && <span role="status">{t('copied')}</span>}
            </div>
          </header>
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
          {compact ? (
            <>
              <Field label={t('viewContent')} htmlFor={`request-trace-${callId}-pane`}>
                <SettingsSelect
                  id={`request-trace-${callId}-pane`}
                  data-testid="request-trace-pane"
                  value={pane}
                  onChange={(event) => {
                    setPane(event.currentTarget.value as Pane)
                    setCopied(false)
                  }}
                >
                  {panes.map((name) => (
                    <option key={name} value={name}>
                      {t(name)}
                    </option>
                  ))}
                </SettingsSelect>
              </Field>
              {content}
            </>
          ) : (
            <Tabs
              className="request-trace-tabs"
              size="small"
              destroyOnHidden
              activeKey={pane}
              onChange={(name) => {
                setPane(name as Pane)
                setCopied(false)
              }}
              items={panes.map((name) => ({
                key: name,
                children: name === pane ? content : null,
                label: <span data-testid={`request-trace-tab-${name}`}>{t(name)}</span>,
              }))}
            />
          )}
          {!previous && <p>{t('noPrevious')}</p>}
        </>
      )}
    </section>
  )
}
