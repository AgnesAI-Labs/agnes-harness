// @vitest-environment happy-dom

import { remoteFrontendSessionPath } from '@agnes/protocol'
import type { SettingsController } from '@agnes/web-admin/settings'
import { mountApplication } from '@agnes/web-ui'
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RemoteFrontendFailure } from '../src/backend-selector.js'
import { CloudConnectionSettings } from '../src/backends/cloud-connection-settings.js'
import { cloudFailureText } from '../src/backends/cloud-errors.js'
import { applyCloudFrameAppearance } from '../src/backends/cloud-frame-appearance.js'
import { installCloudFrameAuthorization } from '../src/backends/cloud-frame-authorization.js'
import { bindCloudCredential } from '../src/backends/cloud-key.js'
import { type CloudConnectionAction, cloudConnectionAction } from '../src/backends/cloud-settings-bridge.js'
import * as frameContext from '../src/backends/frame-context.js'
import {
  type BackendSnapshot,
  backendCommand,
  backendSnapshot,
  commandBackend,
  localManagementCommand,
} from '../src/backends/frame-contract.js'
import { routeLocalSettings } from '../src/backends/local-management.js'
import { BackendSessionGroups } from '../src/backends/workbench-groups.js'
import { workbenchCatalog } from '../src/backends/workbench-locale.js'
import { initialWorkbench, workbenchAddress } from '../src/backends/workbench-state.js'

let dispose: (() => void) | undefined
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterAll(() => vi.unstubAllGlobals())
afterEach(async () => {
  await act(async () => dispose?.())
  document.body.innerHTML = ''
  dispose = undefined
})

it.each(['local', 'cloud'] as const)(
  'keeps session ownership and local management routing while %s is selected',
  async (active) => {
    const host = document.createElement('div')
    document.body.append(host)
    const selections: unknown[] = []
    const commands: unknown[] = []
    const snapshot: BackendSnapshot = {
      ready: true,
      connected: true,
      more: false,
      rows: [{ sessionId: 'same-id', title: 'Fixture task' }],
      activity: [],
      selected: 'same-id',
    }
    await act(async () => {
      dispose = mountApplication(
        host,
        <BackendSessionGroups
          language="en"
          active={active}
          cloud="http://cloud.test:8443"
          states={{ local: snapshot, cloud: snapshot }}
          t={(key) => workbenchCatalog.en[key]}
          select={(...args) => selections.push(args)}
          command={(...args) => commands.push(args)}
          configure={() => {}}
        />,
      )
    })
    const local = host.querySelector<HTMLButtonElement>(
      '[data-testid="backend-session-local"] [data-session]',
    )
    const cloud = host.querySelector<HTMLButtonElement>(
      '[data-testid="backend-session-cloud"] [data-session]',
    )
    expect(local?.getAttribute('aria-current')).toBe(active === 'local' ? 'page' : null)
    expect(cloud?.getAttribute('aria-current')).toBe(active === 'cloud' ? 'page' : null)
    await act(async () => cloud?.click())
    expect(selections).toEqual([['cloud', 'same-id']])
    const collapse = host.querySelector<HTMLButtonElement>('[data-testid="backend-group-local"]')
    await act(async () => collapse?.click())
    expect(collapse?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-testid="backend-session-cloud"] [data-session]')).toBe(cloud)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="New cloud conversation"]')?.click(),
    )
    expect(commands).toEqual([['cloud', { kind: 'new' }]])
    const status = host.querySelector('[data-testid="cloud-connection-status"]')
    expect(status?.getAttribute('aria-label')).toBe('Ready')
    expect(status?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ready')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="backend-group-cloud"]')?.click(),
    )
    expect(status?.closest('[hidden]')).toBeNull()
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === 'Cloud connection'),
    ).toBe(false)
  },
)

it.each([
  [undefined, undefined, 'Not configured'],
  ['http://cloud.test:8443', undefined, 'Connecting'],
  [
    'http://cloud.test:8443',
    { ready: true, connected: false, rows: [], activity: [], more: false },
    'Disconnected',
  ],
  [
    'http://cloud.test:8443',
    { ready: false, connected: false, rows: [], activity: [], more: false, error: 'unavailable' },
    'Connection failed',
  ],
] as const)('shows cloud readiness on its group header (%s, %s)', async (cloud, snapshot, expected) => {
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    dispose = mountApplication(
      host,
      <BackendSessionGroups
        language="en"
        active="local"
        {...(cloud ? { cloud } : {})}
        states={snapshot ? { cloud: { ...snapshot, rows: [], activity: [] } } : {}}
        t={(key) => workbenchCatalog.en[key]}
        select={() => {}}
        command={() => {}}
        configure={() => {}}
      />,
    )
  })
  expect(host.querySelector('[data-testid="cloud-connection-status"]')?.getAttribute('aria-label')).toBe(
    expected,
  )
})

it('keeps cloud connection actions inside settings and rejects unsafe origins', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const actions: CloudConnectionAction[] = []
  const credentialRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
  await act(async () => {
    dispose = mountApplication(
      host,
      <CloudConnectionSettings
        state={{
          status: 'ready',
          origin: 'http://cloud.test:8443',
          credentialRef,
          credentialOptions: [{ id: credentialRef, label: 'Cloud account' }],
        }}
        onAction={(action) => actions.push(action)}
      />,
    )
  })
  const find = (text: string) =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === text)
  expect(host.querySelector('input[type="password"]')).toBeNull()
  expect(host.querySelector<HTMLSelectElement>('#cloud-service-credential')?.value).toBe(credentialRef)
  expect(host.querySelector('#cloud-service-credential')?.textContent).toContain('Cloud account')
  const select = host.querySelector<HTMLSelectElement>('#cloud-service-credential')
  if (!select) throw new Error('missing cloud credential selector')
  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => find('Save and connect')?.click())
  expect(actions).toEqual([])
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Select a local credential.')
  await act(async () => {
    select.value = credentialRef
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => find('Save and connect')?.click())
  await act(async () => find('Reconnect')?.click())
  await act(async () => find('Disconnect cloud')?.click())
  expect(actions).toEqual([
    { action: 'connect', origin: 'http://cloud.test:8443', credentialRef },
    { action: 'reconnect' },
    { action: 'disconnect' },
  ])
  const envelope = { type: 'agh.backend.frame/v1', kind: 'cloud-action', action: 'connect', credentialRef }
  expect(cloudConnectionAction({ ...envelope, origin: 'https://user:secret@cloud.test' })).toBeUndefined()
  expect(cloudConnectionAction({ ...envelope, origin: 'https://cloud.test/path' })).toBeUndefined()
  expect(cloudConnectionAction({ ...envelope, origin: 'http://cloud.test:8443/' })).toEqual(actions[0])
  expect(
    cloudConnectionAction({ ...envelope, origin: 'http://cloud.test', key: 'raw-value' }),
  ).toBeUndefined()
  await act(async () => find('Manage local credentials')?.click())
  expect(actions.at(-1)).toEqual({ action: 'manage-credentials' })
})

it('shows only recovery guidance when a cloud page cannot start, keeping address inputs in settings', async () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({ parentOrigin: location.origin })
  const host = document.createElement('div')
  document.body.append(host)
  try {
    await act(async () => {
      dispose = mountApplication(host, <RemoteFrontendFailure message="unavailable" />)
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The cloud service is unavailable or incompatible. Try reconnecting.',
    )
    expect(host.textContent).toContain('Settings → Advanced → Cloud connection')
    expect(host.querySelector('input')).toBeNull()
  } finally {
    frame.mockRestore()
  }
})

it('restores configured cloud independently from the selected local route and accepts only bounded frame projections', () => {
  expect(initialWorkbench('?session=local-1', 'http://cloud.test:8443')).toMatchObject({
    active: 'local',
    remote: 'http://cloud.test:8443',
    session: 'local-1',
  })
  expect(initialWorkbench('?remote=http%3A%2F%2Fcloud.test%3A8443&session=cloud-1')).toMatchObject({
    active: 'cloud',
    session: 'cloud-1',
  })
  expect(initialWorkbench('', 'not a URL').remote).toBeUndefined()
  expect(workbenchAddress('local', 'http://cloud.test:8443', 'same-id')).toBe('/?session=same-id')
  expect(workbenchAddress('cloud', 'http://cloud.test:8443', 'same-id')).toContain('remote=')
  expect(
    backendCommand({ type: 'agh.backend.command/v1', kind: 'execute', code: 'anything' }),
  ).toBeUndefined()
  expect(backendCommand({ type: 'agh.backend.command/v1', kind: 'session', sessionId: '' })).toBeUndefined()
  const action = {
    type: 'agh.backend.command/v1',
    kind: 'session-action',
    sessionId: 'same-id',
    title: 'Task',
  }
  expect(backendCommand({ ...action, action: 'delete' })).toBeUndefined()
  expect(backendCommand({ ...action, action: 'unarchive' })).toBeUndefined()
  expect(backendCommand({ ...action, action: 'rename' })).toEqual({
    kind: 'session-action',
    sessionId: 'same-id',
    title: 'Task',
    action: 'rename',
  })
  expect(backendCommand({ type: 'agh.backend.command/v1', kind: 'session', sessionId: 'same-id' })).toEqual({
    kind: 'session',
    sessionId: 'same-id',
  })
  expect(
    backendSnapshot({
      type: 'agh.backend.frame/v1',
      kind: 'state',
      snapshot: {
        ready: true,
        connected: true,
        more: false,
        rows: [{ sessionId: 'x', title: 'Task' }],
        activity: [],
      },
    })?.rows,
  ).toHaveLength(1)
  expect(
    backendSnapshot({
      type: 'agh.backend.frame/v1',
      kind: 'state',
      snapshot: {
        ready: true,
        connected: true,
        more: false,
        rows: [{ sessionId: 'x', title: 1 }],
        activity: [],
      },
    }),
  ).toBeUndefined()
})

it('accepts only bounded management relays and keeps conversation/workspace commands on their backend', () => {
  for (const command of [
    { kind: 'home', page: 'plugins' },
    { kind: 'settings', section: 'model' },
  ] as const) {
    expect(commandBackend('cloud', command)).toBe('local')
    expect(
      localManagementCommand({ type: 'agh.backend.frame/v1', kind: 'local-management', command }),
    ).toEqual(command)
  }
  for (const command of [
    { kind: 'new' },
    { kind: 'search' },
    { kind: 'workspace' },
    { kind: 'session', sessionId: 'b' },
  ] as const) {
    expect(commandBackend('cloud', command)).toBe('cloud')
    expect(
      localManagementCommand({ type: 'agh.backend.frame/v1', kind: 'local-management', command }),
    ).toBeUndefined()
  }
  expect(
    localManagementCommand({
      type: 'agh.backend.frame/v1',
      kind: 'local-management',
      command: { kind: 'settings', section: 'x'.repeat(129) },
    }),
  ).toBeUndefined()
})

it('redirects account/dialog links in cloud frames without calling B settings and keeps native pages local', async () => {
  const redirect = vi.spyOn(frameContext, 'requestLocalManagement').mockReturnValue(true)
  const open = vi.fn(async () => {}),
    openAccount = vi.fn(async (_route?: string) => {})
  const settings = routeLocalSettings({ open, openAccount } as unknown as SettingsController)
  try {
    await settings.open()
    await settings.openAccount('b-account')
    expect(open).not.toHaveBeenCalled()
    expect(openAccount).not.toHaveBeenCalled()
    expect(redirect).toHaveBeenCalledWith({ kind: 'settings', section: 'model' })
    redirect.mockReturnValue(false)
    await settings.open()
    await settings.openAccount('local-account')
    expect(open).toHaveBeenCalledOnce()
    expect(openAccount).toHaveBeenCalledWith('local-account')
  } finally {
    redirect.mockRestore()
  }
})

it('authorizes only the configured cloud from its exact frame, ignoring sender-selected destinations and credentials', async () => {
  const previousLocation = location.href
  vi.stubGlobal('location', new URL('http://127.0.0.1:4177/'))
  const meta = document.createElement('meta')
  meta.id = 'agnes-config'
  meta.dataset.cloudOrigin = 'http://127.0.0.1:4178'
  document.head.append(meta)
  const remote = 'https://configured-cloud.test'
  const credentialRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
  bindCloudCredential(remote, credentialRef, [{ id: credentialRef }])
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const token = `${(Date.now() + 60_000).toString(36)}.${'a'.repeat(22)}.${'b'.repeat(43)}`
  const fetcher = vi
    .spyOn(window, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ token, expiresAt: Date.now() + 60_000 })))
  const frameWindow = frame.contentWindow
  if (!frameWindow) throw Error('missing fixture frame window')
  const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {})
  const stop = installCloudFrameAuthorization(() => ({ remote, frame }))
  const data = {
    type: 'agh.backend.frame/v1',
    kind: 'authorization-request',
    requestId: crypto.randomUUID(),
    origin: 'https://attacker.test',
    credentialRef: 'forged',
  }
  const send = (origin: string, source: Window) =>
    window.dispatchEvent(new MessageEvent('message', { origin, source, data }))
  try {
    send(location.origin, frameWindow)
    send('http://127.0.0.1:4178', window)
    expect(fetcher).not.toHaveBeenCalled()
    send('http://127.0.0.1:4178', frameWindow)
    await vi.waitFor(() => expect(post).toHaveBeenCalled())
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ origin: remote, credentialRef })
    const reply = post.mock.calls.at(-1)?.[0]
    expect(reply).toMatchObject({ kind: 'authorization', remote, path: remoteFrontendSessionPath(token) })
    expect(JSON.stringify(reply)).not.toContain(credentialRef)
  } finally {
    stop()
    meta.remove()
    fetcher.mockRestore()
    post.mockRestore()
    localStorage.clear()
    vi.stubGlobal('location', new URL(previousLocation))
  }
})

it('localizes cloud refusal codes without exposing backend details or obsolete manual-key guidance', () => {
  expect(cloudFailureText('CLOUD_CREDENTIAL_REQUIRED', 'en')).toContain('Select a local credential')
  expect(cloudFailureText('CLOUD_CREDENTIAL_REQUIRED', 'zh-CN')).toContain('选择本地凭证')
  expect(cloudFailureText('CLOUD_CREDENTIAL_REJECTED', 'en')).not.toMatch(/[\u4e00-\u9fff]/u)
  expect(cloudFailureText('sensitive transport detail', 'en')).not.toContain('sensitive')
  const root = document.documentElement
  const previous = {
    lang: root.lang,
    dark: root.classList.contains('dark'),
    style: root.getAttribute('style'),
  }
  const unavailable = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage disabled')
  })
  try {
    expect(() =>
      applyCloudFrameAppearance({ locale: 'zh-CN', theme: 'dark', fontScale: 'large' }),
    ).not.toThrow()
    expect(root.lang).toBe('zh-CN')
    expect(root.classList.contains('dark')).toBe(true)
  } finally {
    unavailable.mockRestore()
    root.lang = previous.lang
    root.classList.toggle('dark', previous.dark)
    if (previous.style) root.setAttribute('style', previous.style)
    else root.removeAttribute('style')
  }
})
