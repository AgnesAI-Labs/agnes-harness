/** @vitest-environment happy-dom */
import type { ApprovalGrantRecord, SessionRuntimeDescriptor, SessionToolsResult } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RuntimeInfo } from '../src/session-runtime-dialog.js'
import {
  defaultGrantBinding,
  groupTools,
  readSessionGrants,
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
const grant = (toolId: string, extra: Partial<ApprovalGrantRecord> = {}) =>
  ({ grantId: `g-${toolId}`, toolId, createdAt: '2026-10-14T01:00:00.000Z', ...extra }) as ApprovalGrantRecord

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

it('asks about each tool once with its default binding and drops revoked grants', async () => {
  const asked: string[] = []
  const result = await readSessionGrants(
    [tool('shell', 'a'), tool('edit', 'a'), tool('shell', 'b')],
    async (binding) => {
      expect(binding).toEqual(defaultGrantBinding(binding.toolId))
      asked.push(binding.toolId)
      return {
        grants:
          binding.toolId === 'shell'
            ? [grant('shell'), grant('shell', { grantId: 'old', revokedAt: '2026-10-13T00:00:00.000Z' })]
            : [],
      }
    },
  )
  expect(asked.sort()).toEqual(['edit', 'shell'])
  expect(result).toEqual([grant('shell')])
  expect(defaultGrantBinding('shell')).toEqual({
    toolId: 'shell',
    scope: 'tool:shell:execute',
    policyVersion: 'static-v1',
  })
})

it('reports grants as unavailable when the daemon refuses, and then shows no section', async () => {
  const result = await readSessionGrants([tool('shell', 'a')], async () => {
    throw new Error('CAPABILITY_DENIED')
  })
  expect(result).toBe('unavailable')
  const view = await mount(createElement(SessionGrantList, { grants: result, onRevoke() {}, t: enT }))
  expect(view.host.textContent).toBe('')
  await view.close()
})

it('lists remembered approvals with a revoke action each, and an honest empty state', async () => {
  const revoked: string[] = []
  const view = await mount(
    createElement(SessionGrantList, {
      grants: [grant('shell')],
      onRevoke: (value) => revoked.push(value.grantId),
      t: enT,
    }),
  )
  expect(view.host.querySelectorAll('[data-testid="session-runtime-grant"]')).toHaveLength(1)
  await act(async () =>
    view.host.querySelector<HTMLElement>('[data-testid="session-runtime-grant-revoke"]')?.click(),
  )
  expect(revoked).toEqual(['g-shell'])
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
