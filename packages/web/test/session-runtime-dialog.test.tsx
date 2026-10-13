/** @vitest-environment happy-dom */
import type { SessionApprovalGrant, SessionRuntimeDescriptor, SessionToolsResult } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RuntimeInfo } from '../src/session-runtime-dialog.js'
import {
  groupTools,
  orderGrants,
  SessionGrantList,
  SessionToolList,
} from '../src/session-runtime-sections.js'
import { enT } from './helpers/locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const descriptor = (id: string | undefined, extra: Partial<SessionRuntimeDescriptor> = {}) =>
  ({
    sessionKey: 's',
    loaded: true,
    generation: { id, current: false },
    providers: [],
    seams: [],
    restartRequired: [],
    ...extra,
  }) as unknown as SessionRuntimeDescriptor

const tool = (name: string, source: string) => ({
  name,
  source,
  description: '',
  parameters: {},
  deferred: false,
  readOnly: false,
})
const grant = (toolId: string, extra: Partial<SessionApprovalGrant> = {}) =>
  ({
    grantId: `g-${toolId}`,
    lifetime: 'session',
    toolId,
    scope: `tool:${toolId}:execute`,
    createdAt: '2026-10-14T01:00:00.000Z',
    ...extra,
  }) as SessionApprovalGrant

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  return {
    host,
    render: (next: ReturnType<typeof createElement>) => act(async () => root.render(next)),
    async close() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

it('says that plugin panels and views are not pinned by the session generation', async () => {
  const view = await mount(createElement(RuntimeInfo, { runtime: descriptor('gen-1'), t: enT }))
  expect(view.host.textContent).toContain(enT('session.runtime.clientLive'))
  await view.render(createElement(RuntimeInfo, { runtime: descriptor(undefined), t: enT }))
  expect(view.host.textContent).not.toContain(enT('session.runtime.clientLive'))
  await view.close()
})

it('states loop, model, permission and version in plain words before any identifier', async () => {
  const runtime = descriptor('gen-1', {
    loop: { id: 'fde.code-review', version: '5.0.0' },
    generation: {
      id: 'gen-1',
      current: false,
      state: 'historical',
      newer: { id: 'gen-2', effect: 'new-sessions' },
    },
  })
  const tools = {
    sessionId: 's',
    tools: [],
    resources: [],
    capabilities: {
      loop: { value: { id: 'fde.code-review', version: '5.0.0' } },
      modelRoutes: { value: { primary: { route: 'demo', model: 'demo-model' } } },
      permissions: { preset: 'workspace-write', readOnly: false },
      tools: [],
    },
  } as unknown as SessionToolsResult
  const view = await mount(
    createElement(RuntimeInfo, { runtime, tools, loopLabel: 'Code review example', t: enT }),
  )
  const summary = view.host.querySelector('[data-testid="session-runtime-summary"]')?.textContent ?? ''
  expect(summary).toContain('Code review example')
  expect(summary).toContain('demo-model')
  expect(summary).toContain(enT('session.runtime.permission.workspace'))
  expect(summary).toContain(enT('session.runtime.versionNewer'))
  expect(summary).not.toContain('gen-1')
  // Identifiers stay available, under technical details.
  expect(view.host.querySelector('[data-testid="session-runtime-technical"]')?.textContent).toContain(
    'fde.code-review 5.0.0',
  )
  await view.close()
})

it('falls back to the loop id and to unknown when the session is not open', async () => {
  const view = await mount(
    createElement(RuntimeInfo, {
      runtime: descriptor(undefined, { loaded: false, loop: { id: 'agnes.default', version: '1.0.0' } }),
      t: enT,
    }),
  )
  const summary = view.host.querySelector('[data-testid="session-runtime-summary"]')?.textContent ?? ''
  expect(summary).toContain('agnes.default')
  expect(summary).toContain(enT('session.runtime.unknown'))
  expect(summary).toContain(enT('session.runtime.versionCurrent'))
  await view.close()
})

it('puts session allowances before standing ones and drops revoked grants', () => {
  const result = orderGrants([
    grant('write', { lifetime: 'always', createdAt: '2026-10-14T03:00:00.000Z' }),
    grant('shell', { createdAt: '2026-10-14T01:00:00.000Z' }),
    grant('edit', { createdAt: '2026-10-14T02:00:00.000Z' }),
    grant('old', { revokedAt: '2026-10-13T00:00:00.000Z' }),
  ])
  expect(result.map((item) => item.toolId)).toEqual(['edit', 'shell', 'write'])
})

it('shows no section when the daemon cannot list what the session may do', async () => {
  const view = await mount(createElement(SessionGrantList, { grants: 'unavailable', onRevoke() {}, t: enT }))
  expect(view.host.textContent).toBe('')
  await view.close()
})

it('labels session and always allowances apart, revokes by grant id, and has an honest empty state', async () => {
  const revoked: string[] = []
  const view = await mount(
    createElement(SessionGrantList, {
      grants: [grant('shell'), grant('write', { lifetime: 'always' })],
      onRevoke: (value) => revoked.push(value.grantId),
      t: enT,
    }),
  )
  const rows = [...view.host.querySelectorAll<HTMLElement>('[data-testid="session-runtime-grant"]')]
  expect(rows.map((row) => row.dataset.lifetime)).toEqual(['session', 'always'])
  expect(rows[0]?.textContent).toContain(enT('session.runtime.grantSession'))
  expect(rows[1]?.textContent).toContain(enT('session.runtime.grantAlways'))
  expect(rows[1]?.textContent).toContain('other sessions')
  const buttons = view.host.querySelectorAll<HTMLElement>('[data-testid="session-runtime-grant-revoke"]')
  await act(async () => buttons[1]?.click())
  expect(revoked).toEqual(['g-write'])
  await view.render(createElement(SessionGrantList, { grants: [], onRevoke() {}, t: enT }))
  expect(view.host.textContent).toContain(enT('session.runtime.grantsEmpty'))
  await view.close()
})

it('groups the session tools by source and explains an unopened session', async () => {
  const tools = {
    sessionId: 's',
    resources: [],
    tools: [
      tool('read', '@agnes/base'),
      tool('edit', '@agnes/base'),
      tool('review_diff', '@agnes-fde/code-review'),
    ],
  } as SessionToolsResult
  expect(groupTools(tools.tools).map((group) => [group.source, group.tools.length])).toEqual([
    ['@agnes/base', 2],
    ['@agnes-fde/code-review', 1],
  ])
  const view = await mount(
    createElement(SessionToolList, { tools, failed: false, busy: false, onRefresh() {}, t: enT }),
  )
  expect(view.host.textContent).toContain(enT('session.runtime.toolsCount', { count: 3 }))
  expect(view.host.querySelectorAll('[data-testid="session-runtime-tool-group"]')).toHaveLength(2)
  await view.render(
    createElement(SessionToolList, { tools: undefined, failed: true, busy: false, onRefresh() {}, t: enT }),
  )
  expect(view.host.textContent).toContain(enT('session.runtime.toolsUnavailable'))
  await view.close()
})

it('retires pending descriptor reads when the runtime dialog is disposed', async () => {
  const { createRuntimeDialog } = await import('../src/session-runtime-dialog.js')
  const { vi } = await import('vitest')
  let resolve!: (value: SessionRuntimeDescriptor) => void
  const call = vi.fn()
  const sessionGrants = vi.fn()
  const error = vi.fn()
  const client = {
    session: {
      runtime: () =>
        new Promise<SessionRuntimeDescriptor>((done) => {
          resolve = done
        }),
    },
    call,
    approval: { sessionGrants },
  } as unknown as import('@agnes/sdk/browser').Client
  const dialog = createRuntimeDialog({ client, translate: enT, error })
  let opening!: Promise<void>
  await act(async () => {
    opening = dialog.open('s', document.createElement('button'))
  })
  await act(async () => dialog.dispose())
  await act(async () => {
    resolve(descriptor('gen-1'))
    await opening
  })
  expect(call).not.toHaveBeenCalled()
  expect(sessionGrants).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  expect(document.querySelector('[data-session-runtime]')).toBeNull()
})
