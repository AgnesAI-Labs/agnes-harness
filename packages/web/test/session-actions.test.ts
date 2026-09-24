/** @vitest-environment happy-dom */
import type { PageSessionMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { renderSessionNavigation } from '../src/navigation.js'
import { createSessionActions, forkTitle } from '../src/session-actions.js'

const controllers: ReturnType<typeof createSessionActions>[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.replaceChildren()
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
function setup() {
  document.body.innerHTML = `<section id="archived-settings-pane"><input id="archived-search" /><p id="archived-message"></p><p id="archived-empty"></p><ul id="archived-list"></ul><button id="archived-refresh"></button></section><button id="trigger">菜单</button>`
  const session = {
    list: vi.fn<(options: unknown) => Promise<PageSessionMeta>>(async () => ({ items: [] })),
    rename: vi.fn(async () => ({ title: '新名称', archived: false })),
    archive: vi.fn(async () => ({ archived: false })),
  }
  const changed = vi.fn(async () => {})
  const fork = vi.fn(async () => {})
  const error = vi.fn()
  const actions = createSessionActions({ client: { session } as unknown as Client, changed, fork, error })
  controllers.push(actions)
  return {
    session,
    changed,
    fork,
    error,
    actions,
    trigger: document.getElementById('trigger') as HTMLElement,
  }
}

it('keeps the row menu out of the session button and hides archived rows', () => {
  const nav = document.createElement('nav')
  document.body.append(nav)
  const action = vi.fn()
  renderSessionNavigation({
    nav,
    sessions: [row('visible'), row('hidden', true)],
    workspaces: [],
    labels: new Map(),
    open: vi.fn(),
    action,
  })
  expect(nav.querySelectorAll('button.session')).toHaveLength(1)
  expect(nav.querySelector('button button')).toBeNull()
  const trigger = nav.querySelector('.session-menu-trigger') as HTMLButtonElement
  const rowElement = nav.querySelector('.session-row') as HTMLElement
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  trigger.click()
  const panel = document.querySelector('.session-menu-actions') as HTMLElement
  expect([...panel.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    '重命名',
    '分叉会话',
    '归档会话',
  ])
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(rowElement.getAttribute('data-menu-open')).toBe('true')
  ;(panel.querySelector('[role="menuitem"]') as HTMLButtonElement).click()
  expect(action).toHaveBeenCalledWith('rename', 'visible', '名称 visible', trigger)
  expect(document.querySelector('.session-menu-actions')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(rowElement.hasAttribute('data-menu-open')).toBe(false)
})

it('marks the current session on the row so the highlight also covers the row actions', () => {
  const nav = document.createElement('nav')
  document.body.append(nav)
  renderSessionNavigation({
    nav,
    sessions: [row('one'), row('two')],
    workspaces: [],
    labels: new Map(),
    currentId: 'two',
    open: vi.fn(),
    action: vi.fn(),
  })
  const rows = [...nav.querySelectorAll<HTMLElement>('.session-row')]
  // 底色画在行上（照 DSH 的 `.sessionRow.selected`），不是画在内层按钮上：行尾的三点动作槽
  // 是按钮的兄弟节点，底色画在按钮上会在动作槽左侧断掉。
  expect(rows.map((element) => element.dataset.active)).toEqual(['false', 'true'])
  expect(rows[1]?.querySelector('button.session')?.getAttribute('aria-current')).toBe('page')
})

it('prefills and validates rename, shows save failures, allows retry and returns focus', async () => {
  const { actions, session, changed, trigger } = setup()
  await actions.act('rename', 's', '原名', trigger)
  const dialog = document.querySelector('dialog') as HTMLDialogElement
  const input = dialog.querySelector('input') as HTMLInputElement
  const form = dialog.querySelector('form') as HTMLFormElement
  expect(dialog.open).toBe(true)
  expect(input.value).toBe('原名')
  input.value = '字'.repeat(81)
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(session.rename).not.toHaveBeenCalled()
  expect(input.getAttribute('aria-invalid')).toBe('true')
  input.value = '  新名称  '
  session.rename.mockRejectedValueOnce(new Error('保存失败'))
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(session.rename).toHaveBeenCalledTimes(1)
  expect(dialog.textContent).toContain('保存失败')
  expect(dialog.open).toBe(true)
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(session.rename).toHaveBeenLastCalledWith('s', '新名称')
  expect(changed).toHaveBeenCalledOnce()
  expect(dialog.open).toBe(false)
  await flush()
  expect(document.activeElement).toBe(trigger)
})

it('reads every page, searches archived sessions by workspace and restores durably through SDK', async () => {
  const { actions, session, changed } = setup()
  session.list
    .mockResolvedValueOnce({ items: [row('active')], next: 'second' })
    .mockResolvedValueOnce({ items: [row('saved', true)] })
  await actions.loadArchived()
  expect(session.list).toHaveBeenLastCalledWith({ limit: 500, cursor: 'second' })
  const search = document.getElementById('archived-search') as HTMLInputElement
  search.value = '/workspace'
  search.dispatchEvent(new Event('input'))
  const list = document.getElementById('archived-list') as HTMLElement
  expect(list.querySelectorAll('li')).toHaveLength(1)
  expect(list.textContent).toContain('名称 saved')
  search.value = 'absent'
  search.dispatchEvent(new Event('input'))
  expect(list.querySelectorAll('li')).toHaveLength(0)
  search.value = ''
  search.dispatchEvent(new Event('input'))
  ;(list.querySelector('button') as HTMLButtonElement).click()
  await flush()
  expect(session.archive).toHaveBeenCalledWith('saved', false)
  expect(changed).toHaveBeenCalledOnce()
  expect(document.getElementById('archived-empty')?.textContent).toBe('暂无已归档会话。')
})

it('renders titles as text and keeps failed restoration visible and retryable', async () => {
  const { actions, session } = setup()
  session.list.mockResolvedValue({ items: [{ ...row('s', true), title: '<img src=x onerror=alert(1)>' }] })
  await actions.loadArchived()
  session.archive.mockRejectedValueOnce(new Error('网络断开'))
  ;(document.querySelector('#archived-list button') as HTMLButtonElement).click()
  await flush()
  expect(document.querySelector('#archived-list img')).toBeNull()
  expect(document.getElementById('archived-message')?.textContent).toBe('网络断开')
  expect((document.querySelector('#archived-list button') as HTMLButtonElement).disabled).toBe(false)
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
  const dialog = document.querySelector('dialog') as HTMLDialogElement
  ;(dialog.querySelector('input') as HTMLInputElement).value = '新名'
  const submit = () => dialog.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
  submit()
  await flush()
  expect(dialog.textContent).toContain('名称已保存，但列表刷新失败')
  expect(dialog.querySelector('input')?.disabled).toBe(true)
  expect(dialog.querySelector('[type="submit"]')?.textContent).toBe('重试刷新')
  submit()
  await flush()
  expect(session.rename).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledTimes(2)
  expect(dialog.open).toBe(false)
})

it('removes a restored row even if sidebar refresh fails and refresh never repeats the write', async () => {
  const { actions, session, changed } = setup()
  session.list.mockResolvedValueOnce({ items: [row('s', true)] })
  await actions.loadArchived()
  changed.mockRejectedValueOnce(new Error('读取超时'))
  document.querySelector<HTMLButtonElement>('#archived-list button')?.click()
  await flush()
  expect(document.querySelectorAll('#archived-list li')).toHaveLength(0)
  expect(document.getElementById('archived-message')?.textContent).toContain('已取消归档，但列表刷新失败')
  document.getElementById('archived-refresh')?.click()
  await flush()
  expect(session.archive).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledTimes(2)
  expect(document.getElementById('archived-message')?.textContent).toBe('')
})

it('distinguishes a committed archive from a failed refresh', async () => {
  const { actions, changed, error, trigger } = setup()
  changed.mockRejectedValueOnce(new Error('读取超时'))
  await actions.act('archive', 's', '名称', trigger)
  expect(error.mock.calls[0]?.[0].message).toContain('已归档，但列表刷新失败')
})

function replaceArchivedPane() {
  const pane = document.getElementById('archived-settings-pane') as HTMLElement
  pane.replaceWith(pane.cloneNode(true))
}

it.each(['success', 'failure'] as const)(
  'ignores a late old-pane list %s after replacement',
  async (result) => {
    const { actions, session, changed } = setup()
    let resolve!: (page: PageSessionMeta) => void
    let reject!: (error: Error) => void
    session.list.mockReturnValueOnce(
      new Promise((done, fail) => {
        resolve = done
        reject = fail
      }),
    )
    const oldRead = actions.loadArchived()
    session.list.mockResolvedValue({ items: [row('new', true)] })
    replaceArchivedPane()
    await vi.waitFor(() =>
      expect(document.getElementById('archived-list')?.textContent).toContain('名称 new'),
    )
    if (result === 'success') resolve({ items: [row('stale', true)] })
    else reject(new Error('旧请求失败'))
    await oldRead
    expect(document.getElementById('archived-list')?.textContent).toContain('名称 new')
    expect(document.getElementById('archived-list')?.textContent).not.toContain('stale')
    expect(document.getElementById('archived-message')?.textContent).toBe('')
    // Repeated replacements must not multiply event handlers.
    replaceArchivedPane()
    await flush()
    session.list.mockClear()
    document.getElementById('archived-refresh')?.click()
    await flush()
    expect(changed).toHaveBeenCalledOnce()
    expect(session.list).toHaveBeenCalledOnce()
  },
)

it.each(['success', 'failure'] as const)(
  'preserves one pending restore across pane replacement and %s',
  async (result) => {
    const { actions, session, changed } = setup()
    session.list.mockResolvedValue({ items: [row('s', true)] })
    await actions.loadArchived()
    let resolve!: (value: { archived: boolean }) => void
    let reject!: (error: Error) => void
    session.archive.mockReturnValueOnce(
      new Promise((done, fail) => {
        resolve = done
        reject = fail
      }),
    )
    document.querySelector<HTMLButtonElement>('#archived-list button')?.click()
    replaceArchivedPane()
    await flush()
    const restore = document.querySelector<HTMLButtonElement>('#archived-list button') as HTMLButtonElement
    expect(restore.disabled).toBe(true)
    restore.click()
    expect(session.archive).toHaveBeenCalledOnce()
    if (result === 'success') {
      session.list.mockResolvedValue({ items: [] })
      resolve({ archived: false })
      await flush()
      expect(document.querySelectorAll('#archived-list li')).toHaveLength(0)
      expect(changed).toHaveBeenCalledOnce()
    } else {
      reject(new Error('恢复失败'))
      await flush()
      expect(document.getElementById('archived-message')?.textContent).toBe('恢复失败')
      expect(document.querySelector<HTMLButtonElement>('#archived-list button')?.disabled).toBe(false)
      expect(changed).not.toHaveBeenCalled()
    }
  },
)

it('tolerates an absent pane and stops reads and event handlers after disposal', async () => {
  const { actions, session, changed } = setup()
  const pane = document.getElementById('archived-settings-pane') as HTMLElement
  let resolve!: (page: PageSessionMeta) => void
  session.list.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  const read = actions.loadArchived()
  pane.remove()
  await actions.loadArchived()
  resolve({ items: [row('stale', true)] })
  await read
  window.dispatchEvent(new Event('pagehide'))
  document.body.append(pane)
  await flush()
  document.getElementById('archived-refresh')?.click()
  await actions.loadArchived()
  expect(session.list).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
  expect(document.querySelectorAll('#archived-list li')).toHaveLength(0)
})
