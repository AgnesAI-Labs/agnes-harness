import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import {
  Button,
  Disclosure,
  formatTokens,
  Icon,
  SettingsInput,
  SettingsState,
  StatusDot,
  type StatusDotTone,
} from '@agnes/web-ui'
import { type ChangeEvent, type ReactNode, useRef, useState } from 'react'
import type {
  ComposerChildAction,
  ComposerChildControlOptions,
  ComposerChildControlOutcome,
  ComposerDependencies,
} from './contracts.js'

type ChildStatus = SessionControlledChild['status']
/** The status mark a child takes. Words in the row stay the signal; colour only backs them. */
const CHILD_MARK: Record<ChildStatus, { dot: StatusDotTone; tag?: 'ok' | 'warn' | 'bad' | 'info' }> = {
  starting: { dot: 'accent', tag: 'info' },
  running: { dot: 'accent', tag: 'info' },
  waiting_approval: { dot: 'warning', tag: 'warn' },
  paused: { dot: 'warning', tag: 'warn' },
  disconnected: { dot: 'warning', tag: 'warn' },
  idle: { dot: 'neutral' },
  completed: { dot: 'success', tag: 'ok' },
  failed: { dot: 'danger', tag: 'bad' },
  cancelled: { dot: 'neutral' },
  interrupted: { dot: 'warning', tag: 'warn' },
}
const WORKING = new Set<ChildStatus>(['starting', 'running'])
const ATTENTION = new Set<ChildStatus>(['waiting_approval', 'paused', 'disconnected'])
const DANGER_ACTIONS = new Set<ComposerChildAction>(['stop', 'close'])

function needsAttention(child: SessionControlledChild): boolean {
  return ATTENTION.has(child.status) || (child.status === 'interrupted' && child.controls.continue === true)
}

function isActiveChild(child: SessionControlledChild): boolean {
  return WORKING.has(child.status) || needsAttention(child)
}

function isChildActionAvailable(child: SessionControlledChild, action: ComposerChildAction): boolean {
  if (action === 'recap') return child.providerId === 'in-process'
  if (action === 'resume') return child.status === 'paused' && Boolean(child.controls.resume)
  return Boolean(child.controls[action])
}

function nextIntentCommandId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Strip only paired Markdown formatting markers and leading ATX heading hashes while preserving
 * literal characters such as underscores in identifiers (`web_search`, `lane_1.txt`) and hashes
 * (`C#`, `#42`).
 */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(（【「『[])__([^_]+)__(?=$|[\s.,;:!?。，；：！？)）】」』\]])/g, '$1$2')
    .replace(/(^|[\s(（【「『[])\*([^*\s][^*]*?)\*(?=$|[\s.,;:!?。，；：！？)）】」』\]])/g, '$1$2')
    .replace(/(^|[\s(（【「『[])_([^_\s][^_]*?)_(?=$|[\s.,;:!?。，；：！？)）】」』\]])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function childLabelText(child: SessionControlledChild): string {
  return child.label ? stripMarkdownFormatting(child.label) : ''
}

function childShortId(child: SessionControlledChild): string {
  return child.id.slice(-6)
}

/**
 * A child prefers its human-readable task label when present (stripped of paired markdown markers);
 * otherwise falls back to its provider/subagent label with the trailing id segment.
 */
function childName(child: SessionControlledChild, t: ComposerDependencies['translate']): string {
  const label = childLabelText(child)
  if (label) return label
  const name = child.providerId === 'in-process' ? t('composer.child.name') : child.providerId
  return `${name} · ${childShortId(child)}`
}

function formatChildMetrics(child: SessionControlledChild, t: ComposerDependencies['translate']): string {
  const hasTokens = child.totalTokens !== null
  const hasDuration = child.durationMs !== null
  if (!hasTokens && !hasDuration) return t('composer.child.metricsEmpty')
  if (hasTokens && hasDuration)
    return t('composer.child.metrics', {
      tokens: formatTokens(child.totalTokens!),
      seconds: (child.durationMs! / 1000).toFixed(1),
    })
  if (hasTokens) return t('composer.child.metricsTokens', { tokens: formatTokens(child.totalTokens!) })
  return t('composer.child.metricsDuration', { seconds: (child.durationMs! / 1000).toFixed(1) })
}

function childTreeMeta(
  nodes: readonly SessionControlledChild[],
  t: ComposerDependencies['translate'],
): string | undefined {
  if (!nodes.length) return undefined
  const working = nodes.filter((child) => WORKING.has(child.status)).length
  const attention = nodes.filter((child) => needsAttention(child)).length
  const failed = nodes.filter((child) => child.status === 'failed').length
  const settled = nodes.filter((child) => !isActiveChild(child)).length
  if (working > 0 && attention === 0)
    return settled > 0
      ? t('composer.child.summaryMixed', { working, done: settled })
      : t('composer.child.workingCount', { count: working })
  const parts: string[] = []
  if (working > 0) parts.push(t('composer.child.workingCount', { count: working }))
  if (attention > 0) parts.push(t('composer.child.attentionCount', { count: attention }))
  if (working === 0 && attention === 0) {
    if (failed > 0 && failed === settled) parts.push(t('composer.child.failedCount', { count: failed }))
    else {
      if (settled - failed > 0) parts.push(t('composer.child.settledCount', { count: settled - failed }))
      if (failed > 0) parts.push(t('composer.child.failedCount', { count: failed }))
    }
  } else if (settled > 0) {
    parts.push(t('composer.child.settledCount', { count: settled }))
  }
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * A child agent is a job of this session, not a session of its own: its name asks the terminal
 * panel for that job's tab instead of navigating to a session URL nobody can resolve.
 */
function openChildJob(target: EventTarget, childId: string): void {
  target.dispatchEvent(new CustomEvent('agnes:open-terminal-job', { bubbles: true, detail: { childId } }))
}

/**
 * The children a session started, above the composer: one row per workflow or subagent session,
 * nested under its parent. Any subtree containing a live or attention-needed descendant stays
 * pinned in the active group so pending approvals and continuable stops never hide in folded history.
 */
export function ChildControlTree({
  nodes,
  disabled = false,
  control,
  t,
}: {
  nodes: readonly SessionControlledChild[]
  disabled?: boolean
  control: (
    id: string,
    action: ComposerChildAction,
    text?: string,
    options?: ComposerChildControlOptions,
  ) => Promise<void | ComposerChildControlOutcome>
  t: ComposerDependencies['translate']
}) {
  const byId = new Map(nodes.map((child) => [child.id, child]))
  const childrenByParent = new Map<string, SessionControlledChild[]>()
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId)
    if (siblings) siblings.push(node)
    else childrenByParent.set(node.parentId, [node])
  }
  const subtreeLive = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false
    const node = byId.get(id)
    if (!node) return false
    if (isActiveChild(node)) return true
    const next = new Set([...seen, id])
    return (childrenByParent.get(id) ?? []).some((child) => subtreeLive(child.id, next))
  }
  const subtreeCount = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id) || !byId.has(id)) return 0
    const next = new Set([...seen, id])
    return (childrenByParent.get(id) ?? []).reduce((sum, child) => sum + subtreeCount(child.id, next), 1)
  }
  const roots = nodes.filter((child) => !byId.has(child.parentId))
  const liveRoots = roots.filter((child) => subtreeLive(child.id))
  const settledRoots = roots.filter((child) => !subtreeLive(child.id))
  const foldHistory = liveRoots.length > 0 && settledRoots.length > 0
  const historyCount = settledRoots.reduce((sum, root) => sum + subtreeCount(root.id), 0)
  const meta = childTreeMeta(nodes, t)
  const renderChild = (child: SessionControlledChild, seen = new Set<string>()): ReactNode => {
    if (seen.has(child.id)) return null
    const next = new Set([...seen, child.id])
    const children = childrenByParent.get(child.id) ?? []
    return (
      <li
        key={child.id}
        className="composer-child"
        data-testid="child-control-row"
        data-child-id={child.id}
        data-status={child.status}
      >
        <ChildControlRow child={child} disabled={disabled} control={control} t={t} />
        {children.length ? (
          <ul className="composer-children-sublist">{children.map((row) => renderChild(row, next))}</ul>
        ) : null}
      </li>
    )
  }
  return (
    <Disclosure
      variant="row"
      className="composer-children"
      data-testid="child-control-tree"
      icon={<Icon name="route" size={16} />}
      summary={t('composer.child.title')}
      meta={meta}
    >
      <ul className="composer-children-list">
        {(foldHistory ? liveRoots : [...liveRoots, ...settledRoots]).map((child) => renderChild(child))}
      </ul>
      {foldHistory ? (
        <Disclosure
          variant="plain"
          className="composer-children-history"
          data-testid="child-control-history"
          summary={t('composer.child.finishedGroup', { count: historyCount })}
        >
          <ul className="composer-children-list">{settledRoots.map((child) => renderChild(child))}</ul>
        </Disclosure>
      ) : null}
    </Disclosure>
  )
}

export function ChildControlRow({
  child,
  disabled = false,
  control,
  t,
}: {
  child: SessionControlledChild
  disabled?: boolean
  control: (
    id: string,
    action: ComposerChildAction,
    text?: string,
    options?: ComposerChildControlOptions,
  ) => Promise<void | ComposerChildControlOutcome>
  t: ComposerDependencies['translate']
}) {
  const [text, setText] = useState('')
  const [replyOpen, setReplyOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<ComposerChildAction | null>(null)
  const [retryingRefresh, setRetryingRefresh] = useState(false)
  const [error, setError] = useState('')
  const [refreshWarning, setRefreshWarning] = useState<{
    message: string
    retry?: () => Promise<void>
  } | null>(null)
  const intentCommandIds = useRef(
    new Map<ComposerChildAction, { childId: string; text: string | undefined; commandId: string }>(),
  )
  for (const [savedAction, saved] of intentCommandIds.current) {
    if (
      saved.childId !== child.id ||
      !isChildActionAvailable(child, savedAction) ||
      (savedAction === 'continue' && saved.text !== text)
    )
      intentCommandIds.current.delete(savedAction)
  }
  const pending = pendingAction !== null
  const mark = CHILD_MARK[child.status]
  const working = WORKING.has(child.status)
  const showReply = child.controls.continue && replyOpen
  const labelText = childLabelText(child)
  const shortId = childShortId(child)
  const name = childName(child, t)
  const accessibleName = labelText ? `${shortId} · ${name}` : name
  const steerLabel = t(working ? 'composer.child.steer' : 'composer.child.continue')
  const sendLabel = t(working ? 'composer.child.send' : 'composer.child.continue')
  const primaryAction: ComposerChildAction | 'steer' | undefined =
    child.status === 'paused' && child.controls.resume
      ? 'resume'
      : (child.status === 'idle' || child.status === 'interrupted') && child.controls.continue
        ? 'steer'
        : undefined
  const submit = (action: ComposerChildAction) => {
    if (pending) return
    const payloadText = action === 'continue' ? text : undefined
    const saved = intentCommandIds.current.get(action)
    const commandId =
      saved && saved.childId === child.id && saved.text === payloadText
        ? saved.commandId
        : nextIntentCommandId()
    intentCommandIds.current.set(action, { childId: child.id, text: payloadText, commandId })
    setPendingAction(action)
    setError('')
    setRefreshWarning(null)
    void control(child.id, action, payloadText, { commandId })
      .then((outcome) => {
        if (intentCommandIds.current.get(action)?.commandId === commandId)
          intentCommandIds.current.delete(action)
        if (action === 'continue') {
          setText('')
          setReplyOpen(false)
        }
        if (outcome?.refreshFailed) {
          setRefreshWarning({
            message: outcome.refreshFailed,
            ...(outcome.retryRefresh ? { retry: outcome.retryRefresh } : {}),
          })
        }
      })
      .catch((cause: unknown) =>
        setError(
          t('composer.child.controlFailed', {
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      )
      .finally(() => setPendingAction(null))
  }
  const retryReadOnlyRefresh = () => {
    const retry = refreshWarning?.retry
    if (!retry || retryingRefresh) return
    setRetryingRefresh(true)
    void retry()
      .then(() => setRefreshWarning(null))
      .catch((cause: unknown) =>
        setRefreshWarning({
          message: cause instanceof Error ? cause.message : t('composer.child.refreshFailed'),
          retry,
        }),
      )
      .finally(() => setRetryingRefresh(false))
  }
  return (
    <>
      <div className="composer-child-head">
        <StatusDot tone={mark.dot} running={working} />
        <Button
          htmlType="button"
          size="small"
          appearance="ghost"
          className="composer-child-name"
          data-testid="child-open"
          aria-label={t('composer.child.openAria', { name: accessibleName })}
          title={labelText ? `${labelText} (${child.id})` : child.id}
          onClick={(event) => openChildJob(event.currentTarget, child.id)}
        >
          <span className="composer-child-title">{name}</span>
        </Button>
        {labelText ? (
          <span className="composer-child-id" title={child.id}>
            {shortId}
          </span>
        ) : null}
        <span role="status" className="composer-child-state" data-tone={mark.tag}>
          {t(`composer.child.${child.status}`)}
        </span>
        <p className="composer-child-metrics" data-testid="child-control-metrics">
          {formatChildMetrics(child, t)}
        </p>
        <fieldset className="composer-child-actions" aria-label={accessibleName}>
          {child.controls.continue ? (
            <Button
              htmlType="button"
              size="small"
              appearance="ghost"
              className="composer-child-steer"
              data-testid="child-steer-toggle"
              data-emphasis={primaryAction === 'steer' ? 'primary' : undefined}
              aria-expanded={replyOpen}
              aria-label={t('composer.child.actionAria', { action: steerLabel, name: accessibleName })}
              title={t(working ? 'composer.child.steerTitle' : 'composer.child.continueTitle')}
              disabled={disabled || pending}
              onClick={() => setReplyOpen((open) => !open)}
            >
              {steerLabel}
            </Button>
          ) : null}
          {(['stop', 'pause', 'resume', 'close', 'retain', 'recap'] as const).map((action) => {
            if (!isChildActionAvailable(child, action)) return null
            const label = t(`composer.child.${action}`)
            const busyThis = pendingAction === action
            return (
              <Button
                key={action}
                htmlType="button"
                size="small"
                appearance="ghost"
                className="composer-child-action"
                data-testid={`child-${action}`}
                data-emphasis={primaryAction === action ? 'primary' : undefined}
                data-danger={DANGER_ACTIONS.has(action) ? 'true' : undefined}
                aria-busy={busyThis || undefined}
                aria-label={t('composer.child.actionAria', { action: label, name: accessibleName })}
                title={t(`composer.child.${action}Title`)}
                disabled={disabled || pending}
                onClick={() => submit(action)}
              >
                {busyThis ? t('composer.child.submitting') : label}
              </Button>
            )
          })}
        </fieldset>
      </div>
      {showReply ? (
        <div className="composer-child-reply">
          <SettingsInput
            data-testid="child-continue-message"
            aria-label={
              labelText
                ? t('composer.child.messageAria', { name: accessibleName })
                : t('composer.child.message')
            }
            placeholder={t('composer.child.message')}
            value={text}
            disabled={disabled || pending}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const next = event.currentTarget.value
              if (next !== text) intentCommandIds.current.delete('continue')
              setText(next)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (text.trim()) submit('continue')
            }}
          />
          <Button
            htmlType="button"
            size="small"
            appearance="primary"
            data-testid="child-continue"
            aria-busy={pendingAction === 'continue' || undefined}
            aria-label={t('composer.child.actionAria', { action: sendLabel, name: accessibleName })}
            disabled={disabled || pending || !text.trim()}
            title={text.trim() ? sendLabel : t('composer.child.messageRequired')}
            onClick={() => submit('continue')}
          >
            {pendingAction === 'continue' ? t('composer.child.submitting') : sendLabel}
          </Button>
        </div>
      ) : null}
      {refreshWarning ? (
        <SettingsState
          tone="empty"
          className="composer-child-refresh-warning"
          data-testid="child-refresh-warning"
        >
          <span>{t('composer.child.refreshFailed')}</span>
          {refreshWarning.retry ? (
            <Button
              htmlType="button"
              size="small"
              appearance="ghost"
              data-testid="child-refresh-retry"
              disabled={retryingRefresh}
              onClick={retryReadOnlyRefresh}
            >
              {t('composer.child.refreshRetry')}
            </Button>
          ) : null}
        </SettingsState>
      ) : null}
      {error ? (
        <SettingsState tone="error" className="composer-child-error">
          {error}
        </SettingsState>
      ) : null}
    </>
  )
}
