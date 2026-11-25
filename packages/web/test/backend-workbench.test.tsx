// @vitest-environment happy-dom

import { Context } from '@agnes/cordis'
import {
  CLOUD_AUTHORIZATION_PATH,
  REMOTE_FRONTEND_INFO,
  REMOTE_FRONTEND_KEY_VERSION,
  REMOTE_FRONTEND_WS,
  remoteFrontendSessionPath,
} from '@agnes/protocol'
import { CREDENTIALS_CHANGED, cloudCredentialUsage } from '@agnes/resource-control-web/credentials-api'
import type { Client } from '@agnes/sdk/browser'
import type { SettingsController } from '@agnes/web-admin/settings'
import { SlotRegistry, settingsSections } from '@agnes/web-client'
import {
  createConfirmController,
  createRegionRenderer,
  mountApplication,
  unmountApplication,
} from '@agnes/web-ui'
import { getByRole, queryByRole } from '@testing-library/dom'
import type { Window as HappyWindow } from 'happy-dom'
import { act, useState, useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RemoteFrontendFailure } from '../src/backend-selector.js'
import { CloudConnectionSettings } from '../src/backends/cloud-connection-settings.js'
import { cloudFailureText } from '../src/backends/cloud-errors.js'
import { applyCloudFrameAppearance } from '../src/backends/cloud-frame-appearance.js'
import { installCloudFrameAuthorization } from '../src/backends/cloud-frame-authorization.js'
import {
  bindCloudCredential,
  bumpCloudCredentialGeneration,
  CLOUD_CREDENTIAL_GENERATION_PREFIX,
  CLOUD_CREDENTIAL_STORAGE_PREFIX,
  CLOUD_DISCOVERY_KEY,
  forgetCloudCredential,
  readCloudCredentialGeneration,
  readCloudCredentialRef,
  subscribeCloudCredentialReplacement,
} from '../src/backends/cloud-key.js'
import { watchCloudOrigin } from '../src/backends/cloud-recovery.js'
import {
  type CloudConnectionAction,
  cloudConnectionAction,
  cloudSettingsState,
  installCloudSettingsProjection,
  requestCloudConnection,
} from '../src/backends/cloud-settings-bridge.js'
import { installBackendFrameBridge } from '../src/backends/frame-bridge.js'
import * as frameContext from '../src/backends/frame-context.js'
import {
  type BackendCommand,
  type BackendSnapshot,
  backendCommand,
  backendSnapshot,
  commandBackend,
  localManagementCommand,
} from '../src/backends/frame-contract.js'
import { createLocalManagementSettings, routeLocalSettings } from '../src/backends/local-management.js'
import { localWorkbenchRoute, skillsWorkspaceId } from '../src/backends/local-route.js'
import {
  consumeWorkbenchBoot,
  executeLocalBackendCommand,
  localCloudSettings,
  localSidebarProjection,
  prepareLocalWorkbenchBoot,
  publishLocalBackendSnapshot,
  readCurrentLocalRoute,
  registerLocalCommandExecutor,
  registerWorkbenchController,
  restoreInitialCloudLocation,
} from '../src/backends/local-workbench-bus.js'
import { selectSidebarBackend, sidebarCommand } from '../src/backends/sidebar-projection.js'
import { mountBackendWorkbench } from '../src/backends/workbench.js'
import { BackendSessionGroups } from '../src/backends/workbench-groups.js'
import { workbenchCatalog } from '../src/backends/workbench-locale.js'
import {
  type CloudConnectionState,
  initialWorkbench,
  workbenchAddress,
} from '../src/backends/workbench-state.js'
import type { SettingsRegionMount } from '../src/regions/settings.js'
import {
  authorizeRemoteFrontend,
  discoverCloudOrigin,
  forgetRemoteAccess,
} from '../src/remote-authorization.js'
import {
  applySettingsSectionRoute,
  clearSettingsLink,
  consumeSettingsLink,
  isDeferredCloudSettings,
  redirectFrameSettingsLink,
} from '../src/settings-redirects.js'

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
  const media = window.matchMedia('(max-width: 900px)')
  let narrow = true
  Object.defineProperty(media, 'matches', { configurable: true, get: () => narrow })
  const originalMatchMedia = window.matchMedia.bind(window)
  vi.stubGlobal('matchMedia', (query: string) =>
    query === '(max-width: 900px)' ? media : originalMatchMedia(query),
  )
  try {
    await act(async () => mountBackendWorkbench())
    const cloud = host.querySelector<HTMLIFrameElement>('[data-testid="backend-frame-cloud"]')
    const local = host.querySelector<HTMLIFrameElement>('[data-testid="backend-frame-local"]')
    expect(cloud?.getAttribute('allow')).toBe('clipboard-write')
    expect(cloud?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups',
    )
    expect(new URL(cloud?.src ?? '').origin).toBe(meta.dataset.cloudOrigin)
    expect(local).toBeNull()
    await act(async () => {
      document.body.classList.add('sidebar-open')
    })
    expect(cloud?.hidden).toBe(true)
    expect(cloud?.hasAttribute('inert')).toBe(true)
    await act(async () => {
      narrow = false
      media.dispatchEvent(new Event('change'))
    })
    expect(cloud?.hidden).toBe(false)
    expect(cloud?.hasAttribute('inert')).toBe(false)
  } finally {
    document.body.classList.remove('sidebar-open')
    vi.stubGlobal('matchMedia', originalMatchMedia)
    await act(async () => unmountApplication(document))
    meta.remove()
    settings.disableIframePageLoading = previousIframeLoading
    vi.stubGlobal('location', new URL(previousLocation))
  }
})

it('projects browser credential usage only from in-process local settings and ignores cross-window messages', () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue(undefined)
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const off = installCloudSettingsProjection()
  try {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: 'https://untrusted.test',
        data: {
          type: 'agh.backend.frame/v1',
          kind: 'cloud-state',
          state: { status: 'ready', origin: 'https://cloud.test', credentialRef: ref },
        },
      }),
    )
    expect(cloudCredentialUsage.read()).toBeUndefined()
    localCloudSettings.publish({ status: 'ready', origin: 'https://cloud.test', credentialRef: ref })
    expect(cloudCredentialUsage.read()).toBe(ref)
    localCloudSettings.publish({ status: 'unconfigured' })
    expect(cloudCredentialUsage.read()).toBeUndefined()
    localCloudSettings.publish({ status: 'ready', origin: 'https://cloud.test', credentialRef: ref })
  } finally {
    off()
    frame.mockRestore()
  }
  expect(cloudCredentialUsage.read()).toBeUndefined()
})

it('relays only confirmed replacement of the selected local cloud credential and removes its listener', () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue(undefined)
  const actions: CloudConnectionAction[] = []
  const unregister = registerWorkbenchController({
    select: () => {},
    command: () => {},
    cloudAction: (action) => actions.push(action),
    routeDiagnostics: () => false,
    localSnapshot: () => {},
  })
  const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const off = installCloudSettingsProjection()
  const changed = (id: string, mode = 'replace') =>
    window.dispatchEvent(new CustomEvent(CREDENTIALS_CHANGED, { detail: { id, mode } }))
  try {
    localCloudSettings.publish({ status: 'ready', origin: 'https://cloud.test', credentialRef: ref })
    window.dispatchEvent(new Event(CREDENTIALS_CHANGED))
    changed(ref, 'create')
    changed(ref, 'rename')
    changed('secret://generic/22222222-2222-2222-2222-222222222222')
    expect(actions).toEqual([])
    changed(ref)
    expect(actions).toEqual([
      { action: 'credential-replaced', credentialRef: ref, generation: expect.any(String) },
    ])
    off()
    changed(ref)
    expect(actions).toHaveLength(1)
    frame.mockReturnValue({ parentOrigin: location.origin, remote: 'https://cloud.test' })
    const remoteOff = installCloudSettingsProjection()
    changed(ref)
    remoteOff()
    expect(actions).toHaveLength(1)
  } finally {
    off()
    unregister()
    frame.mockRestore()
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
  const frame = vi
    .spyOn(frameContext, 'backendFrame')
    .mockReturnValue({ parentOrigin: location.origin, remote: 'https://cloud.test' })
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
    post.mockClear()
    window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'appearance' }),
      'http://127.0.0.1:4178',
    )

    // Coalesce concurrent non-fresh requests onto one flight and preempt hung requests when `fresh: true` arrives.
    forgetRemoteAccess(remote)
    post.mockClear()
    fetcher.mockClear()
    let releaseFirst: ((value: Response) => void) | undefined
    const freshToken = `${(Date.now() + 60_000).toString(36)}.${'c'.repeat(22)}.${'d'.repeat(43)}`
    let firstSignal: AbortSignal | undefined
    fetcher
      .mockImplementationOnce(async (_input, init) => {
        firstSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve
        })
      })
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ token: freshToken, expiresAt: Date.now() + 60_000 })),
      )
    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()
    const id3 = crypto.randomUUID()
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:4178',
        source: frameWindow,
        data: { type: 'agh.backend.frame/v1', kind: 'authorization-request', requestId: id1 },
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:4178',
        source: frameWindow,
        data: { type: 'agh.backend.frame/v1', kind: 'authorization-request', requestId: id2 },
      }),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://127.0.0.1:4178',
        source: frameWindow,
        data: { type: 'agh.backend.frame/v1', kind: 'authorization-request', requestId: id3, fresh: true },
      }),
    )
    expect(firstSignal?.aborted).toBe(true)
    releaseFirst?.(new Response(JSON.stringify({ token, expiresAt: Date.now() + 60_000 })))
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3))
    expect(post.mock.calls.map(([msg]) => msg.requestId)).toEqual([id1, id2, id3])
    expect(post.mock.calls.every(([msg]) => msg.path === remoteFrontendSessionPath(freshToken))).toBe(true)
    // A successful 36-second backend exchange must outlive the former 25-second parent deadline.
    vi.useFakeTimers()
    try {
      forgetRemoteAccess(remote)
      post.mockClear()
      fetcher.mockImplementationOnce(async (_input, init) => {
        await new Promise((resolve) => setTimeout(resolve, 36_000))
        init?.signal?.throwIfAborted()
        return Response.json({ token: freshToken, expiresAt: Date.now() + 60_000 })
      })
      send('http://127.0.0.1:4178', frameWindow)
      await vi.advanceTimersByTimeAsync(36_000)
      expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'authorization',
        path: remoteFrontendSessionPath(freshToken),
      })
      // A hung exchange is still bounded and disposal cannot publish a late authorization.
      forgetRemoteAccess(remote)
      post.mockClear()
      fetcher.mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
              once: true,
            })
          }),
      )
      send('http://127.0.0.1:4178', frameWindow)
      await vi.advanceTimersByTimeAsync(55_000)
      expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'authorization',
        error: 'CLOUD_AUTH_UNAVAILABLE',
      })
    } finally {
      vi.useRealTimers()
    }
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
  const localCommands: BackendCommand[] = []
  const unregisterLocal = registerLocalCommandExecutor((command) => localCommands.push(command))
  prepareLocalWorkbenchBoot()
  await act(async () => mountBackendWorkbench())
  restoreInitialCloudLocation()
  expect(host.querySelector('[data-testid="backend-frame-local"]')).toBeNull()
  const frame = (id: 'cloud') => {
    const node = host.querySelector<HTMLIFrameElement>(`[data-testid="backend-frame-${id}"]`)
    if (!node) throw new Error('fixture backend frame missing')
    if (!node.contentWindow) Object.defineProperty(node, 'contentWindow', { value: { postMessage: vi.fn() } })
    return node
  }
  const message = async (id: 'local' | 'cloud', data: Record<string, unknown>) => {
    if (id === 'cloud') {
      const source = frame('cloud')
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: source.contentWindow,
            origin: new URL(source.src, location.origin).origin,
            data: { type: 'agh.backend.frame/v1', ...data },
          }),
        ),
      )
      return
    }
    await act(async () => {
      if (data.kind === 'state' && data.snapshot)
        publishLocalBackendSnapshot(data.snapshot as BackendSnapshot)
      else if (data.kind === 'sidebar-select' && (data.backend === 'local' || data.backend === 'cloud'))
        selectSidebarBackend(data.backend)
      else if (data.kind === 'sidebar-command' && (data.backend === 'local' || data.backend === 'cloud')) {
        const command = backendCommand(data.command)
        if (command) sidebarCommand(data.backend, command)
      } else if (data.kind === 'local-route' && typeof data.route === 'string') {
        if (data.operation === 'push') history.pushState(history.state, '', data.route)
        else history.replaceState(history.state, '', data.route)
      } else if (data.kind === 'cloud-action') {
        const parsed = cloudConnectionAction({ type: 'agh.backend.frame/v1', ...data })
        if (parsed) requestCloudConnection(parsed)
      } else if (data.kind === 'local-management' && data.command) {
        const command = data.command as { kind?: unknown; section?: unknown }
        if (command.kind === 'settings' && typeof command.section === 'string') {
          if (!frameContext.requestDiagnosticBackend(command.section))
            localCommands.push({ kind: 'settings', section: command.section })
        }
      }
    })
  }
  return {
    remote,
    frame,
    localCommands,
    message,
    async close() {
      unregisterLocal()
      await act(async () => unmountApplication(document))
      host.remove()
      meta.remove()
      settings.disableIframePageLoading = previousLoading
      localStorage.clear()
      vi.stubGlobal('location', new URL(previousLocation))
    },
  }
}

it.each(['first', 'saved-origin', 'selected-session'] as const)(
  'initializes the cloud selection after manual configuration (%s)',
  async (mode) => {
    const fixture = await diagnosticWorkbench(mode === 'selected-session' ? 'cloud' : 'local')
    const credentialRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
    const remote = mode === 'first' ? 'https://8443-first.ap-shanghai.tencentags.com' : fixture.remote
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/admin/api/credentials'))
        return Response.json({
          items: [
            {
              id: credentialRef,
              label: 'fixture',
              kind: 'api-key',
              createdAt: '2026-11-25T00:00:00Z',
              references: [],
            },
          ],
        })
      if (new URL(String(input), location.href).pathname !== CLOUD_AUTHORIZATION_PATH)
        throw Error('unexpected request')
      return Response.json({
        token: `${(Date.now() + 3600000).toString(36)}.${'a'.repeat(22)}.${'b'.repeat(43)}`,
        expiresAt: Date.now() + 3600000,
        proxied: true,
        origin: remote,
      })
    })
    try {
      if (mode === 'first') await fixture.message('local', { kind: 'cloud-action', action: 'disconnect' })
      const previous = mode === 'first' ? undefined : fixture.frame('cloud')
      await fixture.message('local', { kind: 'cloud-action', action: 'connect', credentialRef })
      await vi.waitFor(() => {
        expect(fixture.frame('cloud').dataset.backendOrigin).toBe(remote)
        expect(fixture.frame('cloud')).not.toBe(previous)
      })
      const frame = fixture.frame('cloud')
      const query = new URL(frame.src).searchParams
      expect(query.get('new')).toBe(mode === 'selected-session' ? null : '1')
      expect(query.get('session')).toBe(mode === 'selected-session' ? 'kept-session' : null)
      // Selecting Cloud must retain the initialized draft, rather than issue a second new command.
      await fixture.message('local', { kind: 'sidebar-select', backend: 'cloud' })
      expect(fixture.frame('cloud')).toBe(frame)
      expect(new URL(frame.src).search).toBe(`?${query}`)
    } finally {
      forgetRemoteAccess(remote)
      fetcher.mockRestore()
      await fixture.close()
    }
  },
)

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
    expect(readCurrentLocalRoute()).toBe(route)
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
            source: window,
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

it.each(['storage event', 'reconnect followed by a refresh'])(
  'retires a deleted Cloud binding on %s and cancels discovery only for its own credential',
  async (recovery) => {
    const fixture = await diagnosticWorkbench('cloud')
    const currentRef = `secret://generic/${crypto.randomUUID()}`
    const pendingRef = `secret://generic/${crypto.randomUUID()}`
    const otherRef = `secret://generic/${crypto.randomUUID()}`
    const credentials = [currentRef, pendingRef, otherRef].map((id) => ({
      id,
      label: 'Fixture key',
      kind: 'api-key',
      createdAt: '2026-11-20T00:00:00Z',
      references: [],
    }))
    bindCloudCredential(fixture.remote, currentRef, credentials)
    localStorage.setItem(CLOUD_DISCOVERY_KEY, currentRef)
    let finish!: (response: Response) => void
    let pendingSignal: AbortSignal | null | undefined
    const reply = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const discovery = 'https://8443-new.ap-shanghai.tencentags.com'
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/admin/api/credentials')) return Response.json({ items: credentials })
      pendingSignal = init?.signal
      return reply
    })
    const listeners = new Map<string, (payload: unknown) => void>()
    const off = installCloudSettingsProjection({
      on(event, listener) {
        listeners.set(event, listener)
        return () => {
          listeners.delete(event)
        }
      },
    })
    const deleted = (id: string) => listeners.get('notice')?.({ kind: 'credential_deleted', detail: { id } })
    try {
      await fixture.message('cloud', { kind: 'state', ready: true, connected: true, rows: [] })
      await act(async () => requestCloudConnection({ action: 'connect', credentialRef: pendingRef }))
      expect(pendingSignal?.aborted).toBe(false)
      await act(async () => deleted(otherRef))
      expect(pendingSignal?.aborted).toBe(false)
      expect(readCloudCredentialRef(fixture.remote)).toBe(currentRef)
      await act(async () => deleted(pendingRef))
      expect(pendingSignal?.aborted).toBe(true)
      await act(async () =>
        finish(
          Response.json({
            token: `${(Date.now() + 60_000).toString(36)}.${'a'.repeat(22)}.${'b'.repeat(43)}`,
            expiresAt: Date.now() + 60_000,
            origin: discovery,
            proxied: true,
          }),
        ),
      )
      expect(readCloudCredentialRef(discovery)).toBeUndefined()
      expect(fixture.frame('cloud').dataset.backendOrigin).toBe(fixture.remote)
      if (recovery === 'storage event') {
        const key = CLOUD_CREDENTIAL_GENERATION_PREFIX + currentRef
        const generation = `deleted:${crypto.randomUUID()}`
        await act(async () => {
          localStorage.setItem(key, generation)
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: generation }))
        })
      } else {
        let completeList!: (response: Response) => void
        let reconcileSignal: AbortSignal | null | undefined
        const staleList = Response.json({ items: credentials })
        credentials.length = 0
        fetcher.mockImplementationOnce((_input, init) => {
          reconcileSignal = init?.signal
          return new Promise((resolve) => {
            completeList = resolve
          })
        })
        await act(async () => listeners.get('connectionStateChanged')?.('connected'))
        expect(reconcileSignal?.aborted).toBe(false)
        await act(async () => requestCloudConnection({ action: 'refresh-credentials' }))
        expect(reconcileSignal?.aborted).toBe(true)
        await act(async () => completeList(staleList))
        expect(localStorage.getItem(CLOUD_CREDENTIAL_STORAGE_PREFIX + fixture.remote)).toBeNull()
      }
      expect(readCloudCredentialRef(fixture.remote)).toBeUndefined()
      expect(localStorage.getItem(CLOUD_DISCOVERY_KEY)).toBeNull()
      expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
      if (recovery !== 'storage event') {
        // Disconnected tabs can still have a managed discovery selection and older saved origins.
        const dormantRef = `secret://generic/${crypto.randomUUID()}`
        const savedRef = `secret://generic/${crypto.randomUUID()}`
        localStorage.setItem(CLOUD_DISCOVERY_KEY, dormantRef)
        bindCloudCredential(discovery, savedRef, [{ id: savedRef }])
        await act(async () => listeners.get('connectionStateChanged')?.('connected'))
        expect(localStorage.getItem(CLOUD_DISCOVERY_KEY)).toBeNull()
        expect(localStorage.getItem(CLOUD_CREDENTIAL_STORAGE_PREFIX + discovery)).toBeNull()
        expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
      }
    } finally {
      off()
      fetcher.mockRestore()
      await fixture.close()
    }
  },
)

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
    let finishSameRef: ((response: Response) => void) | undefined
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSameRef = resolve
        }),
    )
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    await act(async () =>
      finishSameRef?.(
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
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fixture.frame('cloud')).not.toBe(previous)
    expect(new URL(fixture.frame('cloud').src).searchParams.get('session')).toBe('kept-session')

    // Also verify rotation WHILE another attempt is in flight immediately retires the old frame without cancelling the attempt, and reconnects once the failed attempt settles.
    const activeBeforeFailure = fixture.frame('cloud')
    let failAttempt: ((response: Response) => void) | undefined
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          failAttempt = resolve
        }),
    )
    await fixture.message('local', { kind: 'cloud-action', action: 'connect', credentialRef: rejected })
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    await act(async () => failAttempt?.(Response.json({ items: [] })))
    expect(fixture.frame('cloud')).not.toBe(activeBeforeFailure)
    expect(localCloudSettings.read()).toMatchObject({
      credentialRef: ref,
      error: 'CLOUD_CREDENTIAL_NOT_FOUND',
    })

    // Failed active rotation surfaces the error on the Cloud sidebar instead of leaving it on Connecting.
    fetcher.mockImplementationOnce(async () => Response.json({ items: [] }))
    await fixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: ref,
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    expect(localSidebarProjection.read()?.states.cloud?.error).toBe('CLOUD_CREDENTIAL_NOT_FOUND')
  } finally {
    fetcher.mockRestore()
    await fixture.close()
  }
})

it.each(['local', 'cloud'] as const)(
  'keeps the diagnostic backend %s and never falls back to A when B is offline',
  async (backend) => {
    const fixture = await diagnosticWorkbench(backend)
    const cloud = fixture.frame('cloud')
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
      await fixture.message('local', {
        kind: 'sidebar-command',
        backend,
        command: { type: 'agh.backend.command/v1', kind: 'settings', section: 'model' },
      })
      fixture.localCommands.length = 0
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
          fixture.localCommands.some(
            (value) => value.kind === 'settings' && value.section.startsWith('diagnostics'),
          ),
        ).toBe(false)
        await fixture.message('cloud', {
          kind: 'state',
          snapshot: { ...snapshot, connected: false, ready: false },
        })
        fixture.localCommands.length = 0
        await fixture.message('local', {
          kind: 'local-management',
          command: { type: 'agh.backend.command/v1', kind: 'settings', section: 'diagnostics' },
        })
        expect(fixture.frame('cloud').hidden).toBe(false)
        expect(
          fixture.localCommands.some((value) => value.kind === 'settings' && value.section === 'diagnostics'),
        ).toBe(false)
        // A late B snapshot must not reclaim the user's newly selected local target.
        await fixture.message('local', { kind: 'sidebar-select', backend: 'local' })
        await fixture.message('cloud', { kind: 'state', snapshot })
        expect(fixture.frame('cloud').hidden).toBe(true)
        fixture.localCommands.length = 0
        cloudPost.mockClear()
        await fixture.message('local', {
          kind: 'local-management',
          command: { kind: 'settings', section: 'diagnostics' },
        })
        expect(
          fixture.localCommands.some((value) => value.kind === 'settings' && value.section === 'diagnostics'),
        ).toBe(true)
        expect(cloudPost.mock.calls.some(([value]) => value.kind === 'settings')).toBe(false)
      } else expect(cloudPost.mock.calls.some(([value]) => value.kind === 'settings')).toBe(false)
      expect(commandBackend(backend, { kind: 'settings', section: 'diagnostics' })).toBe(backend)
      expect(commandBackend(backend, { kind: 'settings', section: 'model' })).toBe('local')
    } finally {
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

it.each(['same-origin-restart', 'capability-expired-managed', 'capability-expired-explicit'] as const)(
  'recovers %s on the same origin after verifying metadata without replaying commands',
  async (scenario) => {
    const fixture = await diagnosticWorkbench('cloud')
    vi.useFakeTimers()
    const ref = 'secret://generic/11111111-1111-1111-1111-111111111111'
    const managed = scenario !== 'capability-expired-explicit'
    bindCloudCredential(fixture.remote, ref, [{ id: ref }])
    if (managed) localStorage.setItem('agnes.cloud.auto-credential.v1', ref)
    else localStorage.removeItem('agnes.cloud.auto-credential.v1')
    const makeToken = (expiresAt: number, tag: string) =>
      `${expiresAt.toString(36)}.${tag.repeat(22).slice(0, 22)}.${'B'.repeat(43)}`
    const initialExpiresAt = Date.now() + 8 * 60 * 60 * 1000
    const tokenOld = makeToken(initialExpiresAt, 'A')
    let activeToken = tokenOld
    let instanceId = 'instance-1'
    let booting = scenario === 'same-origin-restart'
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/admin/api/credentials'))
        return Response.json({
          items: [
            { id: ref, label: 'fixture', kind: 'api-key', createdAt: '2026-11-20T00:00:00Z', references: [] },
          ],
        })
      if (url.pathname === CLOUD_AUTHORIZATION_PATH) {
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000
        activeToken = makeToken(expiresAt, 'C')
        return Response.json({
          token: activeToken,
          expiresAt,
          proxied: true,
          ...(managed ? { origin: fixture.remote } : {}),
        })
      }
      if (url.origin === 'http://127.0.0.1:4178' && url.pathname.endsWith(REMOTE_FRONTEND_INFO)) {
        if (booting) {
          booting = false
          return new Response('', { status: 503 })
        }
        const prefix = remoteFrontendSessionPath(activeToken)
        if (!url.pathname.startsWith(`${prefix}/`)) return new Response('', { status: 401 })
        return Response.json({
          version: REMOTE_FRONTEND_KEY_VERSION,
          access: 'key-owner',
          wsPath: REMOTE_FRONTEND_WS,
          instanceId,
        })
      }
      throw new Error(`unexpected fixture request: ${url.href}`)
    })
    try {
      await authorizeRemoteFrontend(fixture.remote, new AbortController().signal, async () =>
        Response.json({ token: tokenOld, expiresAt: initialExpiresAt, proxied: true }),
      )
      const previousFrame = fixture.frame('cloud')
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
      if (scenario === 'same-origin-restart') {
        activeToken = makeToken(Date.now() + 8 * 60 * 60 * 1000, 'X')
        instanceId = 'instance-2'
      } else {
        await act(async () => vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000 + 1_000))
      }
      // Queue an unacknowledged command while unready/offline; recovery must drop it, never replay it.
      await fixture.message('cloud', {
        kind: 'state',
        snapshot: {
          ready: false,
          connected: false,
          more: false,
          rows: [],
          activity: [],
          selected: 'kept-session',
        },
      })
      await act(async () => sidebarCommand('cloud', { kind: 'search' }))
      await act(async () => vi.advanceTimersByTimeAsync(6_000))
      const nextFrame = fixture.frame('cloud')
      expect(nextFrame).not.toBe(previousFrame)
      expect(nextFrame.dataset.backendOrigin).toBe(fixture.remote)
      expect(new URL(nextFrame.src).searchParams.get('session')).toBe('kept-session')
      const post = vi.spyOn(nextFrame.contentWindow!, 'postMessage')
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
      expect(post).not.toHaveBeenCalled()
      expect(localCloudSettings.read()?.error).toBeUndefined()
      expect(await authorizeRemoteFrontend(fixture.remote, new AbortController().signal, fetcher)).toBe(
        remoteFrontendSessionPath(activeToken),
      )
    } finally {
      forgetRemoteAccess(fixture.remote)
      fetcher.mockRestore()
      await fixture.close()
      vi.useRealTimers()
    }
  },
)

it.each([
  'changed',
  'unchanged',
  'same-verified',
  'same-unverified',
  'denied',
  'missing',
  'invalid',
  'timeout',
] as const)('bounds cloud instance recovery and cleans up its %s attempts', async (mode) => {
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
  const verify =
    mode === 'same-verified' || mode === 'same-unverified'
      ? vi.fn(async () => mode === 'same-verified' && calls >= 2)
      : undefined
  const off = watchCloudOrigin('https://old.test', discover, changed, failed, verify)
  try {
    await vi.advanceTimersByTimeAsync(800000)
    if (mode === 'changed') {
      expect(changed).toHaveBeenCalledExactlyOnceWith('https://new.test')
      expect(failed).not.toHaveBeenCalled()
      expect(calls).toBe(3)
    } else if (mode === 'same-verified') {
      expect(changed).toHaveBeenCalledExactlyOnceWith('https://old.test')
      expect(failed).not.toHaveBeenCalled()
      expect(calls).toBe(2)
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
    await vi.advanceTimersByTimeAsync(800000)
    expect(calls).toBe(before)
  } finally {
    off()
    vi.useRealTimers()
  }
})

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

it.each(['cloud-selected', 'cloud', 'local-selected'] as const)(
  'chooses the diagnostic backend before reading settings (%s)',
  async (mode) => {
    const post = vi.fn()
    const routed: string[] = []
    const unregister = registerWorkbenchController({
      select: () => {},
      command: () => {},
      cloudAction: () => {},
      routeDiagnostics: (section) => {
        if (mode !== 'cloud-selected') return false
        routed.push(section)
        return true
      },
      localSnapshot: () => {},
    })
    const parent = vi
      .spyOn(window, 'parent', 'get')
      .mockReturnValue(mode === 'cloud' ? ({ postMessage: post } as unknown as Window) : window)
    const frame = document.createElement('iframe')
    frame.setAttribute('data-agh-backend-frame', '1')
    if (mode === 'cloud') frame.setAttribute('data-backend-origin', 'https://cloud.test')
    const previousElement = Object.getOwnPropertyDescriptor(window, 'frameElement')
    if (mode === 'cloud') Object.defineProperty(window, 'frameElement', { value: frame, configurable: true })
    let off: (() => void) | undefined
    try {
      expect(frameContext.requestDiagnosticBackend('diagnostics/errors')).toBe(mode === 'cloud-selected')
      if (mode === 'cloud-selected') {
        expect(routed).toEqual(['diagnostics/errors'])
        const form = document.body.appendChild(document.createElement('form'))
        const localRead = vi.fn()
        form.addEventListener('agnes:settings-route', localRead)
        const client = { on: () => () => {} } as unknown as Client
        off = installBackendFrameBridge(client)
        form.dispatchEvent(
          new CustomEvent('agnes:settings-route', { detail: 'diagnostics', bubbles: true, cancelable: true }),
        )
        expect(localRead).not.toHaveBeenCalled()
        expect(routed).toEqual(['diagnostics/errors', 'diagnostics'])
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
      unregister()
      if (previousElement) Object.defineProperty(window, 'frameElement', previousElement)
      else Reflect.deleteProperty(window, 'frameElement')
      parent.mockRestore()
    }
  },
)

it('cancels cloud instance recovery on explicit disconnect and ignores the old instance reply', async () => {
  const replace = vi.spyOn(history, 'replaceState')
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
    expect(readCloudCredentialRef(fixture.remote)).toBeUndefined()
    const stateSpy = vi
      .spyOn(history, 'state', 'get')
      .mockReturnValue({ aghLocalRoute: '/?session=local-kept' })
    vi.stubGlobal(
      'location',
      new URL(`http://127.0.0.1:4177/?remote=${encodeURIComponent(fixture.remote)}&session=kept-session`),
    )
    replace.mockClear()
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    })
    stateSpy.mockRestore()
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ aghLocalRoute: '/?session=local-kept' }),
      '',
      '/?session=local-kept',
    )
    expect(fixture.localCommands.at(-1)).toEqual({
      kind: 'restore-local-route',
      route: '/?session=local-kept',
    })
    expect(fetcher).toHaveBeenCalledOnce()
  } finally {
    replace.mockRestore()
    fetcher.mockRestore()
    await fixture.close()
    vi.useRealTimers()
  }
})

it.each(['parent', 'button', 'link'] as const)(
  'applies the diagnostic backend %s route before local reads through the real settings region',
  async (mode) => {
    const routed: string[] = []
    let interceptCloud = true
    const unregister = registerWorkbenchController({
      select: () => {},
      command: () => {},
      cloudAction: () => {},
      routeDiagnostics: (section) => {
        if (!interceptCloud) return false
        routed.push(section)
        return true
      },
      localSnapshot: () => {},
    })
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
        expect(routed).toEqual([mode === 'link' ? 'diagnostics/errors' : 'diagnostics'])
        const account = form.querySelector<HTMLButtonElement>('button[data-settings-section="model"]')
        if (!account) throw new Error('actual account navigation button missing')
        await act(async () => account.click())
        expect(form.dataset.settingsSection).toBe('model')
        expect(routed).toHaveLength(1)
        routed.length = 0
      }
      interceptCloud = false
      await act(async () => executeLocalBackendCommand({ kind: 'settings', section: 'diagnostics' }))
      expect(open).toHaveBeenCalledOnce()
      expect(applied).toEqual([])
      await act(async () => {
        resume?.()
        await loading
      })
      expect(applied).toEqual(['diagnostics'])
      expect(region?.form()?.dataset.runtimePage).toBe('diagnostics')
      expect(routed).toHaveLength(0)
      interceptCloud = true
      await act(async () =>
        region
          ?.form()
          ?.dispatchEvent(
            new CustomEvent('agnes:settings-route', { detail: 'diagnostics/errors', bubbles: true }),
          ),
      )
      expect(routed).toEqual(['diagnostics/errors'])
      expect(applied).toEqual(['diagnostics'])
    } finally {
      resume?.()
      stop?.()
      unregister()
      await act(async () => region?.dispose())
      await context.fiber.dispose()
      fetcher.mockRestore()
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

it('suspends open local overlay dialogs when switching to cloud without erasing the saved local settings route', async () => {
  const fixture = await diagnosticWorkbench('local')
  const overlay = document.body.appendChild(document.createElement('div'))
  overlay.id = 'agnes-overlay-container'
  overlay.innerHTML = `
    <dialog id="config" open></dialog>
    <dialog id="admin-confirm">
      <h2 id="admin-confirm-title"></h2>
      <p id="admin-confirm-description"></p>
      <div id="admin-confirm-preview"></div>
      <button id="admin-confirm-cancel" type="button"></button>
      <button id="admin-confirm-action" type="button"></button>
    </dialog>
  `
  const dialog = overlay.querySelector<HTMLDialogElement>('#config')
  const confirmDialog = overlay.querySelector<HTMLDialogElement>('#admin-confirm')
  const confirm = createConfirmController()
  try {
    history.pushState(null, '', '/?settings=security')
    expect(readCurrentLocalRoute()).toBe('/?settings=security')
    const decision = confirm.ask({ title: 'Enable', description: 'Skill?' })
    expect(confirmDialog?.open).toBe(true)
    await act(async () => selectSidebarBackend('cloud'))
    expect(document.body.dataset.aghActiveBackend).toBe('cloud')
    expect(dialog?.open).toBe(false)
    expect(confirmDialog?.open).toBe(false)
    await expect(decision).resolves.toBe(false)
    const reopened = confirm.ask({ title: 'Enable again', description: 'MCP?' })
    confirmDialog?.querySelector<HTMLButtonElement>('#admin-confirm-cancel')?.click()
    await expect(reopened).resolves.toBe(false)
    clearSettingsLink()
    expect(readCurrentLocalRoute()).toBe('/?settings=security')
  } finally {
    overlay.remove()
    await fixture.close()
  }
})

it('guards linked account subpages during cloud boot and redirects child frame history traversals', async () => {
  const previousLocation = location.href
  let savedState: unknown = { aghLocalRoute: '/?settings=model/add-account' }
  let currentUrl = new URL('http://127.0.0.1:4177/?remote=https%3A%2F%2Fcloud.test')
  vi.stubGlobal('location', currentUrl)
  const stateSpy = vi.spyOn(history, 'state', 'get').mockImplementation(() => savedState)
  const replaceSpy = vi.spyOn(history, 'replaceState').mockImplementation((value, _unused, url) => {
    savedState = value
    if (url != null) {
      currentUrl = new URL(String(url), currentUrl)
      vi.stubGlobal('location', currentUrl)
    }
  })
  const post = vi.fn()
  const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window)
  const frame = document.createElement('iframe')
  frame.setAttribute('data-agh-backend-frame', '1')
  frame.setAttribute('data-backend-origin', 'https://cloud.test')
  const previousElement = Object.getOwnPropertyDescriptor(window, 'frameElement')
  const context = new Context()
  let region: SettingsRegionMount | undefined
  try {
    const boot = prepareLocalWorkbenchBoot()
    try {
      expect(location.search).toBe('?settings=model/add-account')
      expect(isDeferredCloudSettings()).toBe(true)
      consumeWorkbenchBoot()
      const { mountSettingsPaneRegion } = await import('../src/regions/settings.js')
      await context.plugin(SlotRegistry)
      const registry = (context as unknown as { slots: SlotRegistry }).slots
      const config = document.body.appendChild(document.createElement('dialog'))
      config.id = 'config'
      await act(async () => {
        region = mountSettingsPaneRegion(registry, config, { sections: settingsSections })
      })
      let openedSection = ''
      const localBootSettings = createLocalManagementSettings({
        client: {
          config: {
            get: async () => ({
              profile: 'local',
              revision: 1,
              configured: true,
              provider: null,
              accounts: [],
              effect: 'new-sessions',
            }),
            save: async () => ({
              profile: 'local',
              revision: 1,
              configured: true,
              provider: null,
              accounts: [],
              effect: 'new-sessions',
            }),
            test: async () => ({ verified: true, models: [] }),
            providers: async () => ({ providers: [] }),
          },
        } as unknown as Client,
        onOpen: () => {
          openedSection = document.getElementById('config-form')?.dataset.settingsSection ?? ''
        },
        onSaved: async () => {},
        onError: () => {},
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(isDeferredCloudSettings()).toBe(true)
      expect(localBootSettings.isOpen()).toBe(false)

      Object.defineProperty(window, 'frameElement', { value: frame, configurable: true })
      await act(async () => {
        await localBootSettings.open('diagnostics')
      })
      expect(post).not.toHaveBeenCalled()
      expect(localBootSettings.isOpen()).toBe(true)
      expect(openedSection).toBe('diagnostics')
      localBootSettings.close()
      Reflect.deleteProperty(window, 'frameElement')
    } finally {
      restoreInitialCloudLocation(boot)
    }
    expect(location.search).toBe('?remote=https%3A%2F%2Fcloud.test')
    expect(isDeferredCloudSettings()).toBe(true)

    Object.defineProperty(window, 'frameElement', { value: frame, configurable: true })
    history.replaceState(null, '', '/?remote=https%3A%2F%2Fcloud.test&settings=model/add-account')
    expect(redirectFrameSettingsLink()).toBe(true)
    expect(post).toHaveBeenLastCalledWith(
      {
        type: 'agh.backend.frame/v1',
        kind: 'local-management',
        command: { kind: 'settings', section: 'model/add-account' },
      },
      location.origin,
    )
    history.replaceState(null, '', '/?remote=https%3A%2F%2Fcloud.test&settings=model/account&account=acc-1')
    expect(redirectFrameSettingsLink()).toBe(true)
    expect(post).toHaveBeenLastCalledWith(
      {
        type: 'agh.backend.frame/v1',
        kind: 'local-management',
        command: { kind: 'settings', section: 'model' },
      },
      location.origin,
    )
    expect(new URLSearchParams(location.search).has('settings')).toBe(false)
    expect(new URLSearchParams(location.search).has('account')).toBe(false)

    Reflect.deleteProperty(window, 'frameElement')
    history.replaceState(null, '', '/')
    expect(applySettingsSectionRoute('model/add-account')).toBe('model')
    expect(location.search).toBe('?settings=model/add-account')
    expect(cloudFailureText('CLOUD_DISCOVERY_TIMEOUT', 'zh-CN')).toContain('超时')
  } finally {
    await act(async () => region?.dispose())
    document.getElementById('config')?.remove()
    await context.fiber.dispose()
    if (previousElement) Object.defineProperty(window, 'frameElement', previousElement)
    else Reflect.deleteProperty(window, 'frameElement')
    parent.mockRestore()
    replaceSpy.mockRestore()
    stateSpy.mockRestore()
    vi.stubGlobal('location', new URL(previousLocation))
  }
})

it('binds cached capabilities to the active credential across tabs, keeps saved local diagnostics off cloud B during boot, and resets failed credential switches in settings', async () => {
  const refA = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const refB = 'secret://generic/22222222-2222-2222-2222-222222222222'
  const sandbox = 'https://8443-tab-sync.ap-shanghai.tencentags.com'
  const tokenA = `${(Date.now() + 3600000).toString(36)}.${'a'.repeat(22)}.${'b'.repeat(43)}`
  const tokenB = `${(Date.now() + 3600000).toString(36)}.${'c'.repeat(22)}.${'d'.repeat(43)}`
  let calls = 0
  const authFetch: typeof fetch = async (_input, init) => {
    calls++
    const body = JSON.parse(String(init?.body ?? '{}')) as { credentialRef?: string }
    return Response.json({
      token: body.credentialRef === refA ? tokenA : tokenB,
      expiresAt: Date.now() + 3600000,
      proxied: true,
      origin: sandbox,
    })
  }
  await discoverCloudOrigin(refA, new AbortController().signal, authFetch)
  bindCloudCredential(sandbox, refA, [{ id: refA }, { id: refB }])
  expect(await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)).toContain(tokenA)
  expect(calls).toBe(1)

  // Another tab rebinding or removing the credential invalidates the cached grant.
  bindCloudCredential(sandbox, refB, [{ id: refA }, { id: refB }])
  expect(await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)).toContain(tokenB)
  expect(calls).toBe(2)
  forgetCloudCredential(sandbox)
  await expect(authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)).rejects.toThrow(
    'CLOUD_CREDENTIAL_REQUIRED',
  )

  // Saved local diagnostics in aghLocalRoute never dispatches a diagnostics command to Cloud B on reload.
  const previousLocation = location.href
  const happySettings = (window as unknown as HappyWindow).happyDOM.settings
  const previousIframe = happySettings.disableIframePageLoading
  happySettings.disableIframePageLoading = true
  let saved: unknown = { aghLocalRoute: '/?settings=diagnostics' }
  let bootUrl = new URL(`http://127.0.0.1:4177/?remote=${encodeURIComponent(sandbox)}&session=c1`)
  vi.stubGlobal('location', bootUrl)
  const stateSpy = vi.spyOn(history, 'state', 'get').mockImplementation(() => saved)
  const replaceSpy = vi.spyOn(history, 'replaceState').mockImplementation((value, _unused, url) => {
    saved = value
    if (url != null) {
      bootUrl = new URL(String(url), bootUrl)
      vi.stubGlobal('location', bootUrl)
    }
  })
  const meta = document.head.appendChild(document.createElement('meta'))
  meta.id = 'agnes-config'
  meta.dataset.cloudOrigin = 'http://127.0.0.1:4178'
  const bootHost = document.body.appendChild(document.createElement('div'))
  bootHost.id = 'app-root'
  try {
    const boot = prepareLocalWorkbenchBoot()
    try {
      expect(consumeWorkbenchBoot()).toBe(boot)
      await act(async () => mountBackendWorkbench())
      expect(consumeSettingsLink().id).toBe('diagnostics')
      history.replaceState(history.state, '', '/?settings=diagnostics')
    } finally {
      restoreInitialCloudLocation(boot)
    }
    const cloudFrame = bootHost.querySelector<HTMLIFrameElement>('[data-testid="backend-frame-cloud"]')
    const cloudPost = vi.fn()
    if (cloudFrame && !cloudFrame.contentWindow)
      Object.defineProperty(cloudFrame, 'contentWindow', { value: { postMessage: cloudPost } })
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: cloudFrame?.contentWindow ?? null,
          origin: 'http://127.0.0.1:4178',
          data: {
            type: 'agh.backend.frame/v1',
            kind: 'state',
            snapshot: { ready: true, connected: true, more: false, rows: [], activity: [], selected: 'c1' },
          },
        }),
      )
    })
    expect(cloudPost.mock.calls.some(([msg]) => msg?.kind === 'settings')).toBe(false)
  } finally {
    await act(async () => unmountApplication(document))
    bootHost.remove()
    meta.remove()
    happySettings.disableIframePageLoading = previousIframe
    replaceSpy.mockRestore()
    stateSpy.mockRestore()
    vi.stubGlobal('location', new URL(previousLocation))
  }

  // CloudConnectionSettings resets the selector to the active credential when a switch attempt fails.
  const host = document.body.appendChild(document.createElement('div'))
  function Harness() {
    const [state, setState] = useState<CloudConnectionState>({
      status: 'ready',
      origin: sandbox,
      credentialRef: refA,
      credentialOptions: [
        { id: refA, label: 'Deployment A' },
        { id: refB, label: 'Deployment B' },
      ],
    })
    return (
      <>
        <CloudConnectionSettings
          state={state}
          onAction={(action) => {
            if (action.action === 'connect')
              setState(({ error: _error, ...s }) => ({ ...s, status: 'connecting' }))
          }}
        />
        <button
          type="button"
          data-testid="settle-failed-switch"
          onClick={() => setState((s) => ({ ...s, status: 'ready', error: 'CLOUD_CREDENTIAL_REJECTED' }))}
        />
      </>
    )
  }
  await act(async () => mountApplication(host, <Harness />))
  try {
    const select = host.querySelector<HTMLSelectElement>('#cloud-service-credential')
    expect(select?.value).toBe(refA)
    await act(async () => {
      if (select) {
        select.value = refB
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    expect(select?.value).toBe(refB)
    await act(async () => getByRole(host, 'button', { name: workbenchCatalog.en.saveConnect }).click())
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="settle-failed-switch"]')?.click(),
    )
    expect(select?.value).toBe(refA)
    expect(getByRole(host, 'alert').textContent).toContain('rejected')
  } finally {
    await act(async () => unmountApplication(document))
    host.remove()
  }

  // Replacing a secret in one tab (even when another credential is selected there) bumps generation for other tabs andobserver storage events never delete newer shared state.
  const offProjection = installCloudSettingsProjection()
  try {
    bindCloudCredential(sandbox, refA, [{ id: refA }, { id: refB }])
    expect(await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)).toContain(tokenA)
    const callsBeforeReplace = calls
    const beforeGen = readCloudCredentialGeneration(refA)
    localCloudSettings.publish({ status: 'ready', origin: sandbox, credentialRef: refB })
    window.dispatchEvent(new CustomEvent(CREDENTIALS_CHANGED, { detail: { mode: 'replace', id: refA } }))
    const afterGen = readCloudCredentialGeneration(refA)
    expect(afterGen).not.toBe(beforeGen)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${refA}`,
        newValue: afterGen,
      }),
    )
    await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)
    expect(calls).toBe(callsBeforeReplace + 1)
  } finally {
    offProjection()
    forgetCloudCredential(sandbox)
    localStorage.clear()
  }

  // Queued origin-removal StorageEvent reconciles live storage without deleting a newer connection or blocking changed-origin recovery after candidateError.
  const tabFixture = await diagnosticWorkbench('cloud')
  const activeRef = 'secret://generic/33333333-3333-3333-3333-333333333333'
  const candidateRef = 'secret://generic/44444444-4444-4444-4444-444444444444'
  const migratedOrigin = 'https://8443-migrated.ap-shanghai.tencentags.com'
  bindCloudCredential(tabFixture.remote, activeRef, [{ id: activeRef }])
  localStorage.setItem('agnes.cloud.auto-credential.v1', activeRef)
  let pendingCancel: ((response: Response) => void) | undefined
  const tabFetch = vi.spyOn(window, 'fetch').mockImplementation(async () =>
    Response.json({
      items: [
        {
          id: activeRef,
          label: 'active',
          kind: 'api-key',
          createdAt: '2026-11-20T00:00:00Z',
          references: [],
        },
      ],
    }),
  )
  try {
    await tabFixture.message('cloud', {
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
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', newValue: null }))
    })
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(tabFixture.remote)
    expect(readCloudCredentialRef(tabFixture.remote)).toBe(activeRef)
    expect(tabFixture.frame('cloud')).toBeTruthy()

    // Unrelated candidate switch failure sets candidateError without setting configurationError, keeping recovery active.
    await tabFixture.message('local', {
      kind: 'cloud-action',
      action: 'connect',
      credentialRef: candidateRef,
    })
    expect(localCloudSettings.read()).toMatchObject({
      status: 'ready',
      credentialRef: activeRef,
      error: 'CLOUD_CREDENTIAL_NOT_FOUND',
    })

    // Storage cancellation clears connectionIntent so a subsequent active rotation reconnects instead of hanging.
    tabFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          pendingCancel = resolve
        }),
    )
    await tabFixture.message('local', {
      kind: 'cloud-action',
      action: 'connect',
      credentialRef: candidateRef,
    })
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `agnes.cloud.credential.v1:${tabFixture.remote}`,
          newValue: activeRef,
        }),
      )
    })
    pendingCancel?.(Response.json({ items: [] }))
    tabFetch.mockImplementationOnce(async () =>
      Response.json({
        items: [
          {
            id: activeRef,
            label: 'active',
            kind: 'api-key',
            createdAt: '2026-11-20T00:00:00Z',
            references: [],
          },
        ],
      }),
    )
    tabFetch.mockImplementationOnce(async () =>
      Response.json({
        token: tokenA,
        expiresAt: Date.now() + 3600000,
        proxied: true,
        origin: migratedOrigin,
      }),
    )
    await tabFixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: activeRef,
    })
    expect(new URL(tabFixture.frame('cloud').src).searchParams.get('session')).toBe('kept-session')
    expect(tabFixture.frame('cloud').dataset.backendOrigin).toBe(migratedOrigin)

    // Same-credential origin migration across tabs preserves the observing tab's selected session.
    const nextMigrated = 'https://8443-migrated-2.ap-shanghai.tencentags.com'
    bindCloudCredential(nextMigrated, activeRef, [{ id: activeRef }])
    localStorage.setItem('agnes.cloud.origin.v1', nextMigrated)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', newValue: nextMigrated }),
      )
    })
    expect(tabFixture.frame('cloud').dataset.backendOrigin).toBe(nextMigrated)
    expect(new URL(tabFixture.frame('cloud').src).searchParams.get('session')).toBe('kept-session')

    // Quota failure writing generation still invalidates cached capability via in-memory generation.
    expect(await authorizeRemoteFrontend(nextMigrated, new AbortController().signal, authFetch)).toContain(
      tokenB,
    )
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    })
    try {
      const callsBeforeQuota = calls
      window.dispatchEvent(
        new CustomEvent(CREDENTIALS_CHANGED, { detail: { mode: 'replace', id: activeRef } }),
      )
      bumpCloudCredentialGeneration(activeRef)
      await authorizeRemoteFrontend(nextMigrated, new AbortController().signal, authFetch)
      expect(calls).toBe(callsBeforeQuota + 1)
    } finally {
      setItemSpy.mockRestore()
    }

    // Replacing BOTH active A and candidate B while B's credential list is pending still recovers A on B's generation mismatch.
    let resolveBothList: ((response: Response) => void) | undefined
    tabFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveBothList = resolve
        }),
    )
    await tabFixture.message('local', {
      kind: 'cloud-action',
      action: 'connect',
      credentialRef: candidateRef,
    })
    await tabFixture.message('local', {
      kind: 'cloud-action',
      action: 'credential-replaced',
      credentialRef: activeRef,
    })
    expect(document.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    bumpCloudCredentialGeneration(candidateRef)
    tabFetch.mockImplementationOnce(async () =>
      Response.json({
        items: [
          {
            id: activeRef,
            label: 'active',
            kind: 'api-key',
            createdAt: '2026-11-20T00:00:00Z',
            references: [],
          },
        ],
      }),
    )
    tabFetch.mockImplementationOnce(async () =>
      Response.json({
        token: tokenB,
        expiresAt: Date.now() + 3600000,
        proxied: true,
        origin: nextMigrated,
      }),
    )
    await act(async () =>
      resolveBothList?.(
        Response.json({
          items: [
            {
              id: candidateRef,
              label: 'candidate',
              kind: 'api-key',
              createdAt: '2026-11-20T00:00:00Z',
              references: [],
            },
          ],
        }),
      ),
    )
    expect(tabFixture.frame('cloud').dataset.backendOrigin).toBe(nextMigrated)
  } finally {
    tabFetch.mockRestore()
    await tabFixture.close()
  }

  // Deduplicates rotation notifications across both StorageEvent -> BroadcastChannel and BroadcastChannel -> StorageEvent delivery orders.
  const seenGenerations: string[] = []
  const offSub = subscribeCloudCredentialReplacement((_ref, gen) => seenGenerations.push(gen))
  const peerChannel = new BroadcastChannel('agnes.cloud.credentials.v1')
  try {
    const genStorageFirst = `${Date.now().toString(36)}.storage-first`
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${refA}`,
        newValue: genStorageFirst,
      }),
    )
    peerChannel.postMessage({ kind: 'credential-replaced', credentialRef: refA, generation: genStorageFirst })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenGenerations).toEqual([genStorageFirst])

    const genBroadcastFirst = `${Date.now().toString(36)}.broadcast-first`
    peerChannel.postMessage({
      kind: 'credential-replaced',
      credentialRef: refA,
      generation: genBroadcastFirst,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${refA}`,
        newValue: genBroadcastFirst,
      }),
    )
    expect(seenGenerations).toEqual([genStorageFirst, genBroadcastFirst])
    // Persisted peer generation read before queued events invalidates cached capability immediately and still notifies listeners once when events arrive.
    bindCloudCredential(sandbox, refA, [{ id: refA }])
    expect(await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)).toContain(tokenA)
    const callsBeforePreEvent = calls
    const genPreEvent = `${Date.now().toString(36)}.pre-event`
    localStorage.setItem(`${CLOUD_CREDENTIAL_GENERATION_PREFIX}${refA}`, genPreEvent)
    await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)
    expect(calls).toBe(callsBeforePreEvent + 1)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${CLOUD_CREDENTIAL_GENERATION_PREFIX}${refA}`,
        newValue: genPreEvent,
      }),
    )
    peerChannel.postMessage({ kind: 'credential-replaced', credentialRef: refA, generation: genPreEvent })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenGenerations).toEqual([genStorageFirst, genBroadcastFirst, genPreEvent])
  } finally {
    peerChannel.close()
    offSub()
  }

  // Opening a private bookmark X (bound or unbound) in a second tab keeps X across shared Y disconnect/reconnect, neither overwrites Y on refresh nor broadcasts replacement on Disconnect, and follows Y once idle.
  function LiveCloudSettings() {
    const state = useSyncExternalStore(cloudSettingsState.subscribe, cloudSettingsState.read)
    return <CloudConnectionSettings state={state} onAction={requestCloudConnection} />
  }
  const privateOrigin = 'http://private-bookmark.test:8443'
  bindCloudCredential(privateOrigin, refA, [{ id: refA }])
  bindCloudCredential(sandbox, refA, [{ id: refA }])
  await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)
  const callsAfterSharedWarm = calls
  localStorage.setItem('agnes.cloud.origin.v1', sandbox)
  localStorage.setItem('agnes.cloud.auto-credential.v1', refA)
  const prevUrl = location.href
  const happy = (window as unknown as HappyWindow).happyDOM.settings
  const prevIframe = happy.disableIframePageLoading
  happy.disableIframePageLoading = true
  vi.stubGlobal('location', new URL(`http://127.0.0.1:4177/?remote=${encodeURIComponent(privateOrigin)}`))
  const bookmarkMeta = document.head.appendChild(document.createElement('meta'))
  bookmarkMeta.id = 'agnes-config'
  bookmarkMeta.dataset.cloudOrigin = 'http://127.0.0.1:4178'
  const bookmarkHost = document.body.appendChild(document.createElement('div'))
  bookmarkHost.id = 'app-root'
  const settingsHost = document.body.appendChild(document.createElement('div'))
  const offBookmarkProjection = installCloudSettingsProjection()
  const privateFetch = vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith('/admin/api/credentials')) throw new Error(`Unexpected discovery call: ${url}`)
    return Response.json({
      items: [
        { id: refA, label: 'private', kind: 'api-key', createdAt: '2026-11-20T00:00:00Z', references: [] },
      ],
    })
  })
  try {
    await act(async () => {
      mountBackendWorkbench()
      const region = createRegionRenderer(settingsHost)
      region.render(<LiveCloudSettings />)
      region.flush()
    })
    expect(cloudSettingsState.read()).toMatchObject({ origin: privateOrigin, credentialRef: refA })
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(sandbox)

    // Peer disconnecting Y -> null and reconnecting null -> Y leaves explicit private X untouched.
    localStorage.removeItem('agnes.cloud.origin.v1')
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', oldValue: sandbox, newValue: null }),
      )
    })
    expect(
      bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')?.getAttribute('data-backend-origin'),
    ).toBe(privateOrigin)
    localStorage.setItem('agnes.cloud.origin.v1', sandbox)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', oldValue: null, newValue: sandbox }),
      )
    })
    expect(
      bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')?.getAttribute('data-backend-origin'),
    ).toBe(privateOrigin)

    await act(async () => {
      requestCloudConnection({ action: 'credential-replaced', credentialRef: refA })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(privateFetch.mock.calls.map(([u]) => String(u))).toEqual(['/admin/api/credentials'])
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(sandbox)
    expect(localStorage.getItem('agnes.cloud.auto-credential.v1')).toBe(refA)
    expect(
      bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')?.getAttribute('data-backend-origin'),
    ).toBe(privateOrigin)

    // Even if peer moves shared CLOUD_ORIGIN_KEY to privateOrigin (X) before private tab X clicks Disconnect, disconnecting private X preserves X's shared binding and CLOUD_ORIGIN_KEY.
    await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)
    expect(calls).toBe(callsAfterSharedWarm + 1)
    const callsBeforePrivateDisconnect = calls
    localStorage.setItem('agnes.cloud.origin.v1', privateOrigin)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'agnes.cloud.origin.v1',
          oldValue: sandbox,
          newValue: privateOrigin,
        }),
      )
    })
    const disconnectBroadcasts: string[] = []
    const offDisconnectSub = subscribeCloudCredentialReplacement((_ref, gen) =>
      disconnectBroadcasts.push(gen),
    )
    try {
      await act(async () =>
        getByRole(settingsHost, 'button', { name: workbenchCatalog.en.disconnect }).click(),
      )
      expect(disconnectBroadcasts).toEqual([])
      expect(readCloudCredentialRef(privateOrigin)).toBe(refA)
      await authorizeRemoteFrontend(sandbox, new AbortController().signal, authFetch)
      expect(calls).toBe(callsBeforePrivateDisconnect)
    } finally {
      offDisconnectSub()
    }
    expect(bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(privateOrigin)
    expect(localStorage.getItem('agnes.cloud.auto-credential.v1')).toBe(refA)
    localStorage.setItem('agnes.cloud.origin.v1', sandbox)

    // Once private X is disconnected, this now-idle tab follows a subsequent Y -> null -> Y reconnect.
    localStorage.removeItem('agnes.cloud.origin.v1')
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', oldValue: sandbox, newValue: null }),
      )
    })
    localStorage.setItem('agnes.cloud.origin.v1', sandbox)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agnes.cloud.origin.v1', oldValue: null, newValue: sandbox }),
      )
    })
    expect(
      bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')?.getAttribute('data-backend-origin'),
    ).toBe(sandbox)

    // Unbound bookmark clicking its Disconnect button also leaves shared Y and CLOUD_DISCOVERY_KEY intact.
    await act(async () => unmountApplication(document))
    localStorage.setItem('agnes.cloud.auto-credential.v1', refB)
    vi.stubGlobal('location', new URL('http://127.0.0.1:4177/?remote=https%3A%2F%2Funbound-bookmark.test'))
    await act(async () => {
      mountBackendWorkbench()
      const region = createRegionRenderer(settingsHost)
      region.render(<LiveCloudSettings />)
      region.flush()
    })
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(sandbox)
    await act(async () => getByRole(settingsHost, 'button', { name: workbenchCatalog.en.disconnect }).click())
    expect(bookmarkHost.querySelector('[data-testid="backend-frame-cloud"]')).toBeNull()
    expect(localStorage.getItem('agnes.cloud.origin.v1')).toBe(sandbox)
    expect(localStorage.getItem('agnes.cloud.auto-credential.v1')).toBe(refB)
  } finally {
    privateFetch.mockRestore()
    await act(async () => unmountApplication(document))
    offBookmarkProjection()
    settingsHost.remove()
    bookmarkHost.remove()
    bookmarkMeta.remove()
    happy.disableIframePageLoading = prevIframe
    localStorage.clear()
    vi.stubGlobal('location', new URL(prevUrl))
  }
})
