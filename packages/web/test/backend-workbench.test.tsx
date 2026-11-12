// @vitest-environment happy-dom
import { mountApplication } from '@agnes/web-ui'
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RemoteFrontendFailure } from '../src/backend-selector.js'
import { CloudConnectionSettings } from '../src/backends/cloud-connection-settings.js'
import { type CloudConnectionAction, cloudConnectionAction } from '../src/backends/cloud-settings-bridge.js'
import * as frameContext from '../src/backends/frame-context.js'
import { type BackendSnapshot, backendCommand, backendSnapshot } from '../src/backends/frame-contract.js'
import { workbenchCatalog } from '../src/backends/workbench-locale.js'
import { WorkbenchSidebar } from '../src/backends/workbench-sidebar.js'
import { initialWorkbench, workbenchAddress } from '../src/backends/workbench-state.js'

let dispose: (() => void) | undefined
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterAll(() => vi.unstubAllGlobals())
afterEach(async () => {
  await act(async () => dispose?.())
  document.body.innerHTML = ''
  dispose = undefined
})

it('keeps identical session ids in separate collapsible local/cloud groups and routes the selected owner', async () => {
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
      <WorkbenchSidebar
        active="local"
        cloud="http://cloud.test:8443"
        states={{ local: snapshot, cloud: snapshot }}
        t={(key) => workbenchCatalog.en[key]}
        select={(...args) => selections.push(args)}
        command={(...args) => commands.push(args)}
        configure={() => {}}
      />,
    )
  })
  expect(host.querySelector('[data-agnes-region-unit="sidebar"]')).not.toBeNull()
  expect(host.querySelector('.brand-lockup .brand-wordmark-text')?.textContent).toBe('Agnes Harness')
  expect(host.querySelector('#new')?.getAttribute('aria-keyshortcuts')).toContain('Control+Shift+O')
  expect(host.querySelector('#new')?.classList.contains('agh-btn--primary')).toBe(false)
  expect(host.querySelector('#session-search kbd')).not.toBeNull()
  expect(host.querySelector('.sidebar-footer #settings')).not.toBeNull()
  const local = host.querySelector<HTMLButtonElement>('[data-testid="backend-session-local"] [data-session]')
  const cloud = host.querySelector<HTMLButtonElement>('[data-testid="backend-session-cloud"] [data-session]')
  expect(local?.getAttribute('aria-current')).toBe('page')
  expect(cloud?.getAttribute('aria-current')).toBeNull()
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
  await act(async () => host.querySelector<HTMLButtonElement>('#session-search')?.click())
  expect(commands.at(-1)).toEqual(['local', { kind: 'search' }])
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'O', ctrlKey: true, shiftKey: true, bubbles: true }),
    ),
  )
  expect(commands.at(-1)).toEqual(['local', { kind: 'new' }])
  const status = host.querySelector('[data-testid="cloud-connection-status"]')
  expect(status?.getAttribute('aria-label')).toBe('Ready')
  expect(status?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ready')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="backend-group-cloud"]')?.click())
  expect(status?.closest('[hidden]')).toBeNull()
  expect(
    [...host.querySelectorAll('button')].some((button) => button.textContent === 'Cloud connection'),
  ).toBe(false)
})

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
      <WorkbenchSidebar
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
  await act(async () => {
    dispose = mountApplication(
      host,
      <CloudConnectionSettings
        state={{ status: 'ready', origin: 'http://cloud.test:8443' }}
        onAction={(action) => actions.push(action)}
      />,
    )
  })
  const find = (text: string) =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === text)
  await act(async () => find('Save and connect')?.click())
  await act(async () => find('Reconnect')?.click())
  await act(async () => find('Disconnect cloud')?.click())
  expect(actions).toEqual([
    { action: 'connect', origin: 'http://cloud.test:8443' },
    { action: 'reconnect' },
    { action: 'disconnect' },
  ])
  const envelope = { type: 'agh.backend.frame/v1', kind: 'cloud-action', action: 'connect' }
  expect(cloudConnectionAction({ ...envelope, origin: 'https://user:secret@cloud.test' })).toBeUndefined()
  expect(cloudConnectionAction({ ...envelope, origin: 'https://cloud.test/path' })).toBeUndefined()
  expect(cloudConnectionAction({ ...envelope, origin: 'http://cloud.test:8443/' })).toEqual(actions[0])
})

it('shows only recovery guidance when a cloud page cannot start, keeping address inputs in settings', async () => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue(document.createElement('iframe'))
  const host = document.createElement('div')
  document.body.append(host)
  try {
    await act(async () => {
      dispose = mountApplication(host, <RemoteFrontendFailure message="unavailable" />)
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('unavailable')
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
