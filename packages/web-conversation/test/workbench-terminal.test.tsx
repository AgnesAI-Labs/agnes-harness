/** @vitest-environment happy-dom */
import './terminal-fixture.js'
import type { SessionJob } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { fireEvent, within } from '@testing-library/dom'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'
import { sessionCount } from '../src/workbench/tab-counts.js'
import { TerminalPanel } from '../src/workbench/terminal-panel.js'
import { TerminalView } from '../src/workbench/terminal-view.js'

const job = (patch: Partial<SessionJob> = {}): SessionJob => ({
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
const hosts: HTMLElement[] = []
function mount(jobs = [job()]) {
  const jobsControl = vi.fn(
    async (input: { operation: string; shell?: 'zsh' | 'bash' | 'pwsh'; jobId?: string }) => {
      if (input.operation === 'open') {
        const row = job({
          id: `human-${jobs.length}`,
          owner: 'human',
          shell: input.shell ?? 'bash',
          command: input.shell ?? 'bash',
        })
        jobs.push(row)
        return { output: row }
      }
      const row = jobs.find((row) => row.id === input.jobId)
      if (input.operation === 'kill' && row) {
        row.status = 'killed'
        row.code = -1
        return { output: row }
      }
      return { output: { ok: true } }
    },
  )
  const session = {
    id: 's',
    jobsRead: async (id?: string) => ({
      jobs: jobs.map(({ stdout, stderr, ...row }) => row),
      completions: jobs.filter((row) => row.status !== 'running'),
      ...(id ? { job: jobs.find((row) => row.id === id) } : {}),
    }),
    jobsControl,
  } as unknown as Session
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  renderRegion(
    host,
    <TerminalPanel
      context={{
        t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
        data: { session, disabled: false },
      }}
    />,
  )
  return { host, jobsControl, session }
}
afterEach(() => {
  for (const host of hosts.splice(0)) {
    unmountRegion(host)
    host.remove()
  }
  localStorage.clear()
})
const click = (node: Element | null) => {
  if (!node) throw new Error('Missing control')
  flushSync(() => fireEvent.click(node))
}
async function menu(tab: Element, keyboard = false) {
  flushSync(() =>
    keyboard ? fireEvent.keyDown(tab, { key: 'F10', shiftKey: true }) : fireEvent.contextMenu(tab),
  )
  let popup: HTMLElement | null = null
  await vi.waitFor(() => {
    const id = tab.getAttribute('aria-controls')
    popup = id ? document.getElementById(id) : null
    expect(popup?.getAttribute('role')).toBe('menu')
  })
  return within(popup as unknown as HTMLElement)
}

it('opens no terminal until asked, lists Agent jobs read-only, retains completed output until removal and supports shell menus', async () => {
  localStorage.setItem('agnes.workbench.terminal.shell', 'zsh')
  const agent = job()
  const listed = [agent]
  const { host, jobsControl } = mount(listed)
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(1))
  // Opening the dock to watch the agent starts no shell for the person.
  expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(0)
  click(host.querySelector('[data-testid=terminal-new]'))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(2))
  expect(host.querySelector('.workbench-terminal-tabs')?.getAttribute('role')).toBe('toolbar')
  expect(jobsControl).toHaveBeenCalledWith({ operation: 'open', shell: 'zsh', columns: 100, rows: 30 })
  expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(1)
  expect(host.textContent).not.toContain('关闭工作台后')
  click(host.querySelector('#terminal-tab-job'))
  await vi.waitFor(() =>
    expect(host.querySelector('.workbench-terminal-readonly')?.textContent).toContain(
      '智能体运行的命令 · 只读',
    ),
  )
  await vi.waitFor(() => expect(host.querySelector('input')?.disabled).toBe(true))
  agent.status = 'failed'
  agent.code = 1
  agent.stdout = 'retained output'
  await vi.waitFor(() => expect(host.textContent).toContain('退出 1'))
  await vi.waitFor(() => expect(host.textContent).toContain('retained output'))
  listed.splice(0, 1) // The backend registry can evict a completed job; the followed output remains available.
  click(host.querySelector('#terminal-tab-human-1'))
  click(host.querySelector('#terminal-tab-job'))
  await vi.waitFor(() => expect(host.textContent).toContain('retained output'))
  expect(host.querySelector('#terminal-tab-job')?.getAttribute('aria-pressed')).toBe('true')
  const agentActions = await menu(host.querySelector('#terminal-tab-job') as HTMLElement, true)
  expect(agentActions.queryByText('重命名')).toBeNull()
  click(agentActions.getByText('取消跟随'))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(1))
  const actions = await menu(host.querySelector('[data-testid=terminal-new]') as HTMLElement)
  click(actions.getByRole('menuitem', { name: /新建终端 · bash/ }))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(2))
  expect(localStorage.getItem('agnes.workbench.terminal.shell')).toBe('bash')
  click(host.querySelector('[data-testid=terminal-new]'))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(3))
})

it('names a built-in child agent as a subagent and keeps a provider name that means something', async () => {
  const builtIn = job({
    id: 'child:agent:c453a576192f05',
    kind: 'child',
    command: 'in-process',
  })
  const external = job({ id: 'child:external:7f21', kind: 'child', command: 'acp' })
  const { host } = mount([builtIn, external])
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(2))
  const tabs = [...host.querySelectorAll('[data-testid=terminal-tab]')].map((tab) => tab.textContent)
  expect(tabs[0]).toContain('子智能体')
  // The child id still tells two subagents apart.
  expect(tabs[0]).toContain('192f05')
  expect(tabs[0]).not.toContain('in-process')
  expect(tabs[1]).toContain('acp')
})

it('opens no terminal on mount or remount, and starts one from the minimal new button', async () => {
  const { host, jobsControl, session } = mount([])
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-empty]')).not.toBeNull())
  expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(0)
  click(within(host).getByRole('button', { name: '+ 新建终端' }))
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(1))
  click(host.querySelector('[data-testid=terminal-tab-close]'))
  await vi.waitFor(() => expect(within(document.body).getByRole('button', { name: '终止进程' })).toBeTruthy())
  click(within(document.body).getByRole('button', { name: '终止进程' }))
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-empty]')).not.toBeNull())
  expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(1)
  unmountRegion(host)
  renderRegion(
    host,
    <TerminalPanel
      context={{
        t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
        data: { session, disabled: false },
      }}
    />,
  )
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-empty]')).not.toBeNull())
  expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(1)
  click(within(host).getByRole('button', { name: '+ 新建终端' }))
  await vi.waitFor(() =>
    expect(jobsControl.mock.calls.filter(([input]) => input.operation === 'open')).toHaveLength(2),
  )
})

it('long-presses plus without also creating a terminal, and tolerates unavailable browser storage', async () => {
  const human = job({ id: 'mine', owner: 'human', shell: 'zsh' })
  const { host, jobsControl } = mount([human])
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-tab]')).not.toBeNull())
  const plus = host.querySelector('[data-testid=terminal-new]') as HTMLElement
  vi.useFakeTimers()
  try {
    flushSync(() => fireEvent.pointerDown(plus, { pointerType: 'touch' }))
    flushSync(() => vi.advanceTimersByTime(501))
    flushSync(() => fireEvent.pointerUp(plus, { pointerType: 'touch' }))
    click(plus)
  } finally {
    vi.useRealTimers()
  }
  expect(jobsControl).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(plus.getAttribute('aria-expanded')).toBe('true'))
  const id = plus.getAttribute('aria-controls')
  await vi.waitFor(() => expect(id ? document.getElementById(id) : null).not.toBeNull())
  const popup = id ? document.getElementById(id) : null
  if (!popup) throw new Error('Missing held menu')
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  try {
    click(within(popup).getByRole('menuitem', { name: /新建终端 · pwsh/ }))
    await vi.waitFor(() =>
      expect(jobsControl).toHaveBeenCalledWith({ operation: 'open', shell: 'pwsh', columns: 100, rows: 30 }),
    )
  } finally {
    get.mockRestore()
    set.mockRestore()
  }
})

it('offers human controls and details, renames with Enter, Escape, blur and IME, and restores names after refresh', async () => {
  const human = job({ id: 'mine', owner: 'human', shell: 'zsh' })
  const { host, jobsControl, session } = mount([human])
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-tab]')).not.toBeNull())
  await vi.waitFor(() => expect(host.querySelector('[data-testid=terminal-fixture-resize]')).not.toBeNull())
  click(host.querySelector('[data-testid=terminal-fixture-resize]'))
  await vi.waitFor(() =>
    expect(jobsControl).toHaveBeenCalledWith({ operation: 'resize', jobId: 'mine', columns: 80, rows: 24 }),
  )
  let tab = host.querySelector('[data-testid=terminal-tab]') as HTMLElement
  let actions = await menu(tab, true)
  click(actions.getByRole('menuitem', { name: /中断/ }))
  await vi.waitFor(() =>
    expect(jobsControl).toHaveBeenCalledWith({ operation: 'signal', jobId: 'mine', signal: 'SIGINT' }),
  )
  actions = await menu(tab)
  click(actions.getByText('详情'))
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid=terminal-details-content]')?.textContent).toContain(
      '/work/site',
    ),
  )
  expect(document.querySelector('[data-testid=terminal-details-content]')?.textContent).toContain('mine')
  flushSync(() =>
    fireEvent.keyDown(document.querySelector('[data-testid=terminal-details-content]') as HTMLElement, {
      key: 'Escape',
    }),
  )
  actions = await menu(tab)
  click(actions.getByText('重命名'))
  let input = within(host).getByLabelText('重命名') as HTMLInputElement
  fireEvent.input(input, { target: { value: 'build' } })
  flushSync(() => fireEvent.keyDown(input, { key: 'Enter', isComposing: true }))
  expect(within(host).getByLabelText('重命名')).toBe(input)
  flushSync(() => fireEvent.keyDown(input, { key: 'Enter' }))
  expect(tab.textContent).toContain('build')
  flushSync(() => fireEvent.doubleClick(tab))
  input = within(host).getByLabelText('重命名') as HTMLInputElement
  fireEvent.input(input, { target: { value: 'discard' } })
  flushSync(() => fireEvent.keyDown(input, { key: 'Escape' }))
  expect(tab.textContent).toContain('build')
  flushSync(() => fireEvent.doubleClick(tab))
  input = within(host).getByLabelText('重命名') as HTMLInputElement
  fireEvent.input(input, { target: { value: 'server' } })
  flushSync(() => input.blur())
  expect(tab.textContent).toContain('server')
  unmountRegion(host)
  renderRegion(
    host,
    <TerminalPanel
      context={{
        t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
        data: { session, disabled: false },
      }}
    />,
  )
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid=terminal-tab]')?.textContent).toContain('server'),
  )
  tab = host.querySelector('[data-testid=terminal-tab]') as HTMLElement
  actions = await menu(tab)
  click(actions.getByText('终止进程'))
  await vi.waitFor(() => expect(within(document.body).getByRole('button', { name: '终止进程' })).toBeTruthy())
  click(within(document.body).getByRole('button', { name: '终止进程' }))
  await vi.waitFor(() => expect(jobsControl).toHaveBeenCalledWith({ operation: 'kill', jobId: 'mine' }))
})

it('shows the exit line and dot tone, allows tab arrows and dismisses truncation notices', async () => {
  const mine = job({ id: 'mine', owner: 'human', status: 'failed', code: 1, stdout: 'failed output' })
  const success = job({
    id: 'success',
    owner: 'human',
    status: 'completed',
    code: 0,
    stdout: 'success output',
    truncated: true,
  })
  const { host } = mount([mine, success])
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=terminal-tab]')).toHaveLength(2))
  const [first, second] = [...host.querySelectorAll<HTMLElement>('[data-testid=terminal-tab]')]
  await vi.waitFor(() => expect(host.textContent).toContain('进程已退出（1）'))
  expect(first?.querySelector('.agh-status-dot')?.getAttribute('data-tone')).toBe('danger')
  expect(second?.querySelector('.agh-status-dot')?.getAttribute('data-tone')).toBe('neutral')
  flushSync(() => fireEvent.keyDown(first as HTMLElement, { key: 'ArrowRight' }))
  await vi.waitFor(() => expect(host.textContent).toContain('进程已退出（0）'))
  expect(second?.getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector('.workbench-terminal-note')?.textContent).toContain('输出已达到上限')
  click(within(host).getByLabelText('关闭提示'))
  expect(host.querySelector('.workbench-terminal-note')).toBeNull()
  expect(host.querySelector('.workbench-terminal-status')).toBeNull()
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
  let finish!: (value: number) => void
  read.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve
      }),
  )
  expect(count.read(context('s', 3))).toBe(5)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  count.set('s', 8) // The open panel has already observed a newer count.
  finish(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(count.read(context('s', 3))).toBe(8)
  stop()
})

it.each(['zh-CN', 'en'] as const)(
  'contains a rejected lazy terminal load and retries with a fresh import (%s)',
  async (language) => {
    const originalLanguage = document.documentElement.lang
    document.documentElement.lang = language
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = document.createElement('div')
    document.body.append(host)
    hosts.push(host)
    const t = createCatalogTranslator(workbenchLocaleCatalog, language)
    const load = vi
      .fn<() => Promise<typeof import('@agnes/web-ui/terminal')>>()
      .mockRejectedValueOnce(new Error('synthetic chunk 404'))
      .mockResolvedValue({ TerminalScreen: () => <output>Terminal ready</output> })
    try {
      renderRegion(
        host,
        <TerminalView
          failure={t('workbench.terminal.loadFailed')}
          loading={t('workbench.terminal.loading')}
          load={load}
          stdout=""
          stderr=""
          writable={false}
          label="Terminal"
          onData={() => {}}
          onResize={() => {}}
        />,
      )
      await vi.waitFor(() =>
        expect(host.querySelector('[role=alert]')?.textContent).toContain(
          language === 'zh-CN' ? '终端加载失败' : 'Terminal failed to load',
        ),
      )
      expect(host.querySelector('[data-agnes-region-error="terminal"]')).not.toBeNull()
      click(within(host).getByRole('button', { name: language === 'zh-CN' ? '重试' : 'Retry' }))
      await vi.waitFor(() => expect(host.textContent).toContain('Terminal ready'))
      expect(host.querySelector('[role=alert]')).toBeNull()
    } finally {
      diagnostics.mockRestore()
      document.documentElement.lang = originalLanguage
    }
  },
)

it('pauses terminal reads while hidden and catches up output once on return', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let hidden = false
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  const terminal = job({ owner: 'human', stdout: 'before hidden' })
  const { session, host, jobsControl } = mount([terminal])
  const reads = vi.spyOn(session, 'jobsRead')
  try {
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const before = reads.mock.calls.length
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(reads.mock.calls.length - before).toBe(0)
    terminal.stdout += '\noutput while hidden'
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(reads.mock.calls.length - before).toBe(1)
    expect(host.textContent).toContain('output while hidden')
    expect(jobsControl).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'kill' }))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(reads.mock.calls.length - before).toBe(2)
    unmountRegion(host)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(reads.mock.calls.length - before).toBe(2)
  } finally {
    unmountRegion(host)
    visibility.mockRestore()
    reads.mockRestore()
    vi.useRealTimers()
  }
})
