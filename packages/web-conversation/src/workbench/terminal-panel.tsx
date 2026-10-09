import { SettingsToolbar } from '@agnes/web-ui'
import type { SessionJob, SessionJobsReadResult } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'
import {
  appServerErrorMessage,
  Button,
  Select,
  SettingsState,
  SettingsTextArea,
  terminalKey,
  terminalScreen,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { panelContext } from './context.js'

type Input = Parameters<Session['jobsControl']>[0]
type PendingInput = {
  sessionId: string
  jobId: string
  alive: boolean
  sending: boolean
  text: string
}
const storageKey = (id: string) => `agnes.workbench.terminals.${id}`
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
  const outputElement = useRef<HTMLTextAreaElement>(null)
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
  const [size, setSize] = useState({ columns: 100, rows: 30 })
  const [refresh, setRefresh] = useState(0)
  const [shell, setShell] = useState<'bash' | 'zsh' | 'pwsh'>('bash')
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
    setActive((value) => (value === id ? '' : value))
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
    if (queue.text.length + text.length > 65536) {
      setError(t('workbench.terminal.inputFull'))
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
  const output = job ? terminalScreen((job.stdout ?? '') + (job.stderr ?? ''), size.columns, size.rows) : ''
  useEffect(() => {
    const element = outputElement.current
    if (element) element.scrollTop = output ? element.scrollHeight : 0
  }, [output])
  const jobId = job?.id
  useEffect(() => {
    const element = outputElement.current
    if (!element || !session || !human || !running || !jobId || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined,
      alive = true
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element)
        if (!rect.width || !rect.height) return
        const dimensions = {
          columns: Math.max(
            1,
            Math.min(1000, Math.floor((rect.width - 24) / (parseFloat(style.fontSize) * 0.6))),
          ),
          rows: Math.max(1, Math.min(1000, Math.floor((rect.height - 16) / parseFloat(style.lineHeight)))),
        }
        setSize(dimensions)
        void session.jobsControl({ operation: 'resize', jobId, ...dimensions }).catch((cause) => {
          if (alive)
            setError(appServerErrorMessage(cause, document.documentElement.lang) ?? t('workbench.error'))
        })
      }, 200)
    })
    observer.observe(element)
    return () => {
      alive = false
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [session, jobId, human, running, t])
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
  return (
    <section
      className="workbench-terminal"
      data-testid="terminal-panel"
      aria-label={t('workbench.terminal.title')}
    >
      <SettingsToolbar className="workbench-panel-toolbar workbench-terminal-toolbar">
        <Select
          aria-label={t('workbench.terminal.shell')}
          value={shell}
          onChange={setShell}
          options={['bash', 'zsh', 'pwsh'].map((value) => ({ value, label: value }))}
        />
        <Button
          size="small"
          disabled={busy}
          data-testid="terminal-new"
          onClick={() => void control({ operation: 'open', shell, columns: 100, rows: 30 })}
        >
          {t('workbench.terminal.new')}
        </Button>
        <span>{t('workbench.terminal.detach')}</span>
      </SettingsToolbar>
      {error && <SettingsState tone="error">{error}</SettingsState>}
      <div role="tablist" aria-label={t('workbench.terminal.tabs')} className="workbench-terminal-tabs">
        {tabs.map((tab, index) => (
          <Button
            type="text"
            size="small"
            role="tab"
            key={tab.id}
            id={`terminal-tab-${tab.id}`}
            aria-controls="terminal-job-content"
            aria-selected={active === tab.id}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
              if (!step && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const next =
                tabs[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index + step + tabs.length) % tabs.length
                ]
              if (next) {
                setActive(next.id)
                document.getElementById(`terminal-tab-${next.id}`)?.focus()
              }
            }}
          >
            {tab.shell ?? tab.command} {index + 1} · {t(`workbench.terminal.owner.${tab.owner}`)}
          </Button>
        ))}
      </div>
      {job ? (
        <div
          role="tabpanel"
          id="terminal-job-content"
          aria-labelledby={`terminal-tab-${job.id}`}
          className="workbench-terminal-job"
        >
          <SettingsToolbar className="workbench-panel-toolbar">
            <span role="status">
              {t(`workbench.terminal.status.${job.status}`)}
              {job.code !== null && ` · ${t('workbench.terminal.exit', { code: job.code })}`}
            </span>
            {human && (
              <>
                <Button
                  size="small"
                  disabled={busy || !running}
                  data-testid="terminal-interrupt"
                  onClick={() => void control({ operation: 'signal', jobId: job.id, signal: 'SIGINT' })}
                >
                  {t('workbench.terminal.interrupt')}
                </Button>
                <Button
                  size="small"
                  disabled={busy || !running}
                  data-testid="terminal-kill"
                  onClick={() => void control({ operation: 'kill', jobId: job.id })}
                >
                  {t('workbench.terminal.kill')}
                </Button>
              </>
            )}
            <Button
              size="small"
              disabled={busy}
              data-testid="terminal-tab-close"
              onClick={() =>
                human && running ? void control({ operation: 'kill', jobId: job.id }, job.id) : detach(job.id)
              }
            >
              {t(human ? 'workbench.terminal.close' : 'workbench.terminal.unfollow')}
            </Button>
          </SettingsToolbar>
          <details className="workbench-terminal-details">
            <summary>{t('workbench.terminal.details')}</summary>
            <dl>
              <dt>{t('workbench.terminal.session')}</dt>
              <dd>{job.ownerSessionId}</dd>
              <dt>{t('workbench.terminal.id')}</dt>
              <dd>{job.id}</dd>
              <dt>{t('workbench.terminal.cwd')}</dt>
              <dd>{job.cwd}</dd>
            </dl>
          </details>
          {job.truncated && <p role="status">{t('workbench.terminal.truncated')}</p>}
          <SettingsTextArea
            presentation="plain"
            ref={outputElement}
            className="workbench-terminal-output"
            data-testid="workbench-terminal-output"
            aria-label={t('workbench.terminal.output')}
            readOnly
            disabled={inputBlocked}
            value={output}
            spellCheck={false}
            onKeyDown={(event) => {
              if (!human || !running || event.key === 'Escape') return
              const text = terminalKey(event)
              if (text === undefined) return
              event.preventDefault()
              sendInput(job.id, text)
            }}
            onPaste={(event) => {
              if (!human || !running) return
              event.preventDefault()
              sendInput(job.id, event.clipboardData.getData('text/plain').slice(0, 65536))
            }}
          />
        </div>
      ) : (
        <SettingsState tone="empty">{t('workbench.terminal.empty')}</SettingsState>
      )}
      <section className="workbench-terminal-available" aria-label={t('workbench.terminal.available')}>
        {snapshot.jobs
          .filter((row) => !ids.includes(row.id))
          .map((row) => (
            <Button key={row.id} type="text" size="small" onClick={() => attach(row.id)}>
              {t('workbench.terminal.follow')} · {row.shell ?? row.command} ·{' '}
              {t(`workbench.terminal.owner.${row.owner}`)} · {t(`workbench.terminal.status.${row.status}`)}
            </Button>
          ))}
      </section>
    </section>
  )
}
