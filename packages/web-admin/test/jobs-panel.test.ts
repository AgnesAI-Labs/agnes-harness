/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionJob } from '../src/settings/jobs-api.js'
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
