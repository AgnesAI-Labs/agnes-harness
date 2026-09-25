/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const revision = 'a'.repeat(64)
const server = {
  kind: 'mcp',
  resourceId: 'mcp:fixture',
  serverId: 'fixture',
  displayName: 'Fixture MCP',
  revision,
  transportKind: 'stdio',
  secretBindingKind: 'none',
  source: 'managed',
  trust: 'untrusted',
  desired: 'disabled',
  actual: 'disabled',
  definition: {
    serverId: 'fixture',
    displayName: 'Fixture MCP',
    transport: { kind: 'stdio', executable: 'fixture', args: [] },
    secretBinding: { kind: 'none' },
  },
}
let skillsFixture: unknown[] = []
let current: typeof server
let operationState: 'succeeded' | 'failed'
let refused: boolean
let offline: boolean
let emptyMcp: boolean
/** When set, the skills list reports a failed source with this reason code. */
let rootFailureCode: string | undefined
let failReload: boolean
let failPolling: boolean
let pendingPage: { promise: Promise<Response>; resolve: (response: Response) => void } | undefined
let resourceMount: {
  sync(scope: { tab: 'skills' | 'mcp'; workspaceId?: string }, options?: { refresh?: boolean }): Promise<void>
}
const requests: Array<{ path: string; body: Record<string, unknown> }> = []
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
/**
 * Clicks a detail action. Every action confirms through the shared dialog
 * (@agnes/web-admin-frame), so the helper answers it: confirm by default, cancel when asked.
 */
const action = (label: string, options: { confirm?: boolean } = {}) => {
  const control = [...document.querySelectorAll<HTMLButtonElement>('#resource-detail button')].find(
    (node) => node.textContent === label,
  )
  expect(control, label).toBeDefined()
  if (!control) throw new Error(`missing action: ${label}`)
  control.click()
  const dialog = byId<HTMLDialogElement>('admin-confirm')
  if (!dialog.open) return
  byId<HTMLButtonElement>(options.confirm === false ? 'admin-confirm-cancel' : 'admin-confirm-action').click()
}
/** Submits the MCP form and answers the shared confirmation dialog it opens before posting. */
const submitMcpForm = async () => {
  byId('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(byId<HTMLDialogElement>('admin-confirm').open).toBe(true))
  byId<HTMLButtonElement>('admin-confirm-action').click()
}
const change = (id: string, value: string) => {
  const control = byId<HTMLInputElement>(id)
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
}
const submitted = (path: string) => requests.filter((request) => request.path === path)
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

beforeEach(async () => {
  vi.resetModules()
  requests.length = 0
  skillsFixture = []
  current = { ...server }
  operationState = 'succeeded'
  refused = false
  offline = false
  emptyMcp = false
  failReload = false
  failPolling = false
  pendingPage = undefined
  document.documentElement.innerHTML = (
    await readFile(
      resolve(
        process.cwd().endsWith('/packages/resource-control-web')
          ? '../web/public/resources.html'
          : 'packages/web/public/resources.html',
      ),
      'utf8',
    )
  )
    .replace('<script type="module" src="/resources.js"></script>', '')
    .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.replace('/admin/resources/api/', '')
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      requests.push({ path, body })
      if (offline) throw new Error('private network detail')
      if (path === 'context')
        return Response.json({ profile: 'default', clientId: 'dom', permissions: [], readOnly: false })
      if (path === 'skills/list')
        return Response.json({
          items: skillsFixture,
          ...(rootFailureCode
            ? {
                skillRoots: [
                  {
                    rootKey: 'user-agnes',
                    scope: 'user',
                    state: 'unavailable',
                    diagnostic: { code: rootFailureCode },
                  },
                ],
              }
            : {}),
        })
      if (path === 'mcp/list' && failReload) throw new Error('private catalog detail')
      if (path === 'mcp/list') {
        if (emptyMcp) return Response.json({ items: [] })
        if (body.cursor === 'page-1') {
          if (pendingPage) return pendingPage.promise
          return Response.json({
            items: [{ ...current, resourceId: 'mcp:page-1', serverId: 'page-1', displayName: 'MCP page 1' }],
          })
        }
        return Response.json({ items: [current], nextCursor: 'page-1' })
      }
      if (path === 'operations/get' && failPolling) throw new Error('private polling detail')
      if (path === 'operations/get')
        return Response.json({
          operationId: 'op',
          state: operationState,
          ...(operationState === 'failed'
            ? { lastSafeError: { code: 'MCP_CONNECT_FAILED', message: '连接已断开，请重连。' } }
            : {}),
        })
      if (path === 'mcp/status')
        return Response.json({
          connectionState: 'disconnected',
          toolCount: 0,
          observedAt: Date.now(),
          lastSafeError: { code: 'MCP_DISCONNECTED', message: '连接已断开。' },
        })
      if (refused)
        return Response.json(
          { error: { code: 'RESOURCE_TRUST_REQUIRED', message: '请先信任当前版本。' } },
          { status: 403 },
        )
      if (path === 'mcp/trust') current = { ...current, trust: String(body.trust) }
      if (path === 'mcp/enable') current = { ...current, desired: 'enabled', actual: 'ready' }
      if (path === 'mcp/disable') current = { ...current, desired: 'disabled', actual: 'disabled' }
      return Response.json({ operationId: 'op' })
    }),
  )
  const { mountResourceAdmin } = await import('../src/admin.js')
  resourceMount = mountResourceAdmin()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('Skill'))
  byId('mcp-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('Fixture MCP'))
  // 详情是模态框，选中就等于弹出，所以挂载和切 Tab 都不再替用户选中任何一项。
  // 需要详情的用例必须像用户那样先点开一行；下面这行就是这件事。
  byId('resource-list').querySelector<HTMLElement>('.resource-row')?.click()
  await vi.waitFor(() => expect(byId('resource-detail').textContent).toContain('Fixture MCP'))
})

it('keeps manual MCP creation hidden when the MCP tab is selected', () => {
  expect(byId<HTMLButtonElement>('mcp-create').hidden).toBe(true)
})

it('refreshes Resource Admin when reopened with the same workspace and tab', async () => {
  expect(submitted('mcp/list')).toHaveLength(1)

  await resourceMount.sync({ tab: 'mcp' }, { refresh: true })

  expect(submitted('mcp/list')).toHaveLength(2)
})

it('does not append a stale load-more response after switching tabs', async () => {
  let resolvePage!: (response: Response) => void
  pendingPage = {
    promise: new Promise<Response>((resolve) => {
      resolvePage = resolve
    }),
    resolve: (response) => resolvePage(response),
  }
  const more = [...byId('resource-list').querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '加载更多',
  )
  expect(more).toBeDefined()
  more?.click()
  await vi.waitFor(() => expect(submitted('mcp/list').at(-1)?.body.cursor).toBe('page-1'))

  const switching = resourceMount.sync({ tab: 'skills' })
  await vi.waitFor(() => expect(submitted('skills/list')).toHaveLength(2))
  resolvePage(
    Response.json({
      items: [
        { ...current, resourceId: 'mcp:stale-page', serverId: 'stale-page', displayName: '旧 MCP 分页' },
      ],
    }),
  )
  await switching

  expect(byId('resource-list').textContent).not.toContain('旧 MCP 分页')
  expect(byId('resource-list').querySelectorAll('.resource-row')).toHaveLength(0)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.head.replaceChildren()
  document.body.replaceChildren()
})

it.each(['stdio-env', 'http-bearer', 'http-header'])(
  'submits the selected transport and %s SecretRef from the real form',
  async (kind) => {
    byId('mcp-create').click()
    change('mcp-id', 'created')
    change('mcp-name', 'Created MCP')
    const stdio = kind === 'stdio-env'
    change('mcp-transport', stdio ? 'stdio' : 'http')
    change('mcp-secret-kind', kind)
    expect(byId('mcp-url-row').hidden).toBe(stdio)
    expect(byId('mcp-executable-row').hidden).toBe(!stdio)
    expect(byId('mcp-header-row').hidden).toBe(kind !== 'http-header')
    change('mcp-secret', stdio ? 'TOKEN=secret://dom/token' : 'secret://dom/token')
    change('mcp-executable', 'fixture')
    change('mcp-args', '--mode\ntest')
    change('mcp-url', 'https://example.com/mcp')
    change('mcp-header-name', 'x-api-token')
    await submitMcpForm()
    await vi.waitFor(() => expect(submitted('mcp/create')).toHaveLength(1))
    expect(submitted('mcp/create')[0]?.body.definition).toEqual({
      serverId: 'created',
      displayName: 'Created MCP',
      transport: stdio
        ? { kind: 'stdio', executable: 'fixture', args: ['--mode', 'test'] }
        : { kind: 'http', url: 'https://example.com/mcp' },
      secretBinding: stdio
        ? { kind, env: { TOKEN: 'secret://dom/token' } }
        : {
            kind,
            credentialRef: 'secret://dom/token',
            ...(kind === 'http-header' ? { headerName: 'x-api-token' } : {}),
          },
    })
    await settle()
    expect(byId<HTMLDialogElement>('mcp-dialog').open).toBe(false)
  },
)

it('flags an illegal tool name inline while typing and clears it once fixed', () => {
  byId('mcp-create').click()
  change('mcp-id', 'demo')
  change('mcp-name', 'Demo')
  change('mcp-transport', 'http')
  change('mcp-url', 'https://example.com/mcp')
  change('mcp-tools', '1')
  expect(byId('mcp-error').textContent).toContain('工具名')
  expect(byId<HTMLTextAreaElement>('mcp-tools').getAttribute('aria-invalid')).toBe('true')
  change('mcp-tools', 'fetch')
  expect(byId('mcp-error').textContent).toBe('')
  expect(byId<HTMLTextAreaElement>('mcp-tools').getAttribute('aria-invalid')).toBeNull()
})

it('flags credential material in the URL before submit', () => {
  byId('mcp-create').click()
  change('mcp-id', 'demo')
  change('mcp-name', 'Demo')
  change('mcp-transport', 'http')
  change('mcp-url', 'https://example.com/mcp?token=x')
  expect(byId('mcp-error').textContent).toContain('SecretRef')
  expect(byId<HTMLInputElement>('mcp-url').getAttribute('aria-invalid')).toBe('true')
})

it('blocks submit with a field message instead of posting an invalid definition', async () => {
  byId('mcp-create').click()
  change('mcp-id', 'demo')
  change('mcp-name', 'Demo')
  change('mcp-transport', 'stdio')
  change('mcp-executable', 'npx')
  change('mcp-tools', '1')
  byId('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(byId<HTMLDialogElement>('admin-confirm').open).toBe(false)
  expect(submitted('mcp/create')).toHaveLength(0)
  expect(byId('mcp-error').textContent).toContain('工具名')
  expect(byId<HTMLTextAreaElement>('mcp-tools').getAttribute('aria-invalid')).toBe('true')
})

it('uses shared pickers for transport, permitted credentials and headers, then resets on reopen', async () => {
  byId('mcp-create').click()
  byId('mcp-secret-kind-trigger').click()
  expect(document.querySelectorAll('#mcp-secret-kind-listbox [role="option"]')).toHaveLength(2)
  byId('mcp-secret-kind-listbox-1').click()
  expect(byId<HTMLSelectElement>('mcp-secret-kind').value).toBe('stdio-env')
  byId('mcp-transport-trigger').click()
  byId('mcp-transport-listbox-1').click()
  expect(byId('mcp-executable-row').hidden).toBe(true)
  expect(byId('mcp-url-row').hidden).toBe(false)
  expect(byId('mcp-secret-kind-trigger').textContent).toBe('无凭据')
  byId('mcp-secret-kind-trigger').click()
  expect(document.querySelectorAll('#mcp-secret-kind-listbox [role="option"]')).toHaveLength(3)
  byId('mcp-secret-kind-listbox-2').click()
  expect(byId('mcp-header-row').hidden).toBe(false)
  byId('mcp-header-name-trigger').click()
  byId('mcp-header-name-listbox-1').click()
  expect(byId<HTMLSelectElement>('mcp-header-name').value).toBe('x-api-token')
  byId('mcp-cancel').click()
  byId('mcp-create').click()
  await settle()
  expect(byId('mcp-transport-trigger').textContent).toBe('本地 stdio')
  expect(byId('mcp-secret-kind-trigger').textContent).toBe('无凭据')
  expect(submitted('mcp/create')).toHaveLength(0)
})

it('tells the user a newly created MCP server still needs trust and enable', async () => {
  byId('mcp-create').click()
  change('mcp-id', 'created')
  change('mcp-name', 'Created MCP')
  change('mcp-executable', 'fixture')
  await submitMcpForm()
  await vi.waitFor(() => expect(submitted('mcp/create')).toHaveLength(1))
  await vi.waitFor(() => expect(byId('resource-notice').textContent).toContain('已创建，但尚未可用'))
  expect(byId('resource-notice').textContent).toContain('信任')
  expect(byId('resource-notice').textContent).toContain('启用')
  expect(byId('resource-notice').dataset.kind).toBe('success')
})

it('says why a skill source produced no results instead of only that it failed', async () => {
  rootFailureCode = 'invalid-frontmatter'
  byId('skills-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('刷新失败'))
  const rendered = byId('resource-list').textContent ?? ''
  expect(rendered).toContain('技能来源 1 个')
  expect(rendered).toContain('frontmatter 不合法')
  // 旧文案是实现视角的措辞，现在不再出现。
  expect(rendered).not.toContain('没有可保留的目录')
})

it('uses the shared empty-state structure for Skill and MCP pages', async () => {
  byId('skills-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').querySelector('.admin-empty-state')).not.toBeNull())

  const skillsEmpty = byId('resource-list').querySelector<HTMLElement>('.admin-empty-state')
  expect(skillsEmpty?.querySelector('h2')?.textContent).toBe('还没有发现 Skill')
  expect(skillsEmpty?.querySelectorAll('.admin-empty-state-hints li')).toHaveLength(5)

  emptyMcp = true
  byId('mcp-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').querySelector('.admin-empty-state')).not.toBeNull())

  const mcpEmpty = byId('resource-list').querySelector<HTMLElement>('.admin-empty-state')
  expect(mcpEmpty?.querySelector('h2')?.textContent).toBe('还没有 MCP 服务')
  expect(mcpEmpty?.querySelector('.admin-empty-state-hints')).toBeNull()
})

it('resets incompatible SecretRef selection on transport change and cancellation does not submit', () => {
  byId('mcp-create').click()
  change('mcp-secret-kind', 'stdio-env')
  change('mcp-transport', 'http')
  expect(byId<HTMLSelectElement>('mcp-secret-kind').value).toBe('none')
  expect(byId('mcp-secret-row').hidden).toBe(true)
  byId('mcp-cancel').click()
  expect(submitted('mcp/create')).toHaveLength(0)
})

it('does not pop a detail modal from merely loading a list', async () => {
  // 上一版详情是常驻的右列，列表载入后会替用户选中第一项。详情改成模态框之后，
  // 同一个"顺手选中"就变成了一进 Tab 就弹出第一个资源的详情。
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(true)
  byId('skills-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('Skill'))
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
  byId('mcp-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('Fixture MCP'))
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
})

it('toggles the row Switch without opening that row in the detail modal', async () => {
  action('关闭详情')
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
  const toggle = byId('resource-list').querySelector<HTMLButtonElement>('.switch')
  expect(toggle).not.toBeNull()
  toggle?.click()
  byId<HTMLButtonElement>('admin-confirm-action').click()
  await vi.waitFor(() => expect(submitted('mcp/enable')).toHaveLength(1))
  // 操作完成后会重载列表；此刻也不能因为"没人选中"就替用户弹出一个详情。
  await vi.waitFor(() => expect(submitted('mcp/list').length).toBeGreaterThan(1))
  await settle()
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
})

it('keeps Space on the row Switch from being read as "open detail"', async () => {
  action('关闭详情')
  const toggle = byId('resource-list').querySelector<HTMLButtonElement>('.switch')
  toggle?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  // 行监听到的是冒泡上来的按键；只有焦点在行本身时才算"打开详情"。
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
})

it('returns focus to the row it was opened from when the detail modal closes', async () => {
  // 详情是模态框：关闭后焦点必须回到触发行。渲染会 replaceChildren() 重建列表，
  // 所以"把焦点还给当初那个元素"是做不到的 —— 必须按 data-resource-id 找回新行。
  const opened = byId('resource-list').querySelector<HTMLElement>('.resource-row')
  expect(opened).not.toBeNull()
  expect(opened?.dataset.resourceId).toBe('mcp:fixture')
  opened?.click()
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(true)

  action('关闭详情')
  expect(byId<HTMLDialogElement>('resource-detail').open).toBe(false)
  const restored = byId('resource-list').querySelector<HTMLElement>('.resource-row')
  expect(restored).not.toBeNull()
  // React 键控行复用 DOM（不再整表重建），所以断言焦点落在正确的行上，而不是落在 body。
  expect(document.activeElement).toBe(restored)
})

it('binds trust, reject, enable and disable actions to the displayed revision', async () => {
  for (const [label, path, trust] of [
    ['信任', 'mcp/trust', 'trusted'],
    ['拒绝', 'mcp/trust', 'rejected'],
    ['启用', 'mcp/enable', undefined],
    ['停用', 'mcp/disable', undefined],
  ] as const) {
    action(label)
    await settle()
    expect(submitted(path).at(-1)?.body).toMatchObject({
      serverId: 'fixture',
      expectedRevision: revision,
      ...(trust ? { trust } : {}),
    })
  }
  expect(byId('resource-detail').textContent).toContain('已拒绝')
  action('启用', { confirm: false })
  await settle()
  expect(submitted('mcp/enable')).toHaveLength(1)
})

it('preserves a failed operation notice after catalog reload', async () => {
  operationState = 'failed'
  action('重连')
  await vi.waitFor(() => expect(submitted('mcp/list')).toHaveLength(2))
  await settle()
  expect(byId('resource-notice').textContent).toBe('连接已断开，请重连。')
  expect(byId('resource-notice').dataset.kind).toBe('error')
})

it('shows rejected commands and disconnected status safely; Skills remains reachable', async () => {
  refused = true
  action('启用')
  await vi.waitFor(() => expect(byId('resource-notice').textContent).toBe('请先信任当前版本。'))
  expect(submitted('operations/get')).toHaveLength(0)
  action('查看连接状态')
  await vi.waitFor(() =>
    expect(byId('resource-detail').textContent).toContain('MCP_DISCONNECTED：连接已断开。'),
  )
  offline = true
  action('重连')
  await vi.waitFor(() => expect(byId('resource-notice').textContent).toContain('资源管理后台暂时不可用'))
  expect(document.body.textContent).not.toContain('private network detail')
  offline = false
  byId('skills-tab').click()
  await vi.waitFor(() => expect(byId('resource-list').textContent).toContain('Skill'))
  expect(byId<HTMLButtonElement>('skill-refresh').hidden).toBe(false)
  expect(byId<HTMLButtonElement>('mcp-create').hidden).toBe(true)
})

it('keeps successful control-plane notice without claiming every session switched', async () => {
  action('信任')
  await vi.waitFor(() => expect(submitted('mcp/list')).toHaveLength(2))
  await settle()
  expect(byId('resource-notice').dataset.kind).toBe('success')
  expect(byId('resource-notice').textContent).toContain('刷新成功不等于所有会话已经切换')
})

it('surfaces catalog reload failure instead of retaining a success notice', async () => {
  failReload = true
  action('信任')
  await vi.waitFor(() => expect(byId('resource-notice').textContent).toContain('资源管理后台暂时不可用'))
  expect(byId('resource-notice').dataset.kind).toBe('error')
  expect(document.body.textContent).not.toContain('private catalog detail')
})

it('keeps rejected creation visible in the open dialog', async () => {
  refused = true
  byId('mcp-create').click()
  change('mcp-id', 'created')
  change('mcp-name', 'Created MCP')
  change('mcp-executable', 'fixture')
  await submitMcpForm()
  await vi.waitFor(() => expect(byId('mcp-error').textContent).toBe('请先信任当前版本。'))
  expect(byId<HTMLDialogElement>('mcp-dialog').open).toBe(true)
  expect(submitted('operations/get')).toHaveLength(0)
})

it('shows polling failure after successful creation in the visible page notice', async () => {
  failPolling = true
  byId('mcp-create').click()
  change('mcp-id', 'created')
  change('mcp-name', 'Created MCP')
  change('mcp-executable', 'fixture')
  await submitMcpForm()
  await vi.waitFor(() =>
    expect(byId('resource-notice').textContent).toBe('资源管理后台暂时不可用，请稍后重试。'),
  )
  expect(submitted('operations/get')).toHaveLength(1)
  expect(byId<HTMLDialogElement>('mcp-dialog').open).toBe(false)
  expect(byId('resource-notice').dataset.kind).toBe('error')
  expect(document.body.textContent).not.toContain('private polling detail')
})

it('submits SSE transport with bearer token SecretRef from the form', async () => {
  byId('mcp-create').click()
  change('mcp-id', 'created-sse')
  change('mcp-name', 'Created SSE MCP')
  change('mcp-transport', 'sse')
  change('mcp-secret-kind', 'http-bearer')
  expect(byId('mcp-url-row').hidden).toBe(false)
  expect(byId('mcp-executable-row').hidden).toBe(true)
  change('mcp-secret', 'secret://dom/sse-token')
  change('mcp-url', 'http://localhost:3000/mcp')
  await submitMcpForm()
  await vi.waitFor(() => expect(submitted('mcp/create')).toHaveLength(1))
  expect(submitted('mcp/create')[0]?.body.definition).toEqual({
    serverId: 'created-sse',
    displayName: 'Created SSE MCP',
    transport: { kind: 'sse', url: 'http://localhost:3000/mcp' },
    secretBinding: {
      kind: 'http-bearer',
      credentialRef: 'secret://dom/sse-token',
    },
  })
  await settle()
  expect(byId<HTMLDialogElement>('mcp-dialog').open).toBe(false)
})

it('rejects an unrecognized mcp-transport value instead of silently submitting an SSE definition', async () => {
  // resources.html's <select id="mcp-transport"> option set lives in a different package
  // (packages/web/public/resources.html) than definitionFromForm()'s dispatch logic, with nothing
  // guaranteeing they stay in sync. Simulate that drift with an option value neither package offers
  // today, and confirm the form fails loudly instead of silently producing an SSE definition.
  byId('mcp-create').click()
  change('mcp-id', 'created-corrupt')
  change('mcp-name', 'Created Corrupt MCP')
  const transportSelect = byId<HTMLSelectElement>('mcp-transport')
  const bogusOption = document.createElement('option')
  bogusOption.value = 'websocket'
  transportSelect.add(bogusOption)
  change('mcp-transport', 'websocket')
  change('mcp-url', 'https://example.com/mcp')
  byId('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(byId('mcp-error').textContent).not.toBe(''))
  expect(submitted('mcp/create')).toHaveLength(0)
  expect(byId<HTMLDialogElement>('mcp-dialog').open).toBe(true)
})

it('offers permanent skill deletion and validates priority without submitting invalid input', async () => {
  skillsFixture = [
    {
      kind: 'skill',
      resourceId: 'skill/user/user-agnes/example',
      name: 'Example skill',
      revision,
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: revision },
      priority: 400,
      resolution: { winner: true, shadowed: [] },
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
      stale: false,
    },
  ]
  await resourceMount.sync({ tab: 'skills' }, { refresh: true })
  byId('resource-list').querySelector<HTMLElement>('.resource-row')?.click()
  await vi.waitFor(() => expect(byId('resource-detail').textContent).toContain('Example skill'))
  const input = byId('resource-detail').querySelector<HTMLInputElement>('input[type="number"]')
  if (!input) throw new Error('missing priority input')
  expect(input.closest('label')?.textContent).toContain('同名覆盖优先级')
  // React 受控字段跟随事件：原生 setter 写值再派发 input，onChange 才会更新组件状态。
  const setNativeValue = (element: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setNativeValue(input, '501')
  action('保存优先级')
  await settle()
  expect(submitted('skills/priority')).toHaveLength(0)
  setNativeValue(input, '450')
  action('保存优先级')
  await vi.waitFor(() => expect(submitted('skills/priority')).toHaveLength(1))
  expect(submitted('skills/priority')[0]?.body).toMatchObject({ expectedPriority: 400, priority: 450 })
  await settle()
  action('永久删除', { confirm: false })
  await settle()
  expect(submitted('skills/remove')).toHaveLength(0)
  action('永久删除')
  await vi.waitFor(() => expect(submitted('skills/remove')).toHaveLength(1))
  expect(submitted('skills/remove')[0]?.body).toMatchObject({
    resourceId: 'skill/user/user-agnes/example',
    expectedRevision: revision,
  })
})
