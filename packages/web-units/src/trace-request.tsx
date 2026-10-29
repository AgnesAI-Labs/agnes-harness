import type {
  ModelRequestClearParams,
  ModelRequestClearResult,
  ModelRequestParams,
  ModelRequestResult,
  ModelRequestSnapshot,
} from '@agnes/protocol'
import {
  Button,
  CopyButton,
  createCatalogTranslator,
  promptSourceLabel,
  Segmented,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsSelect,
  SettingsState,
  SettingsToolbar,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'

import { requestTraceCatalog } from './trace-request-locale.js'

type Translate = ReturnType<typeof createCatalogTranslator>
type Section = 'system' | 'tools' | 'messages' | 'params'
const SECTIONS: readonly Section[] = ['system', 'tools', 'messages', 'params']
export type CompareMode = 'none' | 'previous' | 'fixed'
export type ReadModelRequest = (
  params: ModelRequestParams,
  signal?: AbortSignal,
) => Promise<ModelRequestResult>

let baseline: { sessionId: string; callId: string } | undefined
/** One comparison baseline for the page: pinned on one request, compared from another. */
export const requestBaseline = {
  get: () => baseline,
  pin(value: { sessionId: string; callId: string }) {
    baseline = value
  },
  clear() {
    baseline = undefined
  },
}

const sectionText = (snapshot: ModelRequestSnapshot, section: Section): string =>
  section === 'system' ? snapshot.system : JSON.stringify(snapshot[section], null, 2)
const size = (text: string): string =>
  text.length < 1024 ? `${text.length} B` : `${(text.length / 1024).toFixed(1)} KB`
const length = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

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

/**
 * The calls that belong to this step: the request itself and the non-task calls (compaction,
 * summary) made since the previous task request, in the order the session recorded them.
 */
export function stepCalls(
  calls: NonNullable<ModelRequestResult['calls']>,
  callId: string,
): NonNullable<ModelRequestResult['calls']> {
  const index = calls.findIndex((call) => call.id === callId)
  if (index < 0) return []
  let start = index
  while (start > 0 && calls[start - 1]?.kind !== 'inference') start--
  return calls.slice(start, index + 1)
}

export type RequestTraceState = ReturnType<typeof useRequestTrace>

/** Reads one model request (and the session's call list) for the inspector's request tabs. */
export function useRequestTrace({
  sessionId,
  callId,
  read,
  locale = 'en',
}: {
  sessionId: string
  callId: string
  read: ReadModelRequest
  locale?: 'en' | 'zh-CN'
}) {
  const t: Translate = createCatalogTranslator(requestTraceCatalog, locale)
  const [selectedCall, setSelectedCall] = useState(callId)
  const [attemptIndex, setAttemptIndex] = useState(-1)
  const [compare, setCompare] = useState<CompareMode>('none')
  const [calls, setCalls] = useState<NonNullable<ModelRequestResult['calls']>>([])
  const [result, setResult] = useState<ModelRequestResult>()
  const [error, setError] = useState(false)
  const fixed = compare === 'fixed' ? requestBaseline.get() : undefined
  const fixedKey = fixed ? `${fixed.sessionId}:${fixed.callId}` : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: fixedKey names the pinned baseline read.
  useEffect(() => {
    const pending = new AbortController()
    setResult(undefined)
    setError(false)
    const against =
      fixed && (fixed.callId !== selectedCall || fixed.sessionId !== sessionId) ? fixed : undefined
    read({ sessionId, callId: selectedCall, ...(against ? { compare: against } : {}) }, pending.signal).then(
      (value) => {
        if (!pending.signal.aborted) setResult(value)
      },
      () => {
        if (!pending.signal.aborted) setError(true)
      },
    )
    return () => pending.abort()
  }, [sessionId, selectedCall, read, fixedKey])
  useEffect(() => {
    const pending = new AbortController()
    read({ sessionId }, pending.signal).then(
      (value) => {
        if (!pending.signal.aborted) setCalls(value.calls ?? [])
      },
      () => undefined,
    )
    return () => pending.abort()
  }, [sessionId, read])
  const snapshot = result?.snapshot ?? undefined
  const attempt = snapshot?.attempts[attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex]
  return {
    t,
    locale,
    sessionId,
    callId,
    selectedCall,
    selectCall(id: string) {
      setSelectedCall(id)
      setAttemptIndex(-1)
      setCompare('none')
    },
    calls: stepCalls(calls, callId),
    result,
    error,
    snapshot,
    previous: result?.previous ?? undefined,
    attempt,
    attemptIndex,
    setAttemptIndex,
    compare,
    setCompare,
    cleared() {
      setResult({ snapshot: null, previous: null, unavailable: 'not-retained' })
      setCalls((value) => value.filter((call) => call.id !== selectedCall))
    },
    failed: () => setError(true),
  }
}

function RequestStatus({ state }: { state: RequestTraceState }) {
  const { t } = state
  if (state.error) return <SettingsState tone="error">{t('failed')}</SettingsState>
  if (!state.result) return <SettingsState>{t('loading')}</SettingsState>
  return <SettingsState>{t('missing')}</SettingsState>
}

function Diff({ before, after, label }: { before: string; after: string; label: string }) {
  return (
    <SettingsCode label={label} className="request-trace-json" data-testid="request-trace-diff-content">
      {requestDiff(before, after).map((part) => {
        const Tag = part.kind === 'removed' ? 'del' : part.kind === 'added' ? 'ins' : 'span'
        return (
          <Tag key={part.key}>
            {part.text}
            {'\n'}
          </Tag>
        )
      })}
    </SettingsCode>
  )
}

/** «Request contents»: the logical request in folded sections, or the JSON actually sent. */
export function RequestContent({ state }: { state: RequestTraceState }) {
  const { t, snapshot, attempt, previous, compare } = state
  const [mode, setMode] = useState<'logical' | 'wire'>('logical')
  if (!snapshot) return <RequestStatus state={state} />
  const wireMissing = attempt?.wire == null
  const comparing = compare !== 'none' && previous !== undefined
  const copyText =
    mode === 'wire'
      ? JSON.stringify(attempt?.wire ?? null, null, 2)
      : JSON.stringify(
          {
            system: snapshot.system,
            tools: snapshot.tools,
            messages: snapshot.messages,
            params: snapshot.params,
          },
          null,
          2,
        )
  const meta = (section: Section): string => {
    const text = sectionText(snapshot, section)
    if (section === 'system') return t('sectionsMeta', { n: snapshot.sections.length, size: size(text) })
    if (section === 'tools') return t('toolsMeta', { n: length(snapshot.tools), size: size(text) })
    if (section === 'messages') return t('messagesMeta', { n: length(snapshot.messages), size: size(text) })
    return t('sizeOnly', { size: size(text) })
  }
  return (
    <section className="request-trace" data-testid="request-trace" aria-label={t('title')}>
      <div className="request-trace-bar">
        <Segmented
          label={t('modeLabel')}
          value={mode}
          testId="request-trace-mode"
          options={[
            { value: 'logical', label: t('modeLogical') },
            { value: 'wire', label: t('modeWire') },
          ]}
          onChange={(value) => setMode(value === 'wire' ? 'wire' : 'logical')}
        />
        {state.calls.length > 1 ? (
          <SettingsSelect
            aria-label={t('callLabel')}
            data-testid="request-trace-call"
            value={state.selectedCall}
            onChange={(event) => state.selectCall(event.currentTarget.value)}
          >
            {state.calls.map((call, index) => (
              <option key={call.id} value={call.id}>
                {t('callOption', {
                  n: index + 1,
                  kind: t(
                    call.kind === 'inference'
                      ? 'task'
                      : call.kind === 'compaction'
                        ? 'compaction'
                        : call.kind === 'summary'
                          ? 'summary'
                          : 'other',
                  ),
                })}
              </option>
            ))}
          </SettingsSelect>
        ) : null}
        <CopyButton
          className="request-trace-copy"
          data-testid="request-trace-copy"
          label={t('copy')}
          copiedLabel={t('copied')}
          text={copyText}
          disabled={mode === 'wire' && wireMissing}
        />
      </div>
      {compare !== 'none' ? (
        <p className="request-trace-note" role="status">
          {previous ? t(compare === 'fixed' ? 'comparingFixed' : 'comparingPrevious') : t('noPrevious')}
        </p>
      ) : null}
      <div data-testid="request-trace-content">
        {mode === 'wire' ? (
          wireMissing ? (
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
          ) : (
            <SettingsCode label={t('wire')} className="request-trace-json">
              {JSON.stringify(attempt?.wire ?? null, null, 2)}
            </SettingsCode>
          )
        ) : (
          SECTIONS.map((section) => {
            const text = sectionText(snapshot, section)
            const before = comparing && previous ? sectionText(previous, section) : undefined
            return (
              <SettingsDetails
                key={`${snapshot.id}:${section}:${compare}:${previous?.id ?? ''}`}
                data-testid={`request-trace-section-${section}`}
                className="request-trace-section"
                compact
                defaultOpen={section === 'system' || (before !== undefined && before !== text)}
                title={t(section)}
                summary={before === undefined ? meta(section) : t(before === text ? 'unchanged' : 'changed')}
              >
                {before !== undefined ? (
                  <Diff before={before} after={text} label={t(section)} />
                ) : section === 'system' ? (
                  <>
                    {snapshot.sections.map((part) => (
                      <SettingsDetails
                        key={part.id}
                        compact
                        defaultOpen={part.id !== 'core:untrusted-envelope'}
                        title={
                          <span data-testid="request-trace-source" title={`${part.id} · ${part.source}`}>
                            {promptSourceLabel(part.id, part.source, state.locale)}
                          </span>
                        }
                      >
                        <SettingsCode label={t('system')} className="request-trace-json">
                          {part.text}
                        </SettingsCode>
                      </SettingsDetails>
                    ))}
                    {snapshot.sections.length === 0 ? (
                      <SettingsCode label={t('system')} className="request-trace-json">
                        {text}
                      </SettingsCode>
                    ) : null}
                  </>
                ) : (
                  <SettingsCode label={t(section)} className="request-trace-json">
                    {text}
                  </SettingsCode>
                )}
              </SettingsDetails>
            )
          })
        )}
      </div>
    </section>
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

/** «Usage»'s request half: the sending attempt and the tokens the provider reported or we estimated. */
export function RequestUsage({ state }: { state: RequestTraceState }) {
  const { t, snapshot, attempt, attemptIndex } = state
  if (!snapshot) return <RequestStatus state={state} />
  const actual = attempt ? attempt.providerActualTokens : snapshot.tokens.providerActual
  const estimated = attempt ? attempt.estimatedTokens : snapshot.tokens.estimated
  const model =
    typeof snapshot.params === 'object' && snapshot.params && 'model' in snapshot.params
      ? String(snapshot.params.model ?? t('unknown'))
      : t('unknown')
  return (
    <section className="request-trace" data-testid="request-trace-usage">
      <div className="request-trace-summary" data-testid="request-trace-summary">
        <strong>{model}</strong>
        <span>
          {t('attemptCount', {
            n: attempt ? (attemptIndex < 0 ? snapshot.attempts.length : attemptIndex + 1) : 0,
            total: snapshot.attempts.length,
          })}
        </span>
        <span>{t(attempt?.status === 'failed' ? 'failedAttempt' : (attempt?.status ?? 'unknown'))}</span>
        <span>
          {t('actual')}: {tokenSummary(actual, t('unknown'))}
        </span>
        <span>
          {t('estimated')}: {tokenSummary(estimated, t('unknown'))}
        </span>
        <time dateTime={snapshot.createdAt} title={snapshot.createdAt}>
          {new Date(snapshot.createdAt).toLocaleString(state.locale)}
        </time>
      </div>
      {snapshot.attempts.length > 1 ? (
        <SettingsSelect
          aria-label={t('attempt')}
          data-testid="request-trace-attempt"
          value={attemptIndex < 0 ? snapshot.attempts.length - 1 : attemptIndex}
          onChange={(event) => state.setAttemptIndex(Number(event.currentTarget.value))}
        >
          {snapshot.attempts.map((item, index) => (
            <option key={item.attemptId} value={index}>
              {index + 1} · {t(item.status === 'failed' ? 'failedAttempt' : item.status)} · {item.adapter.api}
            </option>
          ))}
        </SettingsSelect>
      ) : null}
      <SettingsCode label={t('actual')}>{JSON.stringify(actual, null, 2) ?? t('missingTokens')}</SettingsCode>
      <SettingsCode label={t('estimated')}>
        {JSON.stringify(estimated, null, 2) ?? t('missingTokens')}
      </SettingsCode>
      {!actual ? <p className="request-trace-note">{t('missingTokens')}</p> : null}
      <p className="request-trace-note">{t('tokenScope')}</p>
    </section>
  )
}

/** Capture details and the explicit local delete, folded inside «Provenance». */
export function RequestCapture({
  state,
  clear,
}: {
  state: RequestTraceState
  clear?: ((params: ModelRequestClearParams) => Promise<ModelRequestClearResult>) | undefined
}) {
  const { t, snapshot, attempt } = state
  const [confirm, setConfirm] = useState(false)
  if (!snapshot) return null
  return (
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
      {clear ? (
        <SettingsToolbar>
          <SettingsCheckbox
            label={t('confirmDelete')}
            data-testid="request-trace-delete-confirm"
            checked={confirm}
            onChange={(event) => setConfirm(event.currentTarget.checked)}
          />
          <Button
            data-testid="request-trace-delete"
            disabled={!confirm}
            onClick={() => {
              clear({ sessionId: state.sessionId, callId: state.selectedCall }).then(
                state.cleared,
                state.failed,
              )
            }}
          >
            {t('delete')}
          </Button>
        </SettingsToolbar>
      ) : null}
    </SettingsDetails>
  )
}
