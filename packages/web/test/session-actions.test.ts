/** @vitest-environment happy-dom */
import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { renderSessionNavigation, renderWorkspaceOptions } from '../src/navigation.js'
import { createSessionActions, forkTitle } from '../src/session-actions.js'
import { enT, zhT } from './helpers/locale.js'

const controllers: ReturnType<typeof createSessionActions>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  document.querySelectorAll<HTMLElement>('nav, [data-picker-fixture]').forEach(unmountRegion)
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  vi.restoreAllMocks()
})
const row = (id: string, archived = false) => ({
  sessionId: id,
  archived,
  title: `名称 ${id}`,
  cwd: '/workspace',
  createdAt: '',
  lastSeq: 3,
  generation: 1,
  preset: 'code',
})
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
function visible(node: HTMLElement): boolean {
  if (!node.isConnected) return false
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
    if (parent.hidden || parent.style.display === 'none') return false
  return true
}
const runtimeDescriptor = (id: string) => ({
  sessionKey: id,
  generation: {
    id: 'gen-old',
    current: false,
    state: 'draining' as const,
    newer: { id: 'gen-new', effect: 'new-sessions' as const },
  },
  preset: { name: 'code', bundles: [] },
  loop: { id: 'default', version: '1.0.0' },
  providers: [
    {
      kind: 'compaction',
      id: 'default',
      version: '1.0.0',
      binding: 'generation' as const,
      pending: { id: 'summary', effect: 'new-sessions' as const },
    },
  ],
  seams: [],
  resources: {
    profileHash: 'h',
    items: [{ id: 'ext:agnes/skills', resources: ['skills'], revision: 'rev-1' }],
  },
  policy: {
    approvalMode: 'auto-review',
    toolPolicy: 'default',
    toolRuntime: 'default',
    readOnly: false,
    sandbox: { provider: 'local', onUnavailable: 'deny' as const },
  },
  restartRequired: ['sandbox'],
})

function setup(translate = zhT) {
  document.body.innerHTML = `<button id="trigger">菜单</button>`
  const session = {
    list: vi.fn<(options: unknown) => Promise<PageSessionMeta>>(async () => ({ items: [] })),
    rename: vi.fn(async () => ({ title: '新名称', archived: false })),
    archive: vi.fn(async () => ({ archived: false })),
    pin: vi.fn(async () => ({ archived: false })),
    runtime: vi.fn(async (id: string) => runtimeDescriptor(id)),
  }
  const call = vi.fn(async (method: string): Promise<unknown> => {
    if (method === '_agnes/v1/schedules.list') return { schedules: [] }
    throw new Error(`Unavailable fixture method: ${method}`)
  })
  const changed = vi.fn(async () => {})
  const fork = vi.fn(async () => {})
  const error = vi.fn()
  const actions = createSessionActions({
    client: { session, call } as unknown as Client,
    changed,
    fork,
    error,
    translate,
  })
  controllers.push(actions)
  return {
    session,
    call,
    changed,
    fork,
    error,
    actions,
    trigger: document.getElementById('trigger') as HTMLElement,
  }
}

it('keeps the row menu out of the session button and hides archived rows', async () => {
  const nav = document.createElement('nav')
  document.body.append(nav)
  const action = vi.fn()
  renderSessionNavigation(
    {
      nav,
      sessions: [row('visible'), row('hidden', true)],
      runtimePlatform: 'darwin',
      workspaces: [],
      labels: new Map(),
      newSession: vi.fn(),
      open: vi.fn(),
      action,
    },
    zhT,
  )
  expect(nav.querySelectorAll('button.session')).toHaveLength(1)
  expect(nav.querySelector('.session')?.classList.contains('agnes-ui-button')).toBe(true)
  expect(nav.querySelector('.workspace-heading')?.classList.contains('agnes-ui-button')).toBe(true)
  expect(nav.querySelector('button button')).toBeNull()
  const trigger = nav.querySelector('.session-menu-trigger') as HTMLButtonElement
  const rowElement = nav.querySelector('.session-row') as HTMLElement
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  flushSync(() => trigger.click())
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  const panel = document.querySelector('[role=menu]') as HTMLElement
  expect([...panel.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    '置顶',
    '重命名',
    '分叉会话',
    '在访达中打开',
    '运行信息',
    '归档会话',
  ])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await vi.waitFor(() => expect(rowElement.getAttribute('data-menu-open')).toBe('true'))
  ;(panel.querySelector('[role="menuitem"]') as HTMLButtonElement).click()
  expect(action).toHaveBeenCalledWith('pin', 'visible', '名称 visible', trigger)
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  await vi.waitFor(() => expect(rowElement.hasAttribute('data-menu-open')).toBe(false))
  const key = (node: Element, value: string) =>
    node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('置顶'))
  if (!document.activeElement) throw new Error('menu focus missing')
  key(document.activeElement, 'ArrowDown')
  expect(document.activeElement?.textContent).toBe('重命名')
  key(document.activeElement, 'End')
  expect(document.activeElement?.textContent).toBe('归档会话')
  key(document.activeElement, 'Escape')
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  expect(document.activeElement).toBe(trigger)
})

it.each([
  ['/projects/my-folder/', 'my-folder'],
  ['C:\\projects\\my-folder\\', 'my-folder'],
  ['/', '/'],
  ['C:\\', 'C:'],
  ['/projects/   ', '/projects/   '],
])('keeps a display label when workspace names are empty (%s)', (path, label) => {
  const workspace = { path, name: '   ', available: true, lastUsedAt: null, sessionCount: 0 }
  const nav = document.createElement('nav'),
    picker = document.createElement('div')
  picker.dataset.pickerFixture = ''
  document.body.append(nav, picker)
  renderSessionNavigation(
    { nav, workspaces: [workspace], sessions: [], labels: new Map(), newSession() {}, open() {} },
    zhT,
  )
  renderWorkspaceOptions(picker, [workspace], () => {}, zhT)
  // Section headings share the name class, so read the project's own heading row instead.
  const project = nav.querySelector('.workspace-group.is-nested')
  expect(project?.querySelector('.workspace-name')?.textContent).toBe(label)
  expect(project?.querySelector('.workspace-new-session')?.getAttribute('aria-label')).toContain(label)
  expect(picker.querySelector('.workspace-option-name')?.textContent).toBe(label)
})

it('marks the current session on the row so the highlight also covers the row actions', () => {
  const nav = document.createElement('nav')
  document.body.append(nav)
  renderSessionNavigation(
    {
      nav,
      sessions: [row('one'), row('two')],
      workspaces: [],
      labels: new Map(),
      currentId: 'two',
      newSession: vi.fn(),
      open: vi.fn(),
      action: vi.fn(),
    },
    zhT,
  )
  const rows = [...nav.querySelectorAll<HTMLElement>('.session-row')]
  // 底色画在行上（照 DSH 的 `.sessionRow.selected`），不是画在内层按钮上：行尾的三点动作槽
  // 是按钮的兄弟节点，底色画在按钮上会在动作槽左侧断掉。
  expect(rows.map((element) => element.dataset.active)).toEqual(['false', 'true'])
  expect(rows[1]?.querySelector('button.session')?.getAttribute('aria-current')).toBe('page')
})

it('prefills and validates rename, shows save failures, allows retry and returns focus', async () => {
  const { actions, session, changed, trigger } = setup()
  await actions.act('rename', 's', '原名', trigger)
  const dialog = document.querySelector('[role=dialog]') as HTMLElement
  const input = dialog.querySelector('input') as HTMLInputElement
  const form = dialog.querySelector('form') as HTMLFormElement
  expect(visible(dialog)).toBe(true)
  expect(input.value).toBe('原名')
  input.value = '字'.repeat(81)
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  expect(session.rename).not.toHaveBeenCalled()
  expect(input.getAttribute('aria-invalid')).toBe('true')
  input.value = '  新名称  '
  session.rename.mockRejectedValueOnce(new Error('保存失败'))
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  expect(input.disabled).toBe(true)
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect((dialog.closest('dialog') as HTMLDialogElement).open).toBe(true)
  await flush()
  expect(session.rename).toHaveBeenCalledTimes(1)
  expect(dialog.textContent).toContain('保存失败')
  expect(visible(dialog)).toBe(true)
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  await flush()
  expect(session.rename).toHaveBeenLastCalledWith('s', '新名称')
  expect(changed).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(visible(dialog)).toBe(false))
  await flush()
  expect(document.activeElement).toBe(trigger)
  await actions.act('rename', 's', '新名称', trigger)
  expect(document.getElementById('session-rename-input')?.getAttribute('aria-invalid')).toBeNull()
  expect((document.getElementById('session-rename-input') as HTMLInputElement).value).toBe('新名称')
})

it('deduplicates pending actions and reports rejection without claiming success', async () => {
  const { actions, session, error, changed, trigger } = setup()
  let reject!: (error: Error) => void
  session.archive.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  const first = actions.act('archive', 's', '名称', trigger)
  await actions.act('archive', 's', '名称', trigger)
  expect(session.archive).toHaveBeenCalledOnce()
  reject(new Error('拒绝'))
  await first
  expect(error).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
})

it('increments a source suffix and bounds names without splitting emoji', () => {
  expect(forkTitle('你好')).toBe('你好 (1)')
  expect(forkTitle('你好 (1)')).toBe('你好 (2)')
  expect(Array.from(forkTitle('😀'.repeat(80)))).toHaveLength(80)
})

it('retries only refresh after a successful rename and failed list read', async () => {
  const { actions, session, changed, trigger } = setup()
  changed.mockRejectedValueOnce(new Error('读取超时'))
  await actions.act('rename', 's', '旧名', trigger)
  const dialog = document.querySelector('[role=dialog]') as HTMLElement
  ;(dialog.querySelector('input') as HTMLInputElement).value = '新名'
  const submit = () =>
    dialog.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  submit()
  await flush()
  expect(dialog.textContent).toContain('名称已保存，但列表刷新失败')
  expect(dialog.querySelector('input')?.disabled).toBe(true)
  expect(dialog.querySelector('[type="submit"]')?.textContent).toBe('重试刷新')
  submit()
  await flush()
  expect(session.rename).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => expect(visible(dialog)).toBe(false))
})

it('distinguishes a committed archive from a failed refresh', async () => {
  const { actions, changed, error, trigger } = setup()
  changed.mockRejectedValueOnce(new Error('读取超时'))
  await actions.act('archive', 's', '名称', trigger)
  expect(error.mock.calls[0]?.[0].message).toContain('已归档，但列表刷新失败')
})

it.each([
  ['pin', true],
  ['unpin', false],
] as const)('%ss through the SDK and refreshes the sidebar groups', async (action, pinned) => {
  const { actions, session, changed, error, trigger } = setup()
  await actions.act(action, 's', '名称', trigger)
  expect(session.pin).toHaveBeenCalledWith('s', pinned)
  expect(changed).toHaveBeenCalledOnce()
  expect(session.archive).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  session.pin.mockRejectedValueOnce(new Error('SESSION_ARCHIVED'))
  await actions.act(action, 's', '名称', trigger)
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'SESSION_ARCHIVED' }))
  expect(changed).toHaveBeenCalledOnce()
})

it('shows the Host runtime descriptor in the session menu dialog, with pending and restart notes', async () => {
  document.documentElement.lang = 'zh-CN'
  const { actions, session, call, trigger } = setup((key, values) =>
    (document.documentElement.lang === 'en' ? enT : zhT)(key, values),
  )
  await actions.act('runtime', 's', '名称', trigger)
  await vi.waitFor(() => expect(document.querySelector('[data-session-runtime="s"]')).not.toBeNull())
  expect(session.runtime).toHaveBeenCalledWith('s')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="session-schedules"]')).not.toBeNull())
  expect(call).toHaveBeenCalledWith('_agnes/v1/schedules.list', { scope: 'session', sessionKey: 's' })
  const text = document.querySelector('[data-session-runtime="s"]')?.textContent ?? ''
  expect(document.querySelector('[data-testid="session-schedules"]')?.textContent).toContain(
    '这个会话的定时任务',
  )
  expect(text).toContain('gen-old')
  expect(text).toContain('有更新的代次 gen-new：新会话生效')
  expect(text).toContain('已配置 summary：新会话生效')
  expect(text).toContain('审批 auto-review')
  expect(text).toContain('ext:agnes/skills rev-1')
  expect(text).toContain('你需要重启才能生效：sandbox')
  document.documentElement.lang = 'en'
  window.dispatchEvent(new Event('agnes:locale-changed'))
  await vi.waitFor(() =>
    expect(document.getElementById('session-runtime-heading')?.textContent).toBe('Runtime info'),
  )
  expect(document.querySelector('[data-session-runtime="s"]')?.textContent).toContain(
    'Newer generation gen-new',
  )
  expect(document.querySelector('[data-testid="session-schedules"]')?.textContent).toContain(
    'Scheduled tasks for this session',
  )
  const replacement = trigger.cloneNode(true) as HTMLButtonElement
  replacement.dataset.sessionActionId = 's'
  trigger.replaceWith(replacement)
  document.querySelector<HTMLButtonElement>('.dialog-actions button')?.click()
  await vi.waitFor(() => expect(document.activeElement).toBe(replacement))
})

it('reports a failed runtime read and closes the dialog', async () => {
  const { actions, session, error, trigger } = setup()
  session.runtime.mockRejectedValueOnce(new Error('gone'))
  await actions.act('runtime', 's', '名称', trigger)
  await vi.waitFor(() => expect(error).toHaveBeenCalled())
  expect(document.querySelector('[data-session-runtime]')).toBeNull()
})

it('shares rename validation and refresh recovery with the inline title editor', async () => {
  const { actions, session, changed } = setup()
  const save = actions.renameInline('session-a', 'Old')
  for (const title of [' ', 'x'.repeat(81), 'bad\nname', '\u202Ehidden'])
    await expect(save(title)).rejects.toThrow('1–80')
  expect(session.rename).not.toHaveBeenCalled()
  changed.mockRejectedValueOnce(new Error('Synthetic refresh failure'))
  await expect(save('  New  ')).rejects.toThrow('Synthetic refresh failure')
  expect(session.rename).toHaveBeenCalledWith('session-a', 'New')
  await save('New')
  expect(session.rename).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledTimes(2)
})

it('reveals the selected session workspace through RPC and sends failures to the existing notice path', async () => {
  const { actions, call, error, trigger, changed, session } = setup()
  call.mockResolvedValueOnce({ opened: true })
  await actions.act('revealWorkspace', 's', 'Session', trigger)
  expect(call).toHaveBeenLastCalledWith('_agnes/v1/session.revealWorkspace', { sessionId: 's' })
  expect(changed).not.toHaveBeenCalled()
  expect(session.archive).not.toHaveBeenCalled()
  const failure = new Error('Desktop unavailable')
  call.mockRejectedValueOnce(failure)
  await actions.act('revealWorkspace', 's', 'Session', trigger)
  expect(error).toHaveBeenCalledWith(failure)
  expect(trigger.hasAttribute('aria-busy')).toBe(false)
})
