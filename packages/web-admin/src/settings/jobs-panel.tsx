import {
  Button,
  Field,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { type JobsSnapshot, sessionJobsApi } from './jobs-api.js'
import { JOBS_NAMESPACE, jobsCatalog } from './jobs-locales.js'
import { terminalKey, terminalScreen } from './terminal-screen.js'

const defaultApi = sessionJobsApi()
const SESSION_STORAGE_KEY = 'agnes.jobs.session'
export function JobsPanel({
  terminal = false,
  api = defaultApi,
}: {
  terminal?: boolean
  api?: ReturnType<typeof sessionJobsApi>
}) {
  const { t } = useUiText(JOBS_NAMESPACE, jobsCatalog)
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(SESSION_STORAGE_KEY) ?? '')
  const [shell, setShell] = useState<'bash' | 'zsh' | 'pwsh'>('bash')
  const [snapshot, setSnapshot] = useState<JobsSnapshot>()
  const [jobId, setJobId] = useState<string>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const screen = useRef<HTMLTextAreaElement>(null)
  const owner = useRef(sessionId)
  owner.current = sessionId
  // A refresh detaches the view; only the explicit close action kills a terminal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests another backend read.
  useEffect(() => {
    if (!sessionId.trim()) {
      setSnapshot(undefined)
      return
    }
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const scope = sessionId
    async function refresh() {
      try {
        const value = await api.read(scope, jobId)
        if (!active) return
        setSnapshot(value)
        setError(false)
        if (terminal && !jobId) {
          const saved = localStorage.getItem('agnes.terminal.' + scope)
          const attach =
            value.jobs.find((job) => job.id === saved && job.kind === 'pty' && job.status === 'running') ??
            value.jobs.find((job) => job.kind === 'pty' && job.status === 'running')
          if (attach) setJobId(attach.id)
        }
      } catch {
        if (active) setError(true)
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [sessionId, jobId, terminal, revision, api])
  useEffect(() => {
    if (snapshot?.job && screen.current) screen.current.scrollTop = screen.current.scrollHeight
  }, [snapshot])
  async function control(input: Record<string, unknown>) {
    if (busy || !sessionId.trim()) return
    const scope = sessionId
    setBusy(true)
    setError(false)
    try {
      const result = await api.control(scope, input)
      if (owner.current !== scope) return
      if (
        input.operation === 'open' &&
        result &&
        typeof result === 'object' &&
        'id' in result &&
        typeof result.id === 'string'
      ) {
        setJobId(result.id)
        localStorage.setItem('agnes.terminal.' + scope, result.id)
      }
      if (input.operation === 'kill' && input.jobId === jobId) {
        setJobId(undefined)
        localStorage.removeItem('agnes.terminal.' + scope)
      }
      setRevision((value) => value + 1)
    } catch {
      if (owner.current === scope) setError(true)
    } finally {
      setBusy(false)
    }
  }
  // Preserve PTY byte order and the captured owner; batch typing queued behind a slow write.
  const inputQueue = useRef({
    running: false,
    pending: [] as { scope: string; id: string; text: string }[],
  })
  function send(text: string) {
    if (!jobId) return
    const queue = inputQueue.current
    const scope = sessionId,
      id = jobId
    const tail = queue.pending.at(-1)
    if (tail?.scope === scope && tail.id === id && tail.text.length + text.length <= 16_384) tail.text += text
    else queue.pending.push({ scope, id, text })
    if (queue.running) return
    queue.running = true
    void (async () => {
      try {
        for (let input = queue.pending.shift(); input; input = queue.pending.shift()) {
          try {
            await api.control(input.scope, { operation: 'send', jobId: input.id, text: input.text })
          } catch {
            if (owner.current === input.scope) setError(true)
          }
        }
      } finally {
        queue.running = false
      }
    })()
  }
  return (
    <SettingsCard className="runtime-card" data-testid={terminal ? 'terminal-panel' : 'jobs-panel'}>
      <p>{t(terminal ? 'terminalHelp' : 'jobsHelp')}</p>
      <Field label={t('session')} htmlFor="jobs-session">
        <SettingsInput
          id="jobs-session"
          data-testid="jobs-session"
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value)
            setJobId(undefined)
            setSnapshot(undefined)
            localStorage.setItem(SESSION_STORAGE_KEY, event.target.value)
          }}
        />
      </Field>
      {error && (
        <SettingsState tone="error" data-testid="jobs-error">
          {t('unavailable')}
        </SettingsState>
      )}
      <Button
        disabled={busy || !sessionId.trim()}
        data-testid="jobs-refresh"
        onClick={() => setRevision((value) => value + 1)}
      >
        {t('refresh')}
      </Button>
      {terminal && (
        <>
          <Field label={t('shell')} htmlFor="terminal-shell">
            <SettingsSelect
              id="terminal-shell"
              data-testid="terminal-shell"
              value={shell}
              disabled={busy || !!jobId}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'bash' || value === 'zsh' || value === 'pwsh') setShell(value)
              }}
            >
              <option value="bash">{t('shell.bash')}</option>
              <option value="zsh">{t('shell.zsh')}</option>
              <option value="pwsh">{t('shell.pwsh')}</option>
            </SettingsSelect>
          </Field>
          <SettingsToolbar>
            <Button
              data-testid="terminal-open"
              disabled={busy || !!jobId || !sessionId.trim()}
              onClick={() => void control({ operation: 'open', shell })}
            >
              {t('open')}
            </Button>
            <Button
              data-testid="terminal-interrupt"
              disabled={busy || !jobId}
              onClick={() => void control({ operation: 'signal', jobId, signal: 'SIGINT' })}
            >
              {t('interrupt')}
            </Button>
            <Button
              data-testid="terminal-close"
              disabled={busy || !jobId}
              onClick={() => void control({ operation: 'kill', jobId })}
            >
              {t('close')}
            </Button>
          </SettingsToolbar>
          <SettingsTextArea
            readOnly
            rows={30}
            value={terminalScreen((snapshot?.job?.stdout ?? '') + (snapshot?.job?.stderr ?? ''))}
            className="session-terminal"
            ref={screen}
            data-testid="terminal-output"
            aria-live="off"
            aria-label={t('output')}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey) return
              const text = terminalKey(event)
              if (jobId && text !== undefined) {
                event.preventDefault()
                send(text)
              }
            }}
            onPaste={(event) => {
              if (jobId) {
                event.preventDefault()
                send(event.clipboardData.getData('text/plain'))
              }
            }}
          />
          <p>{t('keyboard')}</p>
        </>
      )}
      {!sessionId.trim() && <SettingsState>{t('chooseSession')}</SettingsState>}
      {sessionId.trim() && snapshot && !snapshot.jobs.length && <SettingsState>{t('empty')}</SettingsState>}
      <div className="agnes-settings-table">
        <table data-testid="session-jobs-table">
          <caption>{t('jobs')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('kind')}</th>
              <th scope="col">{t('command')}</th>
              <th scope="col">{t('status')}</th>
              <th scope="col">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {snapshot?.jobs.map((job) => (
              <tr key={job.id} data-testid={'session-job-' + job.id}>
                <td>{t(`jobKind.${job.kind}`)}</td>
                <td>
                  <code>{job.command}</code>
                </td>
                <td>{t(job.status)}</td>
                <td>
                  <Button
                    disabled={busy || (terminal && job.kind !== 'pty')}
                    onClick={() => setJobId(job.id)}
                  >
                    {t('output')}
                  </Button>{' '}
                  <Button
                    disabled={busy || job.status !== 'running' || job.owner !== 'human'}
                    title={job.owner !== 'human' ? t('agentOwnedControl') : undefined}
                    onClick={() => void control({ operation: 'kill', jobId: job.id })}
                  >
                    {t('kill')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!terminal && snapshot?.job && (
        <pre data-testid="job-output">
          {snapshot.job.stdout}
          {snapshot.job.stderr}
        </pre>
      )}
      <div role="status" aria-live="polite" data-testid="job-completions">
        {snapshot?.completions.slice(-5).map((job) => (
          <p key={job.id}>
            {t('completedNotice')}: <code>{job.id}</code> · {t(job.status)}
          </p>
        ))}
      </div>
    </SettingsCard>
  )
}
