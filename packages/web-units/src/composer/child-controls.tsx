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
import type { ComposerDependencies } from './contracts.js'

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
const TERMINAL = new Set<ChildStatus>(['completed', 'failed', 'cancelled'])

/**
 * A child prefers its human-readable task label when present; otherwise falls back to its
 * provider/subagent label with the trailing id segment so two children stay distinguishable.
 */
function childName(child: SessionControlledChild, t: ComposerDependencies['translate']): string {
  const label = child.label?.trim()
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
 * nested under its parent. Active children stay pinned on top; finished/cancelled history folds
 * underneath when active work is present so cancelled retries never crowd out live tasks.
 */
export function ChildControlTree({
  nodes,
  disabled = false,
  control,
  t,
}: {
  nodes: readonly SessionControlledChild[]
  disabled?: boolean
  control: (id: string, action: 'stop' | 'continue', text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const ids = new Set(nodes.map((child) => child.id))
  const working = nodes.filter((child) => WORKING.has(child.status)).length
  const finished = nodes.filter((child) => TERMINAL.has(child.status)).length
  const roots = nodes.filter((child) => !ids.has(child.parentId))
  const activeRoots = roots.filter((child) => !TERMINAL.has(child.status))
  const terminalRoots = roots.filter((child) => TERMINAL.has(child.status))
  const foldHistory = activeRoots.length > 0 && terminalRoots.length > 0
  const meta =
    working && finished
      ? t('composer.child.summaryMixed', { working, done: finished })
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
        {(foldHistory ? activeRoots : [...activeRoots, ...terminalRoots]).map((child) => renderChild(child))}
      </ul>
      {foldHistory ? (
        <Disclosure
          variant="plain"
          className="composer-children-history"
          data-testid="child-control-history"
          summary={t('composer.child.finishedGroup', { count: terminalRoots.length })}
        >
          <ul className="composer-children-list">{terminalRoots.map((child) => renderChild(child))}</ul>
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
  control: (id: string, action: 'stop' | 'continue', text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const [text, setText] = useState('')
  const [replyOpen, setReplyOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mark = CHILD_MARK[child.status]
  const working = WORKING.has(child.status)
  const showReply = child.controls.continue && (!working || replyOpen)
  const submit = (action: 'stop' | 'continue') => {
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
          {childName(child, t)}
        </Button>
        {child.label ? <span className="composer-child-id">{child.id.slice(-6)}</span> : null}
        <span role="status" className="composer-child-state" data-tone={mark.tag}>
          {t('composer.child.' + child.status)}
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
          {child.controls.continue && working ? (
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
              {t('composer.child.steer')}
            </Button>
          ) : null}
          {child.controls.stop ? (
            <Button
              htmlType="button"
              size="small"
              appearance="ghost"
              className="composer-child-stop"
              data-testid="child-stop"
              disabled={disabled || pending}
              title={t('composer.child.stop')}
              onClick={() => submit('stop')}
            >
              {t('composer.child.stop')}
            </Button>
          ) : null}
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
