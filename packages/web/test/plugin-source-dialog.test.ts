/** @vitest-environment happy-dom */

import { ADMIN_FEATURES } from '@agnes/web-admin/admin/plugins/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let host: Awaited<ReturnType<typeof import('./web-dom-fixture.js').mountRenderedIndex>> | undefined
/** The plugin pane and dialogs as the workbench renders them, with the plugin pane on screen. */
async function renderPluginHost(): Promise<void> {
  await host?.dispose()
  const { mountRenderedIndex } = await import('./web-dom-fixture.js')
  // The workbench rail lists the sections the plugin admin registers, as it does in the product.
  const { settingsSections } = await import('@agnes/web-client')
  host = await mountRenderedIndex({ settings: { sections: settingsSections } })
  ;(await import('./legacy-admin-panes.js')).installAdminPaneHosts('plugin')
}
// Compile the shared DOM fixture during setup; assertions keep their existing deadlines.
beforeEach(async () => {
  vi.resetModules()
  await import('./web-dom-fixture.js')
}, 180_000)

type Fetcher = ReturnType<typeof vi.fn<typeof fetch>>
let dispose: (() => void) | undefined

/** A backend that is ready and empty; `inspect` decides what checking a source does. */
function backend(inspect: (body: Record<string, unknown>) => Response): Fetcher {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/overview'))
      return Response.json({
        context: {
          profile: 'local-dev',
          clientId: 'source-dialog-test',
          permissions: ['packages.read', 'packages.install', 'packages.trust', 'packages.activate'],
          readOnly: false,
          authScope: 'auth.source-dialog-test',
          features: Object.values(ADMIN_FEATURES),
        },
        inventory: { packages: [] },
      })
    if (url.endsWith('/catalog/list')) return Response.json({ items: [], nextCursor: null })
    if (url.endsWith('/list')) return Response.json({ packages: [] })
    if (url.endsWith('/tree/list')) return Response.json({ desiredDigest: 'sha256-x', actual: true })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    if (url.endsWith('/inspect')) return inspect(body)
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
}

async function mount(fetcher: Fetcher, before?: () => void): Promise<void> {
  await renderPluginHost()
  before?.()
  history.replaceState(null, '', '/admin/plugins#source-dialog-token')
  vi.stubGlobal('fetch', fetcher)
  const { mountPluginAdmin } = await import('@agnes/web-admin/admin/plugins/admin')
  const mounted = mountPluginAdmin()
  dispose = mounted.dispose
  await mounted.ready
  // The install button is inert until the admin context has loaded.
  await vi.waitFor(() => expect(document.querySelector('#install-source')).not.toBeNull())
  await vi.waitFor(() =>
    expect((document.querySelector('#plugin-list') as HTMLElement).textContent).not.toContain('正在'),
  )
}

const sourceDialog = () => document.getElementById('source-dialog') as HTMLDialogElement
const sourceType = () => document.getElementById('source-type') as HTMLSelectElement
const sourceRef = () => document.getElementById('source-ref') as HTMLInputElement
const sourceError = () => document.getElementById('source-error') as HTMLElement
const inspectCalls = (fetcher: Fetcher) =>
  fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/inspect'))

async function openSourceDialog(): Promise<void> {
  ;(document.getElementById('install-source') as HTMLButtonElement).click()
  await vi.waitFor(() => expect(document.querySelector('[data-testid=plugin-install-source]')).not.toBeNull())
  ;(document.querySelector('[data-testid=plugin-install-source]') as HTMLButtonElement).click()
}

/** React 的 value tracker 会忽略「直接赋值」的字段变更：必须用原型原生 setter 写值再派发事件。 */
function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  )
}

function submit(type: string, ref: string): void {
  setNativeValue(sourceType(), type)
  setNativeValue(sourceRef(), ref)
  // happy-dom 的 requestSubmit 触达不了 React 的委托 submit；提交走显式按钮回调。
  const button = document.querySelector<HTMLButtonElement>(
    '#source-form .dialog-actions button:not(#source-cancel)',
  )
  if (!button) throw new Error('Missing source check action')
  button.click()
}

afterEach(async () => {
  dispose?.()
  dispose = undefined
  await host?.dispose()
  host = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  document.documentElement.replaceChildren()
})

it('keeps the dialog open and says what is wrong when a workspace source lacks its prefix', async () => {
  const fetcher = backend(() => Response.json({ operationId: 'never', profile: 'local-dev' }))
  await mount(fetcher)
  await openSourceDialog()
  expect(sourceDialog().open).toBe(true)

  submit('workspace', 'extensions/my-extension')

  await vi.waitFor(() => expect(sourceError().textContent).toContain('workspace:extensions/'))
  // Nothing was sent and nothing closed: the user is still looking at what they typed.
  expect(inspectCalls(fetcher)).toHaveLength(0)
  expect(sourceDialog().open).toBe(true)
}, 60_000)

it('shows an example for the selected source type instead of the npm one', async () => {
  await mount(backend(() => Response.json({})))
  await openSourceDialog()
  const placeholder = () => sourceRef().placeholder

  // 组件层用原生 select（旧 select-picker 的触发器/listbox DOM 已随迁移移除）。
  setNativeValue(sourceType(), 'file')
  expect(sourceType().value).toBe('file')
  await vi.waitFor(() => expect(placeholder()).toBe('/path/to/my-plugin.tgz'))

  setNativeValue(sourceType(), 'workspace')
  await vi.waitFor(() => expect(placeholder()).toMatch(/^workspace:extensions\//))

  setNativeValue(sourceType(), 'npm')
  await vi.waitFor(() => expect(placeholder()).toMatch(/^npm:/))
})

it('sends a well-formed source and closes the dialog once the check has been accepted', async () => {
  const fetcher = backend(() => Response.json({ operationId: 'inspect-1', profile: 'local-dev' }))
  await mount(fetcher)
  await openSourceDialog()

  submit('file', '/path/to/my-plugin.tgz')

  await vi.waitFor(() => expect(inspectCalls(fetcher)).toHaveLength(1))
  const sent = JSON.parse(String(inspectCalls(fetcher)[0]?.[1]?.body)) as { source: unknown }
  expect(sent.source).toEqual({ type: 'file', ref: 'file:/path/to/my-plugin.tgz' })
  await vi.waitFor(() => expect(sourceDialog().open).toBe(false))
})

it('keeps the dialog open and shows the backend refusal inside it', async () => {
  const fetcher = backend(() =>
    Response.json({ error: { code: 'E_PACKAGE_SOURCE', message: '来源被后台拒绝。' } }, { status: 400 }),
  )
  await mount(fetcher)
  await openSourceDialog()

  submit('file', 'file:./examples/packages/missing')

  await vi.waitFor(() => expect(inspectCalls(fetcher)).toHaveLength(1))
  await vi.waitFor(() => expect(sourceError().textContent).not.toBe(''))
  // The refusal must be visible where the user is looking, not only in a panel behind a closed dialog.
  expect(sourceDialog().open).toBe(true)
})

it('retranslates a source-check failure when the locale changes while the dialog stays open', async () => {
  const fetcher = backend(() =>
    Response.json(
      { error: { code: 'ADMIN_UNAVAILABLE', message: '插件管理后台暂时不可用。' } },
      { status: 503 },
    ),
  )
  await mount(fetcher)
  await openSourceDialog()

  submit('file', 'file:./examples/packages/missing')

  await vi.waitFor(() => expect(sourceError().textContent).toContain('Could not connect'))
  document.documentElement.lang = 'zh-CN'
  window.dispatchEvent(new Event('agnes:locale-changed'))

  expect(sourceDialog().open).toBe(true)
  expect(sourceError().textContent).toBe('无法连接插件管理后台。已保留当前页面内容。')
})

it('does not close the settings dialog it was opened from', async () => {
  await mount(
    backend(() => Response.json({})),
    () => {
      const settings = document.createElement('dialog')
      settings.id = 'config'
      document.body.append(settings)
    },
  )
  const settings = document.getElementById('config') as HTMLDialogElement
  settings.showModal()
  expect(settings.open).toBe(true)

  await openSourceDialog()

  expect(sourceDialog().open).toBe(true)
  expect(settings.open).toBe(true)
})

it('leaves the next page source dialog intact when a disposed source check settles', async () => {
  let accept!: (value: Response) => void
  const pending = new Promise<Response>((resolve) => {
    accept = resolve
  })
  const base = backend(() => Response.json({}))
  const fetcher = vi.fn<typeof fetch>((input, init) =>
    String(input).endsWith('/api/inspect') ? pending : base(input, init),
  )
  await mount(fetcher)
  await openSourceDialog()
  submit('file', '/synthetic/plugin.tgz')
  await vi.waitFor(() => expect(inspectCalls(fetcher)).toHaveLength(1))
  dispose?.()
  const { mountPluginAdmin } = await import('@agnes/web-admin/admin/plugins/admin')
  const next = mountPluginAdmin()
  dispose = next.dispose
  await next.ready
  await openSourceDialog()
  accept(Response.json({ operationId: 'late-inspect', profile: 'local-dev' }))
  await pending
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(sourceDialog().open).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/operation/get'))).toBe(false)
})
