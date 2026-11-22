// @vitest-environment happy-dom

import { Context } from '@agnes/cordis'
import { CLOUD_AUTHORIZATION_PATH, remoteFrontendSessionPath } from '@agnes/protocol'
import { CREDENTIALS_CHANGED, cloudCredentialUsage } from '@agnes/resource-control-web/credentials-api'
import type { Client } from '@agnes/sdk/browser'
import type { SettingsController } from '@agnes/web-admin/settings'
import { SlotRegistry, settingsSections } from '@agnes/web-client'
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
import { watchCloudOrigin } from '../src/backends/cloud-recovery.js'
import {
  type CloudConnectionAction,
  cloudConnectionAction,
  installCloudSettingsProjection,
} from '../src/backends/cloud-settings-bridge.js'
import { installBackendFrameBridge } from '../src/backends/frame-bridge.js'
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
import type { SettingsRegionMount } from '../src/regions/settings.js'

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

it('relays only confirmed replacement of the selected local cloud credential and removes its listener', () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({ parentOrigin: location.origin })
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const off = installCloudSettingsProjection()
  const changed = (id: string, mode = 'replace') =>
    window.dispatchEvent(new CustomEvent(CREDENTIALS_CHANGED, { detail: { id, mode } }))
  try {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: location.origin,
        data: {
          type: 'agh.backend.frame/v1',
          kind: 'cloud-state',
          state: { status: 'ready', origin: 'https://cloud.test', credentialRef: ref },
        },
      }),
    )
    window.dispatchEvent(new Event(CREDENTIALS_CHANGED))
    changed(ref, 'create')
    changed(ref, 'rename')
    changed(ref, 'delete')
    changed('secret://generic/22222222-2222-2222-2222-222222222222')
    expect(post).not.toHaveBeenCalled()
    changed(ref)
    expect(post.mock.calls).toEqual([
      [
        {
          type: 'agh.backend.frame/v1',
          kind: 'cloud-action',
          action: 'credential-replaced',
          credentialRef: ref,
          generation: expect.any(String),
        },
        location.origin,
      ],
    ])
    off()
    changed(ref)
    expect(post).toHaveBeenCalledOnce()
    frame.mockReturnValue({ parentOrigin: location.origin, remote: 'https://cloud.test' })
    const remoteOff = installCloudSettingsProjection()
    changed(ref)
    remoteOff()
    expect(post).toHaveBeenCalledOnce()
  } finally {
    off()
    frame.mockRestore()
    post.mockRestore()
  }
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

// Exercise only these new backend-target/recovery paths; release-wide routing regression runs before PR.
async function diagnosticWorkbench(active: 'local' | 'cloud') {
  const previousLocation = location.href
  const settings = (window as unknown as HappyWindow).happyDOM.settings
  const previousLoading = settings.disableIframePageLoading
  settings.disableIframePageLoading = true
  const remote = 'https://8443-old.ap-shanghai.tencentags.com'
  vi.stubGlobal(
    'location',
    new URL(
      `http://127.0.0.1:4177/${active === 'cloud' ? `?remote=${encodeURIComponent(remote)}&session=kept-session` : ''}`,
    ),
  )
  localStorage.setItem('agnes.cloud.origin.v1', remote)
  const meta = document.createElement('meta')
  meta.id = 'agnes-config'
  meta.dataset.cloudOrigin = 'http://127.0.0.1:4178'
  document.head.append(meta)
  const host = document.body.appendChild(document.createElement('div'))
  host.id = 'app-root'
  await act(async () => mountBackendWorkbench())
  const frame = (id: 'local' | 'cloud') => {
    const node = host.querySelector<HTMLIFrameElement>(`[data-testid="backend-frame-${id}"]`)
    if (!node) throw new Error('fixture backend frame missing')
    // Happy-DOM disables the child loader; supply only the message port owned by this fixture.
    if (!node.contentWindow) Object.defineProperty(node, 'contentWindow', { value: { postMessage: vi.fn() } })
    return node
  }
  const message = async (id: 'local' | 'cloud', data: object) => {
    const source = frame(id)
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: source.contentWindow,
          origin: new URL(source.src, location.origin).origin,
          data: { type: 'agh.backend.frame/v1', ...data },
        }),
      ),
    )
  }
  return {
    remote,
    frame,
    message,
    async close() {
      await act(async () => unmountApplication(document))
      delete document.body.dataset.aghBackendWorkbench
      host.remove()
      meta.remove()
      settings.disableIframePageLoading = previousLoading
      localStorage.clear()
      vi.stubGlobal('location', new URL(previousLocation))
    },
  }
}

it.each([
  '/?settings=model/account&account=saved#settings-subsection-auxiliary-models',
  '/?page=plugins&tab=plugins.search&view=%40scope%2Fpkg/review',
])('restores the local subpage after reloading the cloud workbench: %s', async (route) => {
  let saved: unknown = { unrelated: 'retained' }
  const state = vi.spyOn(history, 'state', 'get').mockImplementation(() => saved)
  const replace = vi.spyOn(history, 'replaceState').mockImplementation((value) => {
    saved = value
  })
  const push = vi.spyOn(history, 'pushState').mockImplementation((value) => {
    saved = value
  })
  let fixture: Awaited<ReturnType<typeof diagnosticWorkbench>> | undefined
  try {
    fixture = await diagnosticWorkbench('local')
    await fixture.message('local', { kind: 'local-route', route, operation: 'push' })
    await fixture.message('local', { kind: 'sidebar-select', backend: 'cloud' })
    await fixture.close()
    fixture = undefined
    fixture = await diagnosticWorkbench('cloud')
    const local = new URL(fixture.frame('local').src, location.origin)
    expect(`${local.pathname}${local.search}${local.hash}`).toBe(route)
    await fixture.message('local', { kind: 'sidebar-select', backend: 'local' })
    expect(push.mock.calls.at(-1)?.[2]).toBe(route)
    expect(saved).toMatchObject({ unrelated: 'retained' })
  } finally {
    await fixture?.close()
    state.mockRestore()
    replace.mockRestore()
    push.mockRestore()
  }
})

it.each(['managed', 'direct', 'local-selected'] as const)(
  'renews the same-ref cloud frame after %s credential replacement without replaying business requests',
  async (mode) => {
    const fixture = await diagnosticWorkbench('cloud')
    const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
    bindCloudCredential(fixture.remote, ref, [{ id: ref }])
    if (mode !== 'direct') localStorage.setItem('agnes.cloud.auto-credential.v1', ref)
    const oldToken = `${(Date.now() + 3600000).toString(36)}.${'a'.repeat(22)}.${'b'.repeat(43)}`
    const replacementToken = `${(Date.now() + 3600000).toString(36)}.${'c'.repeat(22)}.${'d'.repeat(43)}`
    let activeToken = oldToken
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/admin/api/credentials'))
        return Response.json({
          items: [
            { id: ref, label: 'fixture', kind: 'api-key', createdAt: '2026-11-20T00:00:00Z', references: [] },
          ],
        })
      if (new URL(String(input)).pathname !== CLOUD_AUTHORIZATION_PATH) throw Error('unexpected request')
      return Response.json({
        token: activeToken,
        expiresAt: Date.now() + 3600000,
        proxied: true,
        origin: fixture.remote,
      })
    })
    const action = { kind: 'cloud-action', action: 'credential-replaced', credentialRef: ref }
    try {
      await fixture.message('cloud', {
        kind: 'state',
        snapshot: {
          ready: true,
          connected: true,
          more: false,
          rows: [],
          activity: [],
          selected: 'kept-session',
        },
      })
      if (mode === 'local-selected')
        await fixture.message('local', { kind: 'sidebar-select', backend: 'local' })
      const previous = fixture.frame('cloud')
      const previousPost = vi.spyOn(previous.contentWindow!, 'postMessage').mockImplementation(() => {})
      await fixture.message('cloud', { kind: 'authorization-request', requestId: crypto.randomUUID() })
      expect(previousPost.mock.calls.find(([value]) => value.kind === 'authorization')?.[0]).toMatchObject({
        remote: fixture.remote,
        path: remoteFrontendSessionPath(oldToken),
      })
      previousPost.mockRestore()
      fetcher.mockClear()
      activeToken = replacementToken
      await fixture.message('cloud', action)
      await fixture.message('local', {
        ...action,
        credentialRef: 'secret://generic/22222222-2222-2222-2222-222222222222',
      })
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: fixture.frame('local').contentWindow,
            origin: 'https://untrusted.test',
            data: { type: 'agh.backend.frame/v1', ...action },
          }),
        ),
      )
      expect(fetcher).not.toHaveBeenCalled()
      expect(fixture.frame('cloud')).toBe(previous)
      await fixture.message('local', action)
      const next = fixture.frame('cloud')
      expect(next).not.toBe(previous)
      expect(next.dataset.backendOrigin).toBe(fixture.remote)
      expect(new URL(next.src).searchParams.get('session')).toBe('kept-session')
      expect(next.hidden).toBe(mode === 'local-selected')
      const post = vi.spyOn(next.contentWindow!, 'postMessage').mockImplementation(() => {})
      await fixture.message('cloud', { kind: 'authorization-request', requestId: crypto.randomUUID() })
      expect(post.mock.calls.find(([value]) => value.kind === 'authorization')?.[0]).toMatchObject({
        remote: fixture.remote,
        path: remoteFrontendSessionPath(replacementToken),
      })
      post.mockRestore()
      expect(
        fetcher.mock.calls.every(
          ([input, init]) =>
            init?.method !== 'POST' || new URL(String(input)).pathname === CLOUD_AUTHORIZATION_PATH,
        ),
      ).toBe(true)
      fetcher.mockImplementationOnce(async () => Response.json({ items: [] }))
      await fixture.message('local', action)
      expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
      await fixture.message('local', { kind: 'cloud-action', action: 'disconnect' })
      fetcher.mockClear()
      await fixture.message('local', action)
      expect(fetcher).not.toHaveBeenCalled()
      expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    } finally {
      fetcher.mockRestore()
      await fixture.close()
    }
  },
)

it('does not let a late credential replacement cancel a different pending cloud connection', async () => {
  const fixture = await diagnosticWorkbench('cloud')
  const oldRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const nextRef = 'secret://generic/22222222-2222-2222-2222-222222222222'
  bindCloudCredential(fixture.remote, oldRef, [{ id: oldRef }])
  let complete!: (value: Response) => void
  let signal: AbortSignal | null | undefined
  const reply = new Promise<Response>((resolve) => {
    complete = resolve
  })
  const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async (_input, init) => {
    signal = init?.signal
    return reply
  })
  try {
    expect(fixture.frame('cloud')).toBeTruthy()
    await fixture.message('local', { kind: 'cloud-action', action: 'connect', credentialRef: nextRef })
    expect(fetcher).toHaveBeenCalledOnce()
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: oldRef,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    await fixture.message('local', { kind: 'cloud-action', action: 'disconnect' })
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      complete(
        Response.json({
          items: [
            {
              id: nextRef,
              label: 'next',
              kind: 'api-key',
              createdAt: '2026-11-20T00:00:00Z',
              references: [],
            },
          ],
        }),
      ),
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
  } finally {
    fetcher.mockRestore()
    await fixture.close()
  }
})

it('renews the current cloud credential after a different connection attempt has failed', async () => {
  const fixture = await diagnosticWorkbench('cloud')
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const rejected = 'secret://generic/22222222-2222-2222-2222-222222222222'
  bindCloudCredential(fixture.remote, ref, [{ id: ref }])
  const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async () =>
    Response.json({
      items: [
        {
          id: ref,
          label: 'current',
          kind: 'api-key',
          createdAt: '2026-11-20T00:00:00Z',
          references: [],
        },
      ],
    }),
  )
  try {
    await fixture.message('local', { kind: 'cloud-action', action: 'connect', credentialRef: rejected })
    expect(fetcher).toHaveBeenCalledOnce()
    const previous = fixture.frame('cloud')
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fixture.frame('cloud')).not.toBe(previous)
    expect(new URL(fixture.frame('cloud').src).searchParams.get('session')).toBe('kept-session')

    // Rotating the active credential while a different candidate attempt is still pending recovers the active frame if that candidate fails.
    let resolvePendingSwitch: ((response: Response) => void) | undefined
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePendingSwitch = resolve
        }),
    )
    const beforeMidAttempt = fixture.frame('cloud')
    await fixture.message('local', { kind: 'cloud-action', action: 'connect', credentialRef: rejected })
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    await act(async () =>
      resolvePendingSwitch?.(
        Response.json({
          items: [
            {
              id: ref,
              label: 'current',
              kind: 'api-key',
              createdAt: '2026-11-20T00:00:00Z',
              references: [],
            },
          ],
        }),
      ),
    )
    const recoveredFrame = fixture.frame('cloud')
    expect(recoveredFrame).not.toBe(beforeMidAttempt)
    expect(recoveredFrame.dataset.backendOrigin).toBe(fixture.remote)
    const localPost = vi
      .spyOn(fixture.frame('local').contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await fixture.message('cloud', {
      kind: 'state',
      snapshot: {
        ready: true,
        connected: true,
        more: false,
        rows: [],
        activity: [],
        selected: 'kept-session',
      },
    })
    expect(localPost.mock.calls.findLast(([msg]) => msg?.kind === 'cloud-state')?.[0].state).toMatchObject({
      status: 'ready',
      error: 'CLOUD_CREDENTIAL_NOT_FOUND',
    })
    localPost.mockRestore()

    // Peer rotation via StorageEvent retires and renews an observing tab's Cloud frame without a local child message, and deduplicates a racing local-frame message for the same generation.
    fetcher.mockClear()
    await act(async () => {
      localStorage.setItem(`agnes.cloud.credential-gen.v1:${ref}`, 'peer-rotation-gen')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `agnes.cloud.credential-gen.v1:${ref}`,
          newValue: 'peer-rotation-gen',
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const afterPeerFrame = fixture.frame('cloud')
    expect(afterPeerFrame).not.toBe(recoveredFrame)
    expect(fetcher).toHaveBeenCalledOnce()
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
      generation: 'peer-rotation-gen',
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fixture.frame('cloud')).toBe(afterPeerFrame)

    // Peer disconnecting while a peer-rotation refresh is waiting on the credential list does not recreate the binding or shared origin.
    let resolveDisconnectRaceList: ((response: Response) => void) | undefined
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveDisconnectRaceList = resolve
        }),
    )
    await act(async () => {
      localStorage.setItem(`agnes.cloud.credential-gen.v1:${ref}`, 'peer-rotation-race')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `agnes.cloud.credential-gen.v1:${ref}`,
          newValue: 'peer-rotation-race',
        }),
      )
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    localStorage.removeItem(`agnes.cloud.credential.v1:${fixture.remote}`)
    localStorage.removeItem('agnes.cloud.origin.v1')
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'agnes.cloud.origin.v1',
          oldValue: fixture.remote,
          newValue: null,
        }),
      )
    })
    await act(async () =>
      resolveDisconnectRaceList?.(
        Response.json({
          items: [
            {
              id: ref,
              label: 'current',
              kind: 'api-key',
              createdAt: '2026-11-20T00:00:00Z',
              references: [],
            },
          ],
        }),
      ),
    )
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBeNull()
    expect(localStorage.getItem(`agnes.cloud.credential.v1:${fixture.remote}`)).toBeNull()
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
  } finally {
    fetcher.mockRestore()
    await fixture.close()
  }
})

it.each(['local', 'cloud'] as const)(
  'keeps the diagnostic backend %s and never falls back to A when B is offline',
  async (backend) => {
    const fixture = await diagnosticWorkbench(backend)
    const local = fixture.frame('local'),
      cloud = fixture.frame('cloud')
    const localPost = vi.spyOn(local.contentWindow!, 'postMessage')
    const cloudPost = vi.spyOn(cloud.contentWindow!, 'postMessage')
    const snapshot = {
      ready: true,
      connected: true,
      more: false,
      rows: [],
      activity: [],
      selected: 'kept-session',
    }
    try {
      await fixture.message('local', { kind: 'state', snapshot })
      await fixture.message('cloud', { kind: 'state', snapshot })
      // Settings is administered on A, but diagnostics still belong to the selected execution host.
      await fixture.message('local', {
        kind: 'sidebar-command',
        backend,
        command: { type: 'agh.backend.command/v1', kind: 'settings', section: 'model' },
      })
      const pending = localPost.mock.calls
        .map(([value]) => value)
        .findLast((value) => value.kind === 'settings')
      if (pending) await fixture.message('local', { kind: 'ack', commandId: pending.commandId })
      localPost.mockClear()
      cloudPost.mockClear()
      await fixture.message('local', {
        kind: 'local-route',
        route: '/?settings=diagnostics/errors',
        operation: 'push',
      })
      if (backend === 'cloud') {
        expect(
          cloudPost.mock.calls.some(
            ([value]) => value.kind === 'settings' && value.section === 'diagnostics/errors',
          ),
        ).toBe(true)
        expect(
          localPost.mock.calls.some(
            ([value]) => value.kind === 'settings' && value.section.startsWith('diagnostics'),
          ),
        ).toBe(false)
        await fixture.message('cloud', {
          kind: 'state',
          snapshot: { ...snapshot, connected: false, ready: false },
        })
        localPost.mockClear()
        await fixture.message('local', {
          kind: 'local-management',
          command: { type: 'agh.backend.command/v1', kind: 'settings', section: 'diagnostics' },
        })
        expect(fixture.frame('cloud').hidden).toBe(false)
        expect(
          localPost.mock.calls.some(
            ([value]) => value.kind === 'settings' && value.section === 'diagnostics',
          ),
        ).toBe(false)
        // A late B snapshot must not reclaim the user's newly selected local target.
        await fixture.message('local', { kind: 'sidebar-select', backend: 'local' })
        await fixture.message('cloud', { kind: 'state', snapshot })
        expect(fixture.frame('cloud').hidden).toBe(true)
        localPost.mockClear()
        cloudPost.mockClear()
        await fixture.message('local', {
          kind: 'local-management',
          command: { kind: 'settings', section: 'diagnostics' },
        })
        expect(
          localPost.mock.calls.some(
            ([value]) => value.kind === 'settings' && value.section === 'diagnostics',
          ),
        ).toBe(true)
        expect(cloudPost.mock.calls.some(([value]) => value.kind === 'settings')).toBe(false)
      } else expect(cloudPost.mock.calls.some(([value]) => value.kind === 'settings')).toBe(false)
      expect(commandBackend(backend, { kind: 'settings', section: 'diagnostics' })).toBe(backend)
      expect(commandBackend(backend, { kind: 'settings', section: 'model' })).toBe('local')
    } finally {
      localPost.mockRestore()
      cloudPost.mockRestore()
      await fixture.close()
    }
  },
)

it.each(['cloud', 'local', 'transient-rejected'] as const)(
  'uses cloud instance recovery while %s is selected without replaying a business command',
  async (active) => {
    const fixture = await diagnosticWorkbench('cloud')
    vi.useFakeTimers()
    const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
    const next = 'https://8443-new.ap-shanghai.tencentags.com'
    bindCloudCredential(fixture.remote, ref, [{ id: ref }])
    localStorage.setItem('agnes.cloud.auto-credential.v1', ref)
    let attempts = 0
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/admin/api/credentials'))
        return Response.json({
          items: [
            { id: ref, label: 'fixture', kind: 'api-key', createdAt: '2026-11-20T00:00:00Z', references: [] },
          ],
        })
      if (new URL(String(input)).pathname !== CLOUD_AUTHORIZATION_PATH)
        throw new Error('unexpected fixture request')
      attempts++
      if (active === 'transient-rejected' && attempts <= 2)
        return Response.json({ error: 'CONFIG_CREDENTIAL_REJECTED' }, { status: 401 })
      return Response.json({
        token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
        expiresAt: Date.now() + 3600000,
        proxied: true,
        origin: next,
      })
    })
    try {
      await fixture.message('cloud', {
        kind: 'state',
        snapshot: {
          ready: true,
          connected: true,
          more: false,
          rows: [],
          activity: [],
          selected: 'kept-session',
        },
      })
      await fixture.message('cloud', {
        kind: 'state',
        snapshot: {
          ready: true,
          connected: false,
          more: false,
          rows: [],
          activity: [],
          selected: 'kept-session',
        },
      })
      if (active === 'local') await fixture.message('local', { kind: 'sidebar-select', backend: 'local' })
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(fixture.frame('cloud').hidden).toBe(active === 'local')
      expect(fixture.frame('cloud').dataset.backendOrigin).toBe(next)
      expect(new URL(fixture.frame('cloud').src).searchParams.get('session')).toBe('kept-session')
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(writes.every(([url]) => new URL(String(url)).pathname === CLOUD_AUTHORIZATION_PATH)).toBe(true)
      expect(writes.length).toBeGreaterThan(0)
      expect(localStorage.getItem('agnes.cloud.auto-credential.v1')).toBe(ref)
    } finally {
      fetcher.mockRestore()
      await fixture.close()
      vi.useRealTimers()
    }
  },
)

it.each(['changed', 'unchanged', 'denied', 'missing', 'invalid', 'timeout'] as const)(
  'bounds cloud instance recovery and cleans up its %s attempts',
  async (mode) => {
    vi.useFakeTimers()
    const changed = vi.fn(),
      failed = vi.fn()
    let calls = 0
    const discover = vi.fn(async (signal: AbortSignal) => {
      calls++
      if (mode === 'denied') throw new Error('CLOUD_CREDENTIAL_REJECTED')
      if (mode === 'missing') throw new Error('CLOUD_CREDENTIAL_NOT_FOUND')
      if (mode === 'invalid') throw new Error('CLOUD_INVALID_AUTHORIZATION')
      if (mode === 'timeout')
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      if (mode === 'changed' && calls === 1) throw new Error('CLOUD_AUTH_UNAVAILABLE')
      return mode === 'changed' && calls >= 3 ? 'https://new.test' : 'https://old.test'
    })
    const off = watchCloudOrigin('https://old.test', discover, changed, failed)
    try {
      await vi.advanceTimersByTimeAsync(400000)
      if (mode === 'changed') {
        expect(changed).toHaveBeenCalledExactlyOnceWith('https://new.test')
        expect(failed).not.toHaveBeenCalled()
        expect(calls).toBe(3)
      } else {
        expect(changed).not.toHaveBeenCalled()
        expect(failed).toHaveBeenCalledExactlyOnceWith(
          mode === 'denied'
            ? 'CLOUD_CREDENTIAL_REJECTED'
            : mode === 'missing'
              ? 'CLOUD_CREDENTIAL_NOT_FOUND'
              : mode === 'invalid'
                ? 'CLOUD_INVALID_AUTHORIZATION'
                : 'CLOUD_AUTH_UNAVAILABLE',
        )
        expect(calls).toBe(mode === 'missing' || mode === 'invalid' ? 1 : 8)
      }
      const before = calls
      off()
      await vi.advanceTimersByTimeAsync(400000)
      expect(calls).toBe(before)
    } finally {
      off()
      vi.useRealTimers()
    }
  },
)

it('ignores late cloud instance recovery after disposal and aborts the pending discovery', async () => {
  vi.useFakeTimers()
  let resolve: ((origin: string) => void) | undefined
  let signal: AbortSignal | undefined
  const changed = vi.fn(),
    failed = vi.fn()
  const off = watchCloudOrigin(
    'https://old.test',
    (request) => {
      signal = request
      return new Promise<string>((done) => {
        resolve = done
      })
    },
    changed,
    failed,
  )
  try {
    await vi.advanceTimersByTimeAsync(1000)
    off()
    expect(signal?.aborted).toBe(true)
    resolve?.('https://new.test')
    await vi.advanceTimersByTimeAsync(400000)
    expect(changed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  } finally {
    off()
    vi.useRealTimers()
  }
})

it('passes the diagnostic backend section through the existing settings controller', async () => {
  const redirect = vi.spyOn(frameContext, 'requestLocalManagement').mockReturnValue(false)
  const open = vi.fn(async () => {})
  const settings = routeLocalSettings({ open } as unknown as SettingsController)
  try {
    await settings.open('diagnostics/errors')
    expect(redirect).toHaveBeenLastCalledWith({ kind: 'settings', section: 'diagnostics/errors' })
    expect(open).toHaveBeenCalledOnce()
    redirect.mockReturnValue(true)
    await settings.open('model')
    expect(open).toHaveBeenCalledOnce()
  } finally {
    redirect.mockRestore()
  }
})

it.each(['local', 'cloud', 'native'] as const)(
  'chooses the diagnostic backend before reading settings in a %s frame',
  async (mode) => {
    const post = vi.fn()
    const parent = vi
      .spyOn(window, 'parent', 'get')
      .mockReturnValue(mode === 'native' ? window : ({ postMessage: post } as unknown as Window))
    const frame = document.createElement('iframe')
    frame.setAttribute('data-agh-backend-frame', '1')
    if (mode === 'cloud') frame.setAttribute('data-backend-origin', 'https://cloud.test')
    const previousElement = Object.getOwnPropertyDescriptor(window, 'frameElement')
    Object.defineProperty(window, 'frameElement', { value: frame, configurable: true })
    let off: (() => void) | undefined
    try {
      expect(frameContext.requestDiagnosticBackend('diagnostics/errors')).toBe(mode === 'local')
      if (mode === 'local') {
        expect(post).toHaveBeenCalledWith(
          {
            type: 'agh.backend.frame/v1',
            kind: 'local-management',
            command: { kind: 'settings', section: 'diagnostics/errors' },
          },
          location.origin,
        )
        const form = document.body.appendChild(document.createElement('form'))
        const localRead = vi.fn()
        form.addEventListener('agnes:settings-route', localRead)
        const client = { on: () => () => {} } as unknown as Client
        off = installBackendFrameBridge(client)
        form.dispatchEvent(
          new CustomEvent('agnes:settings-route', { detail: 'diagnostics', bubbles: true, cancelable: true }),
        )
        expect(localRead).not.toHaveBeenCalled()
        off()
        off = undefined
        form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'diagnostics', bubbles: true }))
        expect(localRead).toHaveBeenCalledOnce()
      } else expect(post).not.toHaveBeenCalled()
      expect(frameContext.requestDiagnosticBackend('model')).toBe(false)
      expect(frameContext.requestDiagnosticBackend('diagnostics/' + 'x'.repeat(129))).toBe(false)
      expect(frameContext.requestLocalManagement({ kind: 'settings', section: 'diagnostics' })).toBe(false)
    } finally {
      off?.()
      if (previousElement) Object.defineProperty(window, 'frameElement', previousElement)
      else Reflect.deleteProperty(window, 'frameElement')
      parent.mockRestore()
    }
  },
)

it('cancels cloud instance recovery on explicit disconnect and ignores the old instance reply', async () => {
  const fixture = await diagnosticWorkbench('cloud')
  vi.useFakeTimers()
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  bindCloudCredential(fixture.remote, ref, [{ id: ref }])
  localStorage.setItem('agnes.cloud.auto-credential.v1', ref)
  let complete: ((response: Response) => void) | undefined
  let signal: AbortSignal | null | undefined
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    signal = init?.signal
    return new Promise<Response>((done) => {
      complete = done
    })
  })
  try {
    await fixture.message('cloud', {
      kind: 'state',
      snapshot: {
        ready: true,
        connected: false,
        more: false,
        rows: [],
        activity: [],
        selected: 'kept-session',
      },
    })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(fetcher).toHaveBeenCalledOnce()
    await fixture.message('local', { kind: 'cloud-action', action: 'disconnect' })
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      complete?.(
        Response.json({
          token: `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`,
          expiresAt: Date.now() + 60000,
          proxied: true,
          origin: 'https://8443-late.ap-shanghai.tencentags.com',
        }),
      )
      await vi.advanceTimersByTimeAsync(400000)
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    expect(localStorage.getItem('agnes.cloud.auto-credential.v1')).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  } finally {
    fetcher.mockRestore()
    await fixture.close()
    vi.useRealTimers()
  }
})

it.each(['parent', 'button', 'link'] as const)(
  'applies the diagnostic backend %s route before local reads through the real settings region',
  async (mode) => {
    const post = vi.fn()
    const source = { postMessage: post } as unknown as Window
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue(source)
    const frame = document.createElement('iframe')
    frame.setAttribute('data-agh-backend-frame', '1')
    const previousElement = Object.getOwnPropertyDescriptor(window, 'frameElement')
    Object.defineProperty(window, 'frameElement', { value: frame, configurable: true })
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ error: { code: 'CAPABILITY_DENIED' } }, { status: 403 }),
      )
    const context = new Context()
    let region: SettingsRegionMount | undefined
    let stop: (() => void) | undefined
    let resume: (() => void) | undefined
    const loading = new Promise<void>((resolve) => {
      resume = resolve
    })
    const client = {
      initialize: async () => ({ capabilities: {} }),
      on: () => () => {},
      session: { list: async () => ({ items: [] }), activity: async () => ({ items: [] }) },
    } as unknown as Client
    try {
      // Load the real region after isolating HTTP; its default diagnostics API captures fetch.
      const { mountSettingsPaneRegion } = await import('../src/regions/settings.js')
      await context.plugin(SlotRegistry)
      const registry = (context as unknown as { slots: SlotRegistry }).slots
      const config = document.body.appendChild(document.createElement('dialog'))
      config.id = 'config'
      await act(async () => {
        region = mountSettingsPaneRegion(registry, config, { sections: settingsSections })
      })
      const pendingReadCount = fetcher.mock.calls.length
      const applied: string[] = []
      region
        ?.form()
        ?.addEventListener('agnes:settings-route', (event) =>
          applied.push(String((event as CustomEvent).detail)),
        )
      const open = vi.fn(async (section: string) => {
        await loading
        region?.open('model')
        region?.route(section)
      })
      stop = installBackendFrameBridge(client, undefined, undefined, open)
      await act(async () => window.dispatchEvent(new CustomEvent('agnes:backend-frame-ready')))
      if (mode !== 'parent') {
        const form = region?.form()
        if (!form) throw new Error('settings form missing')
        const previousAddress = window.location.href
        if (mode === 'button') {
          const button = form.querySelector<HTMLButtonElement>('button[data-settings-section="diagnostics"]')
          if (!button) throw new Error('actual diagnostics navigation button missing')
          await act(async () => button.click())
        } else {
          const link = form.appendChild(document.createElement('a'))
          link.href = new URL('/?settings=diagnostics/errors', location.origin).href
          link.textContent = 'Diagnostics'
          await act(async () => link.click())
        }
        expect(form.dataset.settingsSection).toBe('model')
        expect(form.dataset.runtimePage).not.toBe('diagnostics')
        expect(fetcher.mock.calls).toHaveLength(pendingReadCount)
        expect(window.location.href).toBe(previousAddress)
        expect(
          post.mock.calls.find(([value]) => value.kind === 'local-management')?.[0].command.section,
        ).toBe(mode === 'link' ? 'diagnostics/errors' : 'diagnostics')
        expect(post.mock.calls.filter(([value]) => value.kind === 'local-management')).toHaveLength(1)
        // Account management remains local and does not cause another parent selection.
        const account = form.querySelector<HTMLButtonElement>('button[data-settings-section="model"]')
        if (!account) throw new Error('actual account navigation button missing')
        await act(async () => account.click())
        expect(form.dataset.settingsSection).toBe('model')
        expect(post.mock.calls.filter(([value]) => value.kind === 'local-management')).toHaveLength(1)
        post.mockClear()
      }
      const command = {
        type: 'agh.backend.command/v1',
        kind: 'settings',
        section: 'diagnostics',
        commandId: crypto.randomUUID(),
      }
      await act(async () =>
        window.dispatchEvent(new MessageEvent('message', { source, origin: location.origin, data: command })),
      )
      expect(open).toHaveBeenCalledOnce()
      expect(applied).toEqual([])
      await act(async () => {
        resume?.()
        await loading
      })
      expect(applied).toEqual(['diagnostics'])
      expect(region?.form()?.dataset.runtimePage).toBe('diagnostics')
      expect(post.mock.calls.filter(([value]) => value.kind === 'local-management')).toHaveLength(0)
      // A subsequent user request still goes to the parent, which can choose B.
      await act(async () =>
        region
          ?.form()
          ?.dispatchEvent(
            new CustomEvent('agnes:settings-route', { detail: 'diagnostics/errors', bubbles: true }),
          ),
      )
      expect(post.mock.calls.filter(([value]) => value.kind === 'local-management')).toHaveLength(1)
      expect(post.mock.calls.find(([value]) => value.kind === 'local-management')?.[0].command.section).toBe(
        'diagnostics/errors',
      )
      expect(applied).toEqual(['diagnostics'])
    } finally {
      resume?.()
      stop?.()
      await act(async () => region?.dispose())
      await context.fiber.dispose()
      fetcher.mockRestore()
      if (previousElement) Object.defineProperty(window, 'frameElement', previousElement)
      else Reflect.deleteProperty(window, 'frameElement')
      parent.mockRestore()
    }
  },
)

it('stops cloud instance recovery during rejected credential backoff after disconnect', async () => {
  vi.useFakeTimers()
  const changed = vi.fn(),
    failed = vi.fn()
  const discover = vi.fn(async () => {
    throw new Error('CLOUD_CREDENTIAL_REJECTED')
  })
  const off = watchCloudOrigin('https://old.test', discover, changed, failed)
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(discover).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
    off()
    await vi.advanceTimersByTimeAsync(400000)
    expect(discover).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  } finally {
    off()
    vi.useRealTimers()
  }
})
