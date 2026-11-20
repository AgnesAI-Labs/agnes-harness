// @vitest-environment happy-dom

import { remoteFrontendSessionPath } from '@agnes/protocol'
import { cloudCredentialUsage } from '@agnes/resource-control-web/credentials-api'
import type { SettingsController } from '@agnes/web-admin/settings'
import { mountApplication, unmountApplication } from '@agnes/web-ui'
import { getByRole, queryByRole } from '@testing-library/dom'
import type { Window as HappyWindow } from 'happy-dom'
import { act, useState } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RemoteFrontendFailure } from '../src/backend-selector.js'
import { CloudConnectionSettings } from '../src/backends/cloud-connection-settings.js'
import { cloudFailureText } from '../src/backends/cloud-errors.js'
import { applyCloudFrameAppearance } from '../src/backends/cloud-frame-appearance.js'
import { installCloudFrameAuthorization } from '../src/backends/cloud-frame-authorization.js'
import { bindCloudCredential } from '../src/backends/cloud-key.js'
import {
  type CloudConnectionAction,
  cloudConnectionAction,
  installCloudSettingsProjection,
} from '../src/backends/cloud-settings-bridge.js'
import * as frameContext from '../src/backends/frame-context.js'
import {
  type BackendSnapshot,
  backendCommand,
  backendSnapshot,
  commandBackend,
  localManagementCommand,
} from '../src/backends/frame-contract.js'
import { routeLocalSettings } from '../src/backends/local-management.js'
import { localWorkbenchRoute, skillsWorkspaceId } from '../src/backends/local-route.js'
import { mountBackendWorkbench } from '../src/backends/workbench.js'
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

it('delegates clipboard access only to the configured cloud frame while retaining its sandbox', async () => {
  const previousLocation = location.href
  const settings = (window as unknown as HappyWindow).happyDOM.settings
  const previousIframeLoading = settings.disableIframePageLoading
  settings.disableIframePageLoading = true
  const remote = 'https://clipboard-cloud.test'
  vi.stubGlobal('location', new URL(`http://127.0.0.1:4177/?remote=${encodeURIComponent(remote)}`))
  const meta = document.createElement('meta')
  meta.id = 'agnes-config'
  meta.dataset.cloudOrigin = 'http://127.0.0.1:4178'
  document.head.append(meta)
  const host = document.createElement('div')
  host.id = 'app-root'
  document.body.append(host)
  try {
    await act(async () => mountBackendWorkbench())
    const cloud = host.querySelector<HTMLIFrameElement>('[data-testid="backend-frame-cloud"]')
    const local = host.querySelector<HTMLIFrameElement>('[data-testid="backend-frame-local"]')
    expect(cloud?.getAttribute('allow')).toBe('clipboard-write')
    expect(cloud?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups',
    )
    expect(new URL(cloud?.src ?? '').origin).toBe(meta.dataset.cloudOrigin)
    expect(local?.hasAttribute('allow')).toBe(false)
  } finally {
    await act(async () => unmountApplication(document))
    delete document.body.dataset.aghBackendWorkbench
    meta.remove()
    settings.disableIframePageLoading = previousIframeLoading
    vi.stubGlobal('location', new URL(previousLocation))
  }
})

it('projects browser credential usage only from the local parent and clears it on disconnect or disposal', () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({ parentOrigin: location.origin })
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const off = installCloudSettingsProjection()
  const message = (origin: string, credentialRef?: string) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin,
        data: {
          type: 'agh.backend.frame/v1',
          kind: 'cloud-state',
          state: credentialRef
            ? { status: 'ready', origin: 'https://cloud.test', credentialRef }
            : { status: 'unconfigured' },
        },
      }),
    )
  try {
    message('https://untrusted.test', ref)
    expect(cloudCredentialUsage.read()).toBeUndefined()
    message(location.origin, ref)
    expect(cloudCredentialUsage.read()).toBe(ref)
    message(location.origin, 'invalid-ref')
    expect(cloudCredentialUsage.read()).toBe(ref)
    message(location.origin)
    expect(cloudCredentialUsage.read()).toBeUndefined()
    message(location.origin, ref)
  } finally {
    off()
    frame.mockRestore()
  }
  expect(cloudCredentialUsage.read()).toBeUndefined()
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
    function Fixture() {
      const [selected, setSelected] = useState(active)
      return (
        <BackendSessionGroups
          language="en"
          active={selected}
          cloud="http://cloud.test:8443"
          states={{ local: snapshot, cloud: snapshot }}
          t={(key) => workbenchCatalog.en[key]}
          select={(...args) => {
            selections.push(args)
            if (!args[1]) setSelected(args[0])
          }}
          command={(...args) => commands.push(args)}
          configure={() => {}}
        />
      )
    }
    await act(async () => {
      dispose = mountApplication(host, <Fixture />)
    })
    expect(getByRole(host, 'tabpanel').querySelector('[data-session]')?.getAttribute('aria-current')).toBe(
      'page',
    )
    expect(
      getByRole(host, 'tab', { name: active === 'local' ? 'Local' : /Cloud/ }).getAttribute('aria-selected'),
    ).toBe('true')
    await act(async () => getByRole(host, 'tab', { name: /Cloud/ }).click())
    expect(getByRole(host, 'tabpanel').querySelector('[data-testid="backend-session-local"]')).toBeNull()
    await act(async () =>
      getByRole(host, 'tabpanel').querySelector<HTMLButtonElement>('[data-session]')?.click(),
    )
    expect(selections.at(-1)).toEqual(['cloud', 'same-id'])
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
    await act(async () => getByRole(host, 'tab', { name: 'Local' }).click())
    expect(selections.at(-1)).toEqual(['local'])
    expect(getByRole(host, 'tabpanel').querySelector('[data-testid="backend-session-cloud"]')).toBeNull()
    expect(getByRole(host, 'tabpanel').querySelector('[data-session]')?.getAttribute('aria-current')).toBe(
      'page',
    )
    const collapse = host.querySelector<HTMLButtonElement>('[data-testid="backend-group-local"]')
    await act(async () => collapse?.click())
    expect(collapse?.getAttribute('aria-expanded')).toBe('false')
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
] as const)(
  'shows cloud readiness on its tab even while local is selected (%s, %s)',
  async (cloud, snapshot, expected) => {
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
  },
)

it.each(['en', 'zh-CN'] as const)(
  'retains native local navigation and the unconfigured cloud view in %s',
  async (language) => {
    const host = document.createElement('div')
    document.body.append(host)
    const configure = vi.fn()
    const commands = vi.fn()
    const catalog = workbenchCatalog[language]
    function Fixture() {
      const [active, setActive] = useState<'local' | 'cloud'>('local')
      return (
        <BackendSessionGroups
          active={active}
          states={{}}
          language={language}
          t={(key) => catalog[key]}
          select={(backend) => setActive(backend)}
          command={commands}
          configure={configure}
          localNavigation={<p data-testid="native-local-list">Native projects and temporary conversations</p>}
        />
      )
    }
    await act(async () => {
      dispose = mountApplication(host, <Fixture />)
    })
    expect(getByRole(host, 'tabpanel').querySelector('[data-testid="native-local-list"]')).not.toBeNull()
    await act(async () => getByRole(host, 'tab', { name: new RegExp(catalog.cloudShort) }).click())
    expect(getByRole(host, 'tabpanel').textContent).toContain(catalog.unconfigured)
    expect(queryByRole(host, 'button', { name: catalog.createLocal })).toBeNull()
    await act(async () => getByRole(host, 'button', { name: catalog.createCloud }).click())
    expect(configure).toHaveBeenCalledOnce()
    expect(commands).not.toHaveBeenCalled()
    await act(async () => getByRole(host, 'tab', { name: catalog.localShort }).click())
    expect(getByRole(host, 'tabpanel').querySelector('[data-testid="native-local-list"]')).not.toBeNull()
  },
)

it('connects by credential without exposing sandbox addresses and rejects unsafe legacy origins', async () => {
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
  expect(host.querySelector('#cloud-service-origin')).toBeNull()
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
  expect(find('Other cloud service (manual configuration)')).toBeUndefined()
  expect(host.textContent).not.toContain('http://cloud.test:8443')
  await act(async () => find('Save and connect')?.click())
  await act(async () => find('Reconnect')?.click())
  await act(async () => find('Disconnect cloud')?.click())
  expect(actions).toEqual([
    { action: 'connect', credentialRef },
    { action: 'connect', credentialRef },
    { action: 'reconnect' },
    { action: 'disconnect' },
  ])
  const envelope = { type: 'agh.backend.frame/v1', kind: 'cloud-action', action: 'connect', credentialRef }
  expect(cloudConnectionAction({ ...envelope, origin: 'https://user:secret@cloud.test' })).toBeUndefined()
  expect(cloudConnectionAction({ ...envelope, origin: 'https://cloud.test/path' })).toBeUndefined()
  expect(cloudConnectionAction(envelope)).toEqual(actions[0])
  expect(cloudConnectionAction({ ...envelope, origin: 'http://cloud.test:8443/' })).toEqual({
    action: 'connect',
    origin: 'http://cloud.test:8443',
    credentialRef,
  })
  expect(
    cloudConnectionAction({ ...envelope, origin: 'http://cloud.test', key: 'raw-value' }),
  ).toBeUndefined()
  await act(async () => find('Manage local credentials')?.click())
  expect(actions.at(-1)).toEqual({ action: 'manage-credentials' })
  await act(async () => dispose?.())
  const previousLanguage = document.documentElement.lang
  try {
    document.documentElement.lang = 'zh-CN'
    await act(async () => {
      dispose = mountApplication(
        host,
        <CloudConnectionSettings
          state={{
            status: 'connecting',
            credentialRef,
            credentialOptions: [{ id: credentialRef, label: '测试凭证' }],
          }}
          onAction={(action) => actions.push(action)}
        />,
      )
    })
    expect(host.textContent).toContain('系统自动获取地址并连接')
    expect(host.textContent).not.toContain('其他云端服务（手动配置）')
    expect(host.textContent).not.toContain('云端服务地址')
    expect(host.querySelector('#cloud-service-origin')).toBeNull()
    expect(host.querySelector<HTMLSelectElement>('#cloud-service-credential')?.disabled).toBe(true)
    expect(find('保存并连接')?.disabled).toBe(true)
  } finally {
    document.documentElement.lang = previousLanguage
  }
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
  const cloudDraft = workbenchAddress('cloud', 'http://cloud.test:8443', '')
  expect(cloudDraft).toBe('/?remote=http%3A%2F%2Fcloud.test%3A8443&new=1')
  expect(initialWorkbench(new URL(cloudDraft, 'http://localhost').search)).toMatchObject({
    active: 'cloud',
    session: '',
  })
  expect(workbenchAddress('cloud', 'http://cloud.test:8443')).toBe('/?remote=http%3A%2F%2Fcloud.test%3A8443')
  expect(initialWorkbench('?remote=http%3A%2F%2Fcloud.test%3A8443&session=').session).toBeUndefined()
  expect(
    localWorkbenchRoute(
      '/?remote=http://cloud.test:8443&session=old&new=1&page=plugins&tab=plugins.search&view=%40scope%2Fpkg/review&settings=model/account&account=account-1&prompt=private&workspaceId=w#settings-subsection-auxiliary-models',
    ),
  ).toBe(
    '/?session=old&page=plugins&tab=plugins.search&view=%40scope%2Fpkg/review&settings=model/account&account=account-1#settings-subsection-auxiliary-models',
  )
  expect(localWorkbenchRoute('/?new=1&tab=orphan&view=orphan&account=orphan#other')).toBe('/?new=1')
  const workspaceId = 'a'.repeat(64)
  expect(localWorkbenchRoute(`/?workspaceId=${workspaceId}&new=1&page=rsi`)).toBe(
    `/?new=1&workspaceId=${workspaceId}&page=rsi`,
  )
  expect(localWorkbenchRoute(`/?workspaceId=${workspaceId}&session=old&new=1`)).toBe('/?session=old')
  expect(localWorkbenchRoute(`/?workspaceId=${workspaceId}&settings=skills`)).toBe(
    `/?workspaceId=${workspaceId}&settings=skills`,
  )
  expect(localWorkbenchRoute(`/?workspaceId=${workspaceId}&page=plugins&tab=skills`)).toBe(
    `/?workspaceId=${workspaceId}&page=plugins&tab=skills`,
  )
  const draftSkills = `?new=1&workspaceId=${workspaceId}&page=plugins&tab=skills`
  expect(localWorkbenchRoute(`/${draftSkills}`)).toBe(`/${draftSkills}`)
  expect(skillsWorkspaceId(new URLSearchParams(draftSkills))).toBeUndefined()
  expect(
    skillsWorkspaceId(new URLSearchParams(`session=s&workspaceId=${workspaceId}&page=plugins&tab=skills`)),
  ).toBe(workspaceId)
  expect(localWorkbenchRoute(`/?workspaceId=${workspaceId}&page=plugins&tab=mcp`)).toBe(
    '/?page=plugins&tab=mcp',
  )
  expect(localWorkbenchRoute('/?workspaceId=../workspace&page=plugins&tab=skills')).toBe(
    '/?page=plugins&tab=skills',
  )
  expect(localWorkbenchRoute('/?new=1&workspaceId=../workspace')).toBe('/?new=1')
  expect(localWorkbenchRoute('//example.test/?page=rsi')).toBeUndefined()
  expect(localWorkbenchRoute('/?page=%00rsi&settings=%0am')).toBe('/')
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
  expect(cloudFailureText('CLOUD_SANDBOX_NOT_READY', 'zh-CN')).toContain('沙箱已停机')
  expect(cloudFailureText('CLOUD_RATE_LIMITED', 'en')).toContain('rate limited')
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
