import type { SessionJob, SessionJobsReadResult } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'
import { appServerErrorMessage, Button, ConfirmDialog, IconButton, Menu, SettingsState } from '@agnes/web-ui'
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
import { visiblePoll } from './visible-poll.js'

const closedSessions = new Set<string>()
function wasClosed(id: string) {
  try {
    return localStorage.getItem(`${storageKey(id)}.closed`) === 'true'
  } catch {
    return closedSessions.has(id)
  }
}
function markClosed(id: string) {
  closedSessions.add(id)
  try {
    localStorage.setItem(`${storageKey(id)}.closed`, 'true')
  } catch {
    /* memory fallback */
  }
}

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
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
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
  const [terminate, setTerminate] = useState<{ job: SessionJob; detach: boolean }>()
  const removed = useRef(new Set<string>())
  const [notice, setNotice] = useState('')
  const [dismissed, setDismissed] = useState('')
  const scope = useRef(session?.id),
    restored = useRef(false)
  scope.current = session?.id
  useEffect(() => {
    restored.current = false
    try {
      removed.current = new Set(
        JSON.parse(localStorage.getItem(`${storageKey(sessionId ?? '')}.removed`) ?? '[]'),
      )
    } catch {
      removed.current = new Set()
    }
    setTerminate(undefined)
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
    let alive = true
    const poll = async () => {
      try {
        let value: SessionJobsReadResult
        try {
          // An output response already contains the job list; steady-state polling needs one read.
          value = await session.jobsRead(restored.current && active ? active : undefined)
        } catch (cause) {
          if (!alive || document.visibilityState === 'hidden') return
          if (!active || !restored.current) throw cause
          value = await session.jobsRead()
          if (value.jobs.some((job) => job.id === active)) throw cause
          const cached = snapshotRef.current.jobs.find(
            (row) => row.id === active && row.owner === 'agent' && row.status !== 'running',
          )
          if (cached) value = { ...value, job: cached }
          else if (alive) setActive('') // Only a human terminal without cached output is detached on eviction.
        }
        if (!alive) return
        setSnapshot((previous) => ({
          ...value,
          jobs: [
            ...value.jobs.map((row) => ({
              ...previous.jobs.find((known) => known.id === row.id),
              ...(previous.job?.id === row.id ? previous.job : {}),
              ...row,
              ...(value.job?.id === row.id ? value.job : {}),
            })),
            ...previous.jobs.filter(
              (row) => row.owner === 'agent' && !value.jobs.some((next) => next.id === row.id),
            ),
          ],
        }))
        terminalCount.set(session.id, value.jobs.length)
        setError('')
        if (!restored.current) {
          restored.current = true
          const stored = attachments(session.id)
          const initial = value.jobs
            .filter(
              (job) =>
                !removed.current.has(job.id) &&
                (job.owner === 'agent' ||
                  job.status === 'running' ||
                  !wasClosed(session.id) ||
                  stored?.includes(job.id)),
            )
            .map((job) => job.id)
          setIds(initial)
          setActive(
            initial.find((id) => value.jobs.some((job) => job.id === id && job.owner === 'human')) ??
              initial[0] ??
              '',
          )
          // No terminal is started for the person until they ask for one: opening the dock to watch
          // the agent's jobs must not leave a shell running that nobody uses.
        } else {
          setIds((known) => [
            ...known,
            ...value.jobs
              .filter((row) => !known.includes(row.id) && !removed.current.has(row.id))
              .map((row) => row.id),
          ])
        }
      } catch (cause) {
        if (alive)
          setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
      }
    }
    const stop = visiblePoll(poll, 1000)
    // Closing the dock, switching sessions and disposing registration only detach the UI.
    return () => {
      alive = false
      stop()
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
    if (sessionId && snapshot.jobs.some((row) => row.id === id && row.owner === 'human'))
      markClosed(sessionId)
    removed.current.add(id)
    if (sessionId)
      try {
        localStorage.setItem(`${storageKey(sessionId)}.removed`, JSON.stringify([...removed.current]))
      } catch {
        /* memory only */
      }
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
  const tabs = ids
    .flatMap((id) => snapshot.jobs.filter((job) => job.id === id))
    .sort((a, b) => Number(a.owner === 'agent') - Number(b.owner === 'agent'))
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

  const name = (row: SessionJob) =>
    names[row.id] ?? (row.owner === 'human' ? (row.shell ?? row.command) : row.command)
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
  ]
  const warning = notice || (job?.truncated ? t('workbench.terminal.truncated') : '')
  return (
    <section
      className="workbench-terminal"
      data-testid="terminal-panel"
      aria-label={t('workbench.terminal.title')}
    >
      {error && <SettingsState tone="error">{error}</SettingsState>}
      <div className="workbench-terminal-body">
        <div className="workbench-terminal-bar">
          <div className="workbench-terminal-group">
            {t('workbench.terminal.title')}
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
                ? setTerminate({ job: tab, detach: true })
                : detach(tab.id)
            }
            interrupt={(tab) => void control({ operation: 'signal', jobId: tab.id, signal: 'SIGINT' })}
            kill={(tab) => setTerminate({ job: tab, detach: false })}
          />
        </div>
        {job ? (
          <section
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
            {!human && (
              <div className="workbench-terminal-readonly">
                {t('workbench.terminal.readonly')}
                <Button type="text" size="small" onClick={() => detach(job.id)}>
                  {t('workbench.terminal.remove')}
                </Button>
              </div>
            )}
          </section>
        ) : (
          <div className="workbench-terminal-empty" data-testid="terminal-empty">
            <Button type="text" disabled={busy} onClick={() => create(shell)}>
              + {t('workbench.terminal.new')}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!terminate}
        title={t('workbench.terminal.kill')}
        confirmLabel={t('workbench.terminal.kill')}
        destructive
        busy={busy}
        onCancel={() => setTerminate(undefined)}
        onConfirm={() => {
          if (!terminate) return
          const target = terminate
          markClosed(session.id)
          void control(
            { operation: 'kill', jobId: target.job.id },
            target.detach ? target.job.id : undefined,
          ).then((ok) => {
            if (ok) setTerminate((current) => (current === target ? undefined : current))
          })
        }}
      >
        {terminate ? name(terminate.job) : ''}
      </ConfirmDialog>
    </section>
  )
}
