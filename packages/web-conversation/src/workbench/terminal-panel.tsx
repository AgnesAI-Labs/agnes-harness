import type { SessionJob, SessionJobsReadResult } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'
import { appServerErrorMessage, Button, IconButton, Menu, SettingsState, StatusDot } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { panelContext } from './context.js'
import { terminalCount } from './tab-counts.js'
import {
  readTerminalShell,
  rememberTerminalNames,
  rememberTerminalShell,
  terminalStorageKey as storageKey,
  type TerminalShell,
  terminalNames,
  terminalShells,
} from './terminal-preferences.js'
import { TerminalTabs } from './terminal-tabs.js'
import { TerminalView } from './terminal-view.js'

type Input = Parameters<Session['jobsControl']>[0]
type PendingInput = {
  sessionId: string
  jobId: string
  alive: boolean
  sending: boolean
  text: string
}
function attachments(id: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 128)
      : undefined
  } catch {
    return undefined
  }
}
/** A panel owns only subscriptions and attached tabs. The session owns every process. */
export function TerminalPanel({ context }: { context: UiExtensionContext }) {
  const { session } = panelContext(context),
    { t } = context
  const sessionId = session?.id
  const [snapshot, setSnapshot] = useState<SessionJobsReadResult>({ jobs: [], completions: [] })
  const [ids, setIds] = useState<string[]>([]),
    [active, setActive] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [inputBlocked, setInputBlocked] = useState(false)
  const pendingInput = useRef<PendingInput | undefined>(undefined)
  useEffect(() => {
    const queue: PendingInput = {
      sessionId: sessionId ?? '',
      jobId: active,
      alive: true,
      sending: false,
      text: '',
    }
    pendingInput.current = queue
    return () => {
      queue.alive = false
      queue.text = '' // Detach discards unsent UI input; an accepted send and the process remain owned by the session.
    }
  }, [sessionId, active])
  const [refresh, setRefresh] = useState(0)
  const [shell, setShell] = useState(readTerminalShell)
  const [names, setNames] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [dismissed, setDismissed] = useState('')
  const scope = useRef(session?.id),
    restored = useRef(false)
  scope.current = session?.id
  useEffect(() => {
    restored.current = false
    const stored = sessionId ? attachments(sessionId) : []
    setBusy(false)
    setInputBlocked(false)
    setIds(stored ?? [])
    setActive(stored?.[0] ?? '')
    setSnapshot({ jobs: [], completions: [] })
    setError('')
    setNames(sessionId ? terminalNames(sessionId) : {})
  }, [sessionId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed control receipt restarts polling immediately.
  useEffect(() => {
    if (!session) return
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        let value: SessionJobsReadResult
        try {
          // An output response already contains the job list; steady-state polling needs one read.
          value = await session.jobsRead(restored.current && active ? active : undefined)
        } catch (cause) {
          if (!active || !restored.current) throw cause
          value = await session.jobsRead()
          if (value.jobs.some((job) => job.id === active)) throw cause
          if (alive) setActive('') // A completed job may have been evicted by the bounded registry.
        }
        if (!alive) return
        setSnapshot(value)
        terminalCount.set(session.id, value.jobs.length)
        setError('')
        if (!restored.current) {
          restored.current = true
          const initial =
            attachments(session.id) ?? value.jobs.filter((job) => job.owner === 'human').map((job) => job.id)
          setIds(initial.filter((id) => value.jobs.some((job) => job.id === id)))
          setActive(initial.find((id) => value.jobs.some((job) => job.id === id)) ?? '')
        }
      } catch (cause) {
        if (alive)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      } finally {
        if (alive) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    // Closing the dock, switching sessions and disposing registration only detach the UI.
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [session, active, refresh, t])
  useEffect(() => {
    if (sessionId && restored.current)
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(ids))
      } catch {
        /* tabs remain attached in memory */
      }
  }, [sessionId, ids])
  const attach = (id: string) => {
    setIds((values) => (values.includes(id) ? values : [...values, id]))
    setActive(id)
  }
  const detach = (id: string) => {
    setIds((values) => values.filter((value) => value !== id))
    setActive((value) =>
      value === id
        ? (ids.find((next) => next !== id && snapshot.jobs.some((job) => job.id === next)) ?? '')
        : value,
    )
  }
  const control = async (input: Input, closeId?: string) => {
    if (!session) return false
    const id = session.id
    setBusy(true)
    if (input.operation !== 'send') setInputBlocked(true)
    try {
      const result = await session.jobsControl(input)
      if (scope.current !== id) return false
      setError('')
      if ('id' in result.output) {
        const receipt = result.output
        // Render backend-confirmed lifecycle facts immediately; no extra poll is needed to show kill.
        setSnapshot((value) => ({
          ...value,
          jobs: value.jobs.some((row) => row.id === receipt.id)
            ? value.jobs.map((row) => (row.id === receipt.id ? receipt : row))
            : [...value.jobs, receipt],
          job: { ...(value.job?.id === receipt.id ? value.job : {}), ...receipt },
        }))
        if (input.operation === 'open') attach(receipt.id)
      }
      if (closeId) detach(closeId)
      setRefresh((value) => value + 1)
      return true
    } catch (cause) {
      if (scope.current === id)
        setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      return false
    } finally {
      if (scope.current === id) {
        setBusy(false)
        if (input.operation !== 'send') setInputBlocked(false)
      }
    }
  }
  const sendInput = (jobId: string, text: string) => {
    const queue = pendingInput.current
    if (!queue?.alive || queue.sessionId !== sessionId || queue.jobId !== jobId) return
    if (new TextEncoder().encode(queue.text + text).length > 65536) {
      setDismissed('')
      setNotice(t('workbench.terminal.inputFull'))
      return
    }
    queue.text += text
    if (queue.sending) return
    queue.sending = true
    void (async () => {
      while (queue.alive && queue.text) {
        const batch = queue.text
        queue.text = ''
        // One in-flight input request preserves keystroke order and avoids RPC overload.
        if (!(await control({ operation: 'send', jobId, text: batch }))) {
          queue.text = '' // Never retry uncertain input or continue a partially refused command.
          break
        }
      }
      queue.sending = false
    })()
  }
  const tabs = ids.flatMap((id) => snapshot.jobs.filter((job) => job.id === id))
  const job: SessionJob | undefined =
    snapshot.job?.id === active ? snapshot.job : snapshot.jobs.find((row) => row.id === active)
  const human = job?.owner === 'human',
    running = job?.status === 'running'
  // biome-ignore lint/correctness/useExhaustiveDependencies: notices belong to the active session attachment.
  useEffect(() => {
    setNotice('')
    setDismissed('')
  }, [active, sessionId])
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
  const available = snapshot.jobs.filter((row) => !ids.includes(row.id))
  const availableTitle = t(
    available.some((row) => row.owner === 'human')
      ? 'workbench.terminal.availableAll'
      : 'workbench.terminal.available',
  )
  const name = (row: SessionJob) => names[row.id] ?? row.shell ?? row.command
  const create = (choice: TerminalShell) => {
    setShell(choice)
    rememberTerminalShell(choice)
    void control({ operation: 'open', shell: choice, columns: 100, rows: 30 })
  }
  const menuItems = [
    ...terminalShells.map((choice) => ({
      id: choice,
      label: `${t('workbench.terminal.new')} · ${choice}${choice === shell ? ` · ${t('workbench.terminal.lastUsed')}` : ''}`,
      disabled: busy,
      onSelect: () => create(choice),
    })),
    ...available.map((row, index) => ({
      id: row.id,
      dividerBefore: index === 0,
      label: `${t(row.owner === 'agent' ? 'workbench.terminal.connectJob' : 'workbench.terminal.follow')} · ${name(row)} · ${t(`workbench.terminal.status.${row.status}`)}`,
      onSelect: () => attach(row.id),
    })),
  ]
  const warning = notice || (job?.truncated ? t('workbench.terminal.truncated') : '')
  return (
    <section
      className="workbench-terminal"
      data-testid="terminal-panel"
      aria-label={t('workbench.terminal.title')}
    >
      {error && <SettingsState tone="error">{error}</SettingsState>}
      {tabs.length > 0 && (
        <div className="workbench-terminal-bar">
          <TerminalTabs
            tabs={tabs}
            active={active}
            busy={busy}
            t={t}
            name={name}
            select={setActive}
            rename={(id, value) => {
              const next = { ...names, [id]: value }
              setNames(next)
              rememberTerminalNames(session.id, next)
            }}
            close={(tab) =>
              tab.owner === 'human' && tab.status === 'running'
                ? void control({ operation: 'kill', jobId: tab.id }, tab.id)
                : detach(tab.id)
            }
            interrupt={(tab) => void control({ operation: 'signal', jobId: tab.id, signal: 'SIGINT' })}
            kill={(tab) => void control({ operation: 'kill', jobId: tab.id })}
          />
          <Menu
            label={t('workbench.terminal.newMenu')}
            triggerMode="contextMenu"
            items={menuItems}
            trigger={
              <IconButton
                name="plus"
                data-testid="terminal-new"
                label={`${t('workbench.terminal.new')} (${shell})`}
                disabled={busy}
                onClick={() => create(shell)}
              />
            }
          />
        </div>
      )}
      {job ? (
        <div
          role="tabpanel"
          id="terminal-job-content"
          aria-labelledby={`terminal-tab-${job.id}`}
          className="workbench-terminal-job"
        >
          {warning && dismissed !== warning && (
            <div className="workbench-terminal-note" role="status">
              {warning}
              <IconButton
                name="x"
                label={t('workbench.terminal.dismiss')}
                onClick={() => {
                  setDismissed(warning)
                  setNotice('')
                }}
              />
            </div>
          )}
          <TerminalView
            loading={t('workbench.terminal.loading')}
            failure={t('workbench.terminal.loadFailed')}
            key={`${session.id}:${job.id}`}
            stdout={job.stdout ?? ''}
            stderr={job.stderr ?? ''}
            label={t('workbench.terminal.output')}
            writable={human && running && !inputBlocked}
            exitLine={
              !running && job.code !== null ? t('workbench.terminal.exited', { code: job.code }) : undefined
            }
            exitTone={job.code === 0 ? 'neutral' : 'danger'}
            onData={(text) => sendInput(job.id, text)}
            onResize={(columns, rows) => {
              const id = session.id
              void session
                .jobsControl({ operation: 'resize', jobId: job.id, columns, rows })
                .catch((cause) => {
                  if (scope.current === id)
                    setError(
                      appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'),
                    )
                })
            }}
          />
          {!human && <div className="workbench-terminal-readonly">{t('workbench.terminal.readonly')}</div>}
        </div>
      ) : (
        <div className="workbench-terminal-empty" data-testid="terminal-empty">
          <div className="workbench-terminal-empty-group">
            <div className="workbench-terminal-guide">
              <Button type="text" data-testid="terminal-new" disabled={busy} onClick={() => create(shell)}>
                <span className="workbench-terminal-guide-icon" aria-hidden="true">
                  ›_
                </span>
                <span>
                  <strong>{t('workbench.terminal.new')}</strong>
                  <small>
                    {t('workbench.terminal.description')} · {shell}
                  </small>
                </span>
              </Button>
              <Menu
                label={t('workbench.terminal.newMenu')}
                items={menuItems}
                trigger={<IconButton name="chevron-down" label={t('workbench.terminal.shell')} />}
              />
            </div>
            {available.length > 0 && (
              <section className="workbench-terminal-available" aria-label={availableTitle}>
                <h4>{availableTitle}</h4>
                <ul>
                  {available.map((row) => (
                    <li key={row.id}>
                      <StatusDot
                        tone={row.status === 'running' ? 'success' : row.code === 0 ? 'neutral' : 'danger'}
                        running={row.status === 'running'}
                      />
                      <span className="workbench-terminal-name">{name(row)}</span>
                      <span className="workbench-terminal-row-status">
                        {t(`workbench.terminal.status.${row.status}`)}
                      </span>
                      <Button
                        size="small"
                        type="text"
                        data-testid="terminal-attach"
                        onClick={() => attach(row.id)}
                      >
                        {t('workbench.terminal.follow')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <footer className="workbench-terminal-footer">{t('workbench.terminal.detach')}</footer>
          </div>
        </div>
      )}
    </section>
  )
}
