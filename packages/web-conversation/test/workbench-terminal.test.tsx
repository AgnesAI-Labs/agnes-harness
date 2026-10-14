/** @vitest-environment happy-dom */
import type { Session } from '@agnes/sdk/browser'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'
import { sessionCount } from '../src/workbench/tab-counts.js'
import { TerminalPanel } from '../src/workbench/terminal-panel.js'

const job = (patch: Record<string, unknown>) => ({
  id: 'job',
  owner: 'agent',
  ownerSessionId: 's',
  kind: 'pty',
  command: 'npx serve .',
  cwd: '/work/site',
  status: 'running',
  code: null,
  truncated: false,
  stdout: '',
  stderr: '',
  ...patch,
})

function mount(session: Session) {
  const host = document.createElement('div')
  document.body.append(host)
  renderRegion(
    host,
    <TerminalPanel
      context={{
        t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
        data: { session, disabled: false },
      }}
    />,
  )
  return host
}

it('lists connectable session jobs in the empty state with 连接 and 新建终端, and a one-line footer', async () => {
  localStorage.clear()
  const agent = job({ id: 'agent' })
  const jobsControl = vi.fn()
  const session = {
    id: 's',
    jobsRead: async (id?: string) => ({ jobs: [agent], completions: [], ...(id ? { job: agent } : {}) }),
    jobsControl,
  } as unknown as Session
  const host = mount(session)
  try {
    await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-empty] li')).not.toBeNull())
    const row = host.querySelector('[data-testid=terminal-empty] li') as HTMLElement
    expect(host.querySelector('.workbench-terminal-empty-title')?.textContent).toBe('还没有打开的终端')
    expect(row.querySelector('.workbench-terminal-name')?.textContent).toBe('npx serve .')
    expect(row.querySelector('.workbench-terminal-owner')?.textContent).toBe('Agent')
    expect(row.textContent).toContain('运行中')
    expect(host.querySelector('[data-testid=terminal-new]')?.textContent).toBe('新建终端')
    expect(host.querySelector('.workbench-tab-footer')?.textContent).toBe('关闭工作台后，进程仍会运行')
    flushSync(() => (row.querySelector('[data-testid=terminal-attach]') as HTMLButtonElement).click())
    await vi.waitFor(() => expect(host.querySelector('[role=tab]')).not.toBeNull())
    // An agent process is followed, never controlled: no interrupt or kill, but its details stay readable.
    expect(host.querySelector('[data-testid=terminal-interrupt]')).toBeNull()
    expect(host.querySelector('[data-testid=terminal-kill]')).toBeNull()
    expect(host.querySelector('.workbench-terminal-status [role=status]')?.textContent).toBe('运行中')
    expect(host.querySelector('.workbench-terminal-cwd')?.textContent).toBe('/work/site')
    expect(host.querySelector('[data-testid=terminal-tab-close]')?.getAttribute('aria-label')).toBe(
      '取消跟随',
    )
    expect(jobsControl).not.toHaveBeenCalled()
  } finally {
    unmountRegion(host)
    host.remove()
    localStorage.clear()
  }
})

it('shows each tab with a status dot and owner, the exit code when finished, and details in a popover', async () => {
  localStorage.clear()
  const mine = job({ id: 'mine', owner: 'human', shell: 'zsh', command: 'zsh', status: 'failed', code: 1 })
  const server = job({ id: 'server', truncated: true, stdout: 'Serving!' })
  const session = {
    id: 's',
    jobsRead: async (id?: string) => ({
      jobs: [mine, server],
      completions: [],
      ...(id ? { job: id === 'server' ? server : mine } : {}),
    }),
    jobsControl: vi.fn(),
  } as unknown as Session
  localStorage.setItem('agnes.workbench.terminals.s', JSON.stringify(['mine', 'server']))
  const host = mount(session)
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('[role=tab]')).toHaveLength(2))
    const [first, second] = [...host.querySelectorAll<HTMLElement>('[role=tab]')]
    expect(first?.textContent).toBe('zsh我')
    expect(first?.querySelector('.agh-status-dot')?.getAttribute('data-tone')).toBe('danger')
    expect(second?.querySelector('.agh-status-dot')?.getAttribute('data-tone')).toBe('success')
    expect(host.querySelector('.workbench-terminal-status')?.getAttribute('data-tone')).toBe('danger')
    expect(host.querySelector('.workbench-terminal-status [role=status]')?.textContent).toBe(
      '失败 · 退出码 1',
    )
    // A finished process of mine cannot be interrupted or killed again.
    expect((host.querySelector('[data-testid=terminal-kill]') as HTMLButtonElement).disabled).toBe(true)
    // Closing the tab of a finished process only detaches it.
    expect(host.querySelector('[data-testid=terminal-tab-close]')?.getAttribute('aria-label')).toBe(
      '关闭页签并结束进程',
    )
    flushSync(() => second?.click())
    await vi.waitFor(() => expect(host.querySelector('textarea')?.value).toContain('Serving!'))
    expect(host.querySelector('.workbench-terminal-note')?.textContent).toBe(
      '输出已达到上限，较早或溢出部分不可用。',
    )
    flushSync(() => (host.querySelector('[data-testid=terminal-details]') as HTMLButtonElement).click())
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid=terminal-details-content]')?.textContent).toContain(
        'server',
      ),
    )
    expect(document.querySelector('[data-testid=terminal-details-content]')?.textContent).toContain(
      '/work/site',
    )
  } finally {
    unmountRegion(host)
    host.remove()
    localStorage.clear()
  }
})

it('reads a tab count once per session watermark and lets an open panel share a fresher value', async () => {
  const read = vi.fn(async () => 3)
  const count = sessionCount(read)
  const listener = vi.fn()
  const stop = count.subscribe(listener)
  const context = (id: string, upto: number) => ({
    t: (key: string) => key,
    data: { session: { id }, timeline: { upto } },
  })
  expect(count.read(context('s', 1))).toBeUndefined()
  expect(count.read(context('s', 1))).toBeUndefined()
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  expect(read).toHaveBeenCalledTimes(1)
  expect(count.read(context('s', 1))).toBe(3)
  // Another session never sees this session's count.
  expect(count.read(context('other', 1))).toBeUndefined()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await new Promise((resolve) => setTimeout(resolve, 0))
  count.set('s', 5)
  read.mockRejectedValueOnce(new Error('offline'))
  expect(count.read(context('s', 2))).toBe(5)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  await new Promise((resolve) => setTimeout(resolve, 0))
  // A failed read keeps the last value.
  expect(count.read(context('s', 2))).toBe(5)
  stop()
})
