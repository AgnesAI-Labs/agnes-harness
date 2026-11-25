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
import { type ChangeEvent, type ReactNode, useState } from 'react'
import type { ComposerChildAction, ComposerDependencies } from './contracts.js'

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
const LIVE = new Set<ChildStatus>(['starting', 'running', 'waiting_approval', 'paused', 'disconnected'])

/**
 * A child prefers its human-readable task label when present (stripped of raw markdown markers);
 * otherwise falls back to its provider/subagent label with the trailing id segment.
 */
function childName(child: SessionControlledChild, t: ComposerDependencies['translate']): string {
  const label = child.label
    ?.replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (label) return label
  const name = child.providerId === 'in-process' ? t('composer.child.name') : child.providerId
  return `${name} · ${child.id.slice(-6)}`
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
 * nested under its parent. Live children stay pinned on top; idle/finished/cancelled history folds
 * underneath when live work is running so prior batches never crowd out active tasks.
 */
export function ChildControlTree({
  nodes,
  disabled = false,
  control,
  t,
}: {
  nodes: readonly SessionControlledChild[]
  disabled?: boolean
  control: (id: string, action: ComposerChildAction, text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const ids = new Set(nodes.map((child) => child.id))
  const working = nodes.filter((child) => WORKING.has(child.status)).length
  const settled = nodes.filter((child) => !LIVE.has(child.status)).length
  const roots = nodes.filter((child) => !ids.has(child.parentId))
  const liveRoots = roots.filter((child) => LIVE.has(child.status))
  const settledRoots = roots.filter((child) => !LIVE.has(child.status))
  const foldHistory = liveRoots.length > 0 && settledRoots.length > 0
  const meta =
    working && settled
      ? t('composer.child.summaryMixed', { working, done: settled })
      : working
        ? t('composer.child.workingCount', { count: working })
        : undefined
  const renderChild = (child: SessionControlledChild, seen = new Set<string>()): ReactNode => {
    if (seen.has(child.id)) return null
    const next = new Set([...seen, child.id])
    const children = nodes.filter((row) => row.parentId === child.id)
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
          summary={t('composer.child.finishedGroup', { count: settledRoots.length })}
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
  control: (id: string, action: ComposerChildAction, text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const [text, setText] = useState('')
  const [replyOpen, setReplyOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mark = CHILD_MARK[child.status]
  const working = WORKING.has(child.status)
  const showReply = child.controls.continue && replyOpen
  const submit = (action: ComposerChildAction) => {
    if (pending) return
    setPending(true)
    setError('')
    void control(child.id, action, action === 'continue' ? text : undefined)
      .then(() => {
        if (action === 'continue') {
          setText('')
          setReplyOpen(false)
        }
      })
      .catch((error: unknown) =>
        setError(
          t('composer.child.controlFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      .finally(() => setPending(false))
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
          title={child.label ? `${child.label} (${child.id})` : child.id}
          onClick={(event) => openChildJob(event.currentTarget, child.id)}
        >
          <span className="composer-child-title">{childName(child, t)}</span>
        </Button>
        {child.label ? <span className="composer-child-id">{child.id.slice(-6)}</span> : null}
        <span role="status" className="composer-child-state" data-tone={mark.tag}>
          {t(`composer.child.${child.status}`)}
        </span>
        <p className="composer-child-metrics" data-testid="child-control-metrics">
          {t('composer.child.metrics', {
            tokens:
              child.totalTokens === null ? t('composer.child.unknown') : formatTokens(child.totalTokens),
            seconds:
              child.durationMs === null ? t('composer.child.unknown') : (child.durationMs / 1000).toFixed(1),
          })}
        </p>
        <div className="composer-child-actions">
          {child.controls.continue ? (
            <Button
              htmlType="button"
              size="small"
              appearance="ghost"
              className="composer-child-steer"
              data-testid="child-steer-toggle"
              aria-expanded={replyOpen}
              disabled={disabled || pending}
              onClick={() => setReplyOpen((open) => !open)}
            >
              {t(working ? 'composer.child.steer' : 'composer.child.continue')}
            </Button>
          ) : null}
          {(['stop', 'pause', 'resume', 'close', 'retain', 'recap'] as const).map((action) => {
            const available =
              action === 'recap'
                ? child.providerId === 'in-process'
                : action === 'resume'
                  ? child.status === 'paused' && child.controls.resume
                  : child.controls[action]
            if (!available) return null
            return (
              <Button
                key={action}
                htmlType="button"
                size="small"
                appearance="ghost"
                data-testid={`child-${action}`}
                disabled={disabled || pending}
                onClick={() => submit(action)}
              >
                {t(`composer.child.${action}`)}
              </Button>
            )
          })}
        </div>
      </div>
      {showReply ? (
        <div className="composer-child-reply">
          <SettingsInput
            data-testid="child-continue-message"
            aria-label={t('composer.child.message')}
            placeholder={t('composer.child.message')}
            value={text}
            disabled={disabled || pending}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.currentTarget.value)}
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
            disabled={disabled || pending || !text.trim()}
            title={
              text.trim()
                ? t(working ? 'composer.child.send' : 'composer.child.continue')
                : t('composer.child.messageRequired')
            }
            onClick={() => submit('continue')}
          >
            {t(working ? 'composer.child.send' : 'composer.child.continue')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <SettingsState tone="error" className="composer-child-error">
          {error}
        </SettingsState>
      ) : null}
    </>
  )
}
