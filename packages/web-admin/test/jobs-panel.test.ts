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

it('reconnects a user PTY after refresh; typing and explicit close control that owned job', async () => {
  localStorage.setItem('agnes.jobs.session', 'session-a')
  localStorage.setItem('agnes.terminal.session-a', 'pty-a')
  const job: SessionJob = {
    id: 'pty-a',
    kind: 'pty',
    command: 'bash',
    cwd: '/w',
    status: 'running',
    code: null,
    truncated: false,
    stdout: 'ready\r\n',
  }
  let acknowledge: (() => void) | undefined
  const api = {
    read: vi.fn(async (_scope: string, id?: string) => ({
      jobs: [job],
      completions: [],
      ...(id ? { job } : {}),
    })),
    control: vi.fn(async (_scope: string, input: Record<string, unknown>) => {
      if (input.operation === 'send' && input.text === 'x')
        await new Promise<void>((resolve) => {
          acknowledge = resolve
        })
      return { ok: true }
    }),
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(JobsPanel, { terminal: true, api })))
    await act(async () => {})
    expect(api.read).toHaveBeenCalledWith('session-a', 'pty-a')
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="terminal-output"]')?.value).toContain(
      'ready',
    )
    await act(async () => {
      container
        .querySelector('[data-testid="terminal-output"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    })
    expect(api.control).toHaveBeenCalledWith('session-a', { operation: 'send', jobId: 'pty-a', text: 'x' })
    await act(async () => {
      for (const key of ['y', 'z', 'Enter'])
        container
          .querySelector('[data-testid="terminal-output"]')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    await act(async () => acknowledge?.())
    // PTY writes preserve every byte, but queued typing is sent together after a slow acknowledgement.
    expect(api.control).toHaveBeenCalledWith('session-a', { operation: 'send', jobId: 'pty-a', text: 'yz\r' })
    expect(
      api.control.mock.calls
        .filter(([, input]) => input.operation === 'send')
        .map(([, input]) => input.text)
        .join(''),
    ).toBe('xyz\r')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="terminal-close"]')?.click(),
    )
    expect(api.control).toHaveBeenCalledWith('session-a', { operation: 'kill', jobId: 'pty-a' })
    expect(localStorage.getItem('agnes.terminal.session-a')).toBeNull()
    await act(async () => root.unmount())
    expect(api.control.mock.calls.filter(([, input]) => input.operation === 'kill')).toHaveLength(1)
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
