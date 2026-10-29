/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { bindJobsSessions, type SessionJob, sessionJobsApi } from '../src/settings/jobs-api.js'
import { JobsPanel } from '../src/settings/jobs-panel.js'
import { terminalKey, terminalScreen } from '../src/settings/terminal-screen.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})

it('selects a valid session by title, reads output and confirms only human-owned stops', async () => {
  localStorage.setItem('agnes.jobs.session', 'deleted-session')
  const job: SessionJob = {
    id: 'human-job',
    owner: 'human',
    kind: 'shell',
    command: 'sleep 10',
    cwd: '/w',
    status: 'running',
    code: null,
    truncated: false,
    stdout: 'ready\n',
  }
  let refuseStop = true
  const api = {
    read: vi.fn(async (_scope: string, id?: string) => ({
      jobs: [job, { ...job, id: 'agent-job', owner: 'agent' as const }],
      completions: [],
      ...(id ? { job } : {}),
    })),
    control: vi.fn(async () => ({ ok: !refuseStop })),
  }
  const sessions = {
    current: () => 'session-a',
    list: async () => [
      { id: 'session-a', title: 'Release review', workspace: 'demo', createdAt: new Date().toISOString() },
    ],
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(JobsPanel, { api, sessions })))
    await act(async () => {})
    expect(api.read).toHaveBeenCalledWith('session-a', undefined)
    expect(localStorage.getItem('agnes.jobs.session')).toBeNull()
    expect(host.querySelector('[data-testid="jobs-session"]')?.textContent).toContain('Release review')
    expect(host.textContent).not.toContain('session-a')
    expect(host.querySelector<HTMLElement>('[data-testid="jobs-session-context"]')?.dataset.open).toBe(
      'false',
    )
    // The stamp rides in the title's line box, so both share one baseline instead of two aligned cells.
    expect(
      host
        .querySelector(
          '[data-testid="jobs-session-context"] .agh-disclosure-title .jobs-session-updated time',
        )
        ?.getAttribute('datetime'),
    ).toBeTruthy()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="session-job-human-job"] button')?.click(),
    )
    expect(host.querySelector('[data-testid="job-output"]')?.textContent).toContain('ready')
    const menuFor = (id: string) =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="session-job-' + id + '"] button[aria-haspopup="menu"]',
      )!
    await act(async () => menuFor('agent-job').click())
    const agentStop = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    expect(agentStop.getAttribute('aria-disabled')).toBe('true')
    await act(async () => agentStop.click())
    expect(api.control).not.toHaveBeenCalled()
    await act(async () => menuFor('agent-job').click())
    await act(async () => menuFor('human-job').click())
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')?.click(),
    )
    expect(api.control).not.toHaveBeenCalled()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="jobs-stop-cancel"]')?.click(),
    )
    expect(api.control).not.toHaveBeenCalled()
    await act(async () => menuFor('human-job').click())
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')?.click(),
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="jobs-stop-confirm"]')?.click(),
    )
    expect(api.control).toHaveBeenCalledWith('session-a', { operation: 'kill', jobId: 'human-job' })
    expect(document.querySelector('[data-testid="jobs-stop-confirm"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="jobs-error"]')).not.toBeNull()
    refuseStop = false
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="jobs-stop-confirm"]')?.click(),
    )
    expect(host.querySelector('[data-testid="jobs-error"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})
it('renders terminal control bytes safely and maps interactive keys', () => {
  expect(terminalScreen('hello\rX\x1b[K')).toBe('X')
  expect(terminalScreen('\x1b[31m<unsafe>\x1b[0m')).toBe('<unsafe>')
  expect(terminalKey({ key: 'ArrowUp', ctrlKey: false, altKey: false, metaKey: false })).toBe('\x1b[A')
  expect(terminalKey({ key: 'c', ctrlKey: true, altKey: false, metaKey: false })).toBe('\x03')
})

it('rests with no running jobs, backs off active reads and pauses while hidden', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  let hidden = false
  const visible = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  let running = false
  const job: SessionJob = {
    id: 'job',
    kind: 'shell',
    command: 'sleep 10',
    cwd: '/fixture',
    status: 'running',
    code: null,
    truncated: false,
  }
  const api = { read: vi.fn(async () => ({ jobs: running ? [job] : [], completions: [] })), control: vi.fn() }
  const sessions = {
    current: () => 'fixture',
    list: async () => [
      { id: 'fixture', title: 'Fixture', workspace: '/fixture', createdAt: new Date().toISOString() },
    ],
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(JobsPanel, { api, sessions })))
    expect(api.read).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(api.read).toHaveBeenCalledTimes(1)
    running = true
    await act(async () => window.dispatchEvent(new Event('agnes:jobs-changed')))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.read).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.read).toHaveBeenCalledTimes(3)
    hidden = true
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(api.read).toHaveBeenCalledTimes(3)
    running = false
    hidden = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.read).toHaveBeenCalledTimes(4)
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(api.read).toHaveBeenCalledTimes(4)
  } finally {
    await act(async () => root.unmount())
    visible.mockRestore()
    vi.useRealTimers()
  }
})

it('uses the session job binding RPC from the existing management UI API', async () => {
  const call = vi.fn(async (method: string) =>
    method.endsWith('.read') ? { jobs: [], completions: [] } : { output: { id: 'community-terminal' } },
  )
  const dispose = bindJobsSessions({ current: () => 'community-session', list: async () => [], call })
  try {
    const api = sessionJobsApi()
    await expect(api.read('community-session')).resolves.toEqual({ jobs: [], completions: [] })
    expect(call).toHaveBeenCalledWith('_agnes/v1/session.jobs.read', { sessionId: 'community-session' })
    await expect(api.control('community-session', { operation: 'open' })).resolves.toEqual({
      id: 'community-terminal',
    })
    expect(call).toHaveBeenCalledWith('_agnes/v1/session.jobs.control', {
      sessionId: 'community-session',
      operation: 'open',
      commandId: expect.any(String),
    })
  } finally {
    dispose()
  }
  await expect(sessionJobsApi().read('community-session')).rejects.toThrow('unavailable')
})

it.each(['saved', 'failed'] as const)(
  'ignores an old job stop %s even when the replacement API has the same session id',
  async (outcome) => {
    const job: SessionJob = {
      id: 'human-job',
      owner: 'human',
      kind: 'shell',
      command: 'sleep 10',
      cwd: '/w',
      status: 'running',
      code: null,
      truncated: false,
      stdout: 'new scope',
    }
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const pending = new Promise((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const first = {
      read: vi.fn(async () => ({ jobs: [{ ...job, stdout: 'old scope' }], completions: [] })),
      control: vi.fn(() => pending),
    }
    const next = {
      read: vi.fn(async () => ({ jobs: [job], completions: [] })),
      control: vi.fn(async () => ({})),
    }
    const sessions = {
      current: () => 'same-session',
      list: async () => [
        { id: 'same-session', title: 'Test', workspace: 'test', createdAt: '2026-10-20T00:00:00Z' },
      ],
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const draw = (api: typeof first | typeof next) =>
      act(async () => root.render(createElement(JobsPanel, { api, sessions })))
    try {
      await draw(first)
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[data-testid="session-job-human-job"] button[aria-haspopup="menu"]',
          )
          ?.click(),
      )
      await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')?.click())
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-testid="jobs-stop-confirm"]')?.click(),
      )
      expect(first.control).toHaveBeenCalled()
      await draw(next)
      const reads = first.read.mock.calls.length
      await act(async () => (outcome === 'saved' ? resolve({ ok: true }) : reject(new Error('old stop'))))
      expect(first.read.mock.calls.length).toBe(reads)
      expect(host.querySelector('[data-testid="jobs-error"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  },
)
