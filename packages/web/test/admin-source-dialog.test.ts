/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ADMIN_FEATURES } from '../src/admin/plugins/types.js'

const html = readFileSync(join(process.cwd(), 'packages/web/public/admin.html'), 'utf8').replace(
  /<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g,
  '',
)

type Fetcher = ReturnType<typeof vi.fn<typeof fetch>>

/** A backend that is ready and empty; `inspect` decides what checking a source does. */
function backend(inspect: (body: Record<string, unknown>) => Response): Fetcher {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/context'))
      return Response.json({
        profile: 'local-dev',
        clientId: 'source-dialog-test',
        permissions: ['packages.read', 'packages.install', 'packages.trust', 'packages.activate'],
        readOnly: false,
        authScope: 'auth.source-dialog-test',
        features: Object.values(ADMIN_FEATURES),
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
  document.documentElement.innerHTML = html
    .replace('<link rel="stylesheet" href="/style.css" />', '')
    .replace('<script type="module" src="/admin.js"></script>', '')
  before?.()
  history.replaceState(null, '', '/admin/plugins#source-dialog-token')
  vi.stubGlobal('fetch', fetcher)
  const { mountPluginAdmin } = await import('../src/admin/plugins/admin.js')
  await mountPluginAdmin()
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

function openSourceDialog(): void {
  ;(document.getElementById('install-source') as HTMLButtonElement).click()
}

function submit(type: string, ref: string): void {
  sourceType().value = type
  sourceType().dispatchEvent(new Event('change', { bubbles: true }))
  sourceRef().value = ref
  ;(document.getElementById('source-form') as HTMLFormElement).requestSubmit()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  document.documentElement.replaceChildren()
})

it('keeps the dialog open and says what is wrong when a file source lacks its file: prefix', async () => {
  const fetcher = backend(() => Response.json({ operationId: 'never', profile: 'local-dev' }))
  await mount(fetcher)
  openSourceDialog()
  expect(sourceDialog().open).toBe(true)

  submit('file', './examples/packages/hot-service/v1')

  await vi.waitFor(() => expect(sourceError().textContent).toContain('file:./'))
  // Nothing was sent and nothing closed: the user is still looking at what they typed.
  expect(inspectCalls(fetcher)).toHaveLength(0)
  expect(sourceDialog().open).toBe(true)
})

it('shows an example for the selected source type instead of the npm one', async () => {
  await mount(backend(() => Response.json({})))
  openSourceDialog()
  const placeholder = () => sourceRef().placeholder

  ;(document.getElementById('source-type-trigger') as HTMLButtonElement).click()
  ;(document.getElementById('source-type-listbox-1') as HTMLElement).click()
  expect(sourceType().value).toBe('file')
  expect(placeholder()).toMatch(/^file:\.\//)

  sourceType().value = 'workspace'
  sourceType().dispatchEvent(new Event('change', { bubbles: true }))
  expect(placeholder()).toMatch(/^workspace:extensions\//)

  sourceType().value = 'npm'
  sourceType().dispatchEvent(new Event('change', { bubbles: true }))
  expect(placeholder()).toMatch(/^npm:/)
})

it('sends a well-formed source and closes the dialog once the check has been accepted', async () => {
  const fetcher = backend(() => Response.json({ operationId: 'inspect-1', profile: 'local-dev' }))
  await mount(fetcher)
  openSourceDialog()

  submit('file', 'file:./examples/packages/hot-service/v1')

  await vi.waitFor(() => expect(inspectCalls(fetcher)).toHaveLength(1))
  const sent = JSON.parse(String(inspectCalls(fetcher)[0]?.[1]?.body)) as { source: unknown }
  expect(sent.source).toEqual({ type: 'file', ref: 'file:./examples/packages/hot-service/v1' })
  await vi.waitFor(() => expect(sourceDialog().open).toBe(false))
})

it('keeps the dialog open and shows the backend refusal inside it', async () => {
  const fetcher = backend(() =>
    Response.json({ error: { code: 'E_PACKAGE_SOURCE', message: '来源被后台拒绝。' } }, { status: 400 }),
  )
  await mount(fetcher)
  openSourceDialog()

  submit('file', 'file:./examples/packages/missing')

  await vi.waitFor(() => expect(inspectCalls(fetcher)).toHaveLength(1))
  await vi.waitFor(() => expect(sourceError().textContent).not.toBe(''))
  // The refusal must be visible where the user is looking, not only in a panel behind a closed dialog.
  expect(sourceDialog().open).toBe(true)
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

  openSourceDialog()

  expect(sourceDialog().open).toBe(true)
  expect(settings.open).toBe(true)
})
