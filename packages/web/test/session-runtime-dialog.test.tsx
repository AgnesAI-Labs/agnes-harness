/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionApprovalGrant, SessionRuntimeDescriptor, SessionToolsResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createRuntimeDialog, RuntimeInfo } from '../src/session-runtime-dialog.js'
import {
  GRANT_RETRY_LIMIT,
  grantsFailure,
  groupTools,
  orderGrants,
  SessionGrantList,
  SessionToolList,
} from '../src/session-runtime-sections.js'
import { enT } from './helpers/locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The declarations of the first rule whose selector contains every given part. */
function cssRule(css: string, ...parts: string[]): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]?.replace(/\s+/g, ' ') ?? ''
    if (parts.every((part) => selector.includes(part))) return match[2] ?? ''
  }
  throw new Error(`no rule for ${parts.join(' + ')}`)
}

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

it('re-reads an open runtime summary after invalidation and ignores stale reads, other sessions and closed dialogs', async () => {
  const snapshot = (policy: string, principal: string) =>
    descriptor('gen-1', {
      policy: {
        approvalMode: 'manual',
        toolPolicy: 'default',
        toolRuntime: 'default',
        readOnly: false,
        sandbox: { provider: 'local', onUnavailable: 'deny' },
        permission: { policy, principal },
      },
    })
  let current = snapshot('full-access', 'first-chooser')
  const runtime = vi.fn(async (_id: string) => current)
  const error = vi.fn()
  const audited: import('@agnes/protocol').SessionIntegrityStatus = {
    state: 'verified',
    verifiedThroughSeq: 10,
    lastSeq: 10,
    legacyThroughSeq: 0,
    verifiedAtMs: 1000,
  }
  const integrity = vi.fn(async (_id: string, _verify?: boolean) => audited)
  const client = {
    session: {
      runtime,
      integrity,
    },
    approval: { sessionGrants: async () => ({ grants: [] }) },
    call: async () => ({ items: [], tools: [], resources: [] }),
  } as unknown as Client
  const dialog = createRuntimeDialog({ client, translate: enT, error, permissionOf: () => 'full-access' })
  const trigger = document.createElement('button')
  document.body.append(trigger)
  const summary = () => document.querySelector('[data-testid="session-runtime-summary"]')?.textContent ?? ''
  try {
    await act(async () => dialog.open('child', trigger))
    expect(summary()).toContain('first-chooser')
    let finishAudit!: (value: import('@agnes/protocol').SessionIntegrityStatus) => void
    integrity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAudit = resolve
        }),
    )
    await act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.session-runtime-dialog button')].find(
        (element) => element.textContent === enT('session.integrity.verify'),
      )
      expect(button).toBeDefined()
      button?.click()
    })
    expect(document.querySelector('.session-runtime-dialog')?.textContent).toContain(
      enT('session.integrity.verifying'),
    )
    expect(integrity).toHaveBeenLastCalledWith('child', true)
    await act(async () => {
      finishAudit(audited)
      await Promise.resolve()
    })

    current = { ...current, loaded: false }
    integrity.mockClear()
    await act(async () => dialog.invalidate('child'))
    expect(integrity).not.toHaveBeenCalled()

    current = snapshot('workspace-write', 'parent-owner')
    await act(async () => dialog.invalidate('unrelated'))
    expect(summary()).toContain('first-chooser')
    await act(async () => dialog.invalidate('child'))
    expect(summary()).toContain(enT('session.runtime.permission.workspace'))
    expect(summary()).not.toContain('first-chooser')
    let release!: (value: SessionRuntimeDescriptor) => void
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    let stale!: Promise<void> | undefined
    await act(async () => {
      stale = dialog.invalidate('child')
    })
    current = snapshot('full-access', 'replacement-chooser')
    await act(async () => dialog.invalidate('child'))
    await act(async () => {
      release(snapshot('full-access', 'stale-chooser'))
      await stale
    })
    expect(summary()).toContain('replacement-chooser')
    expect(summary()).not.toContain('stale-chooser')
    await act(async () => {
      const close = [...document.querySelectorAll<HTMLButtonElement>('.session-runtime-dialog button')].find(
        (button) => button.textContent === enT('session.runtime.close'),
      )
      expect(close).toBeDefined()
      close?.click()
    })
    current = snapshot('full-access', 'closed-chooser')
    await act(async () => dialog.invalidate('child'))
    expect(document.querySelector('dialog.react-dialog-host[open]')).toBeNull()
    expect(summary()).not.toContain('closed-chooser')
    expect(error).not.toHaveBeenCalled()
  } finally {
    await act(async () => dialog.dispose())
    trigger.remove()
  }
})

it('says that plugin panels and views are not pinned by the session generation', async () => {
  const view = await mount(createElement(RuntimeInfo, { runtime: descriptor('gen-1'), t: enT }))
  expect(view.host.textContent).toContain(enT('session.runtime.clientLive'))
  await view.render(createElement(RuntimeInfo, { runtime: descriptor(undefined), t: enT }))
  expect(view.host.textContent).not.toContain(enT('session.runtime.clientLive'))
  await view.close()
})

it('states loop, model, permission and version in plain words before any identifier', async () => {
  const runtime = descriptor('gen-1', {
    loop: { id: 'fde.knowledge-qa', version: '5.0.0' },
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
      loop: { value: { id: 'fde.knowledge-qa', version: '5.0.0' } },
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
  // A recipe is not a permission: the level the session list reports names what the session may do.
  const recipe = (permission?: string) => {
    const value = structuredClone(tools)
    ;(value.capabilities as { permissions: { preset: string } }).permissions.preset = 'ptc'
    return createElement(RuntimeInfo, { runtime, tools: value, permission, t: enT })
  }
  const policy = () =>
    [...view.host.querySelectorAll('[data-testid="session-runtime-summary"] *')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.startsWith(enT('session.runtime.policy')))
  await view.render(recipe('full-access'))
  expect(policy()).toContain(enT('session.runtime.permission.full'))
  await view.render(recipe())
  expect(policy()).toContain(enT('session.runtime.permission.preset').replace('{name}', 'ptc'))
  runtime.policy = {
    approvalMode: 'manual',
    toolPolicy: 'default',
    toolRuntime: 'default',
    readOnly: false,
    sandbox: { provider: 'local', onUnavailable: 'deny' },
    permission: { policy: 'full-access', principal: 'chooser' },
  }
  await view.render(recipe('workspace-write'))
  expect(policy()).toContain(enT('session.runtime.permission.full'))
  expect(policy()).toContain('chooser')
  runtime.policy.permission = { policy: 'workspace-write', principal: 'chooser' }
  await view.render(recipe('full-access'))
  expect(policy()).toContain(enT('session.runtime.permission.workspace'))
  runtime.policy.permission = { policy: '', principal: 'chooser' }
  await view.render(recipe('full-access'))
  expect(policy()).toContain(enT('session.runtime.permission.workspace'))
  // Identifiers stay available, under technical details.
  expect(view.host.querySelector('[data-testid="session-runtime-technical"]')?.textContent).toContain(
    'fde.knowledge-qa 5.0.0',
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

it('distinguishes native local execution from OS isolation without changing permission labels', async () => {
  const runtime = descriptor('gen-1', {
    policy: {
      toolPolicy: 'default',
      toolRuntime: 'default',
      readOnly: false,
      sandbox: {
        provider: 'local',
        onUnavailable: 'allow-if-unimplemented',
        enforcement: { level: 'partial', scope: ['file'] },
      },
    },
  })
  const view = await mount(createElement(RuntimeInfo, { runtime, t: enT }))
  expect(view.host.textContent).toContain(enT('session.runtime.noOsIsolation'))
  expect(view.host.textContent).toContain(enT('session.runtime.noOsIsolationHelp'))
  if (!runtime.policy) throw new Error('missing test policy')
  runtime.policy.sandbox.enforcement = { level: 'full', scope: ['file', 'network', 'process'] }
  await view.render(createElement(RuntimeInfo, { runtime, t: enT }))
  expect(view.host.textContent).not.toContain(enT('session.runtime.noOsIsolation'))
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

it('says why the allowances could not be read instead of hiding them (F09)', async () => {
  expect(grantsFailure({ code: -32006 })).toBe('denied')
  expect(grantsFailure(new Error('socket closed'))).toBe('unavailable')
  const retries: number[] = []
  const view = await mount(
    createElement(SessionGrantList, {
      grants: { failed: 'denied', retries: 0 },
      onRevoke() {},
      onRetry: () => retries.push(1),
      t: enT,
    }),
  )
  const failed = () => view.host.querySelector('[data-testid="session-runtime-grants-failed"]')
  expect(failed()?.textContent).toContain(enT('session.runtime.grantsDenied'))
  // A refusal is not something a retry fixes.
  expect(view.host.querySelector('[data-testid="session-runtime-grants-retry"]')).toBeNull()
  await view.render(
    createElement(SessionGrantList, {
      grants: { failed: 'unavailable', retries: 0 },
      onRevoke() {},
      onRetry: () => retries.push(1),
      t: enT,
    }),
  )
  expect(failed()?.textContent).toContain(enT('session.runtime.grantsUnavailable'))
  expect(failed()?.textContent).not.toContain(enT('session.runtime.grantsEmpty'))
  await act(async () =>
    view.host.querySelector<HTMLButtonElement>('[data-testid="session-runtime-grants-retry"]')?.click(),
  )
  expect(retries).toHaveLength(1)
  await view.render(
    createElement(SessionGrantList, {
      grants: { failed: 'unavailable', retries: GRANT_RETRY_LIMIT },
      onRevoke() {},
      onRetry() {},
      t: enT,
    }),
  )
  expect(failed()?.textContent).toContain(enT('session.runtime.grantsLater'))
  expect(view.host.querySelector('[data-testid="session-runtime-grants-retry"]')).toBeNull()
  await view.close()
})

it('retries a failed allowance read from the dialog until it succeeds or the limit is reached (F09)', async () => {
  const { createRuntimeDialog } = await import('../src/session-runtime-dialog.js')
  const { vi } = await import('vitest')
  const sessionGrants = vi
    .fn()
    .mockRejectedValueOnce(new Error('worker unavailable'))
    .mockResolvedValueOnce({ grants: [grant('shell')] })
  const client = {
    session: {
      runtime: async () => descriptor('gen-1'),
      integrity: async () => ({
        state: 'verified',
        verifiedThroughSeq: 10,
        lastSeq: 10,
        legacyThroughSeq: 0,
      }),
    },
    call: vi.fn(async () => ({ tools: [] })),
    approval: { sessionGrants },
  } as unknown as import('@agnes/sdk/browser').Client
  const dialog = createRuntimeDialog({ client, translate: enT, error: vi.fn() })
  await act(async () => dialog.open('s', document.createElement('button')))
  const failed = () => document.querySelector('[data-testid="session-runtime-grants-failed"]')
  await vi.waitFor(() => expect(failed()?.textContent).toContain(enT('session.runtime.grantsUnavailable')))
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid="session-runtime-grants-retry"]')?.click(),
  )
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="session-runtime-grant"]')).not.toBeNull(),
  )
  expect(sessionGrants).toHaveBeenCalledTimes(2)
  expect(failed()).toBeNull()
  // Each manual retry counts; after the limit the dialog asks to come back later.
  sessionGrants.mockRejectedValue(new Error('still down'))
  await act(async () => dialog.open('s', document.createElement('button')))
  for (let attempt = 0; attempt < GRANT_RETRY_LIMIT; attempt++) {
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="session-runtime-grants-retry"]')).not.toBeNull(),
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="session-runtime-grants-retry"]')?.click(),
    )
  }
  await vi.waitFor(() => expect(failed()?.textContent).toContain(enT('session.runtime.grantsLater')))
  expect(document.querySelector('[data-testid="session-runtime-grants-retry"]')).toBeNull()
  await act(async () => dialog.dispose())
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
      tool('review_diff', '@agnes-fde/knowledge-qa'),
      { ...tool('mcp__tracker__create', 'agnes/mcp-tracker'), deferred: true },
    ],
  } as SessionToolsResult
  expect(groupTools(tools.tools).map((group) => [group.source, group.tools.length, group.deferred])).toEqual([
    ['@agnes/base', 2, 0],
    ['@agnes-fde/knowledge-qa', 1, 0],
    ['agnes/mcp-tracker', 1, 1],
  ])
  const view = await mount(
    createElement(SessionToolList, { tools, failed: false, busy: false, onRefresh() {}, t: enT }),
  )
  expect(view.host.textContent).toContain(enT('session.runtime.toolsCount', { count: 4 }))
  expect(view.host.querySelectorAll('[data-testid="session-runtime-tool-group"]')).toHaveLength(3)
  expect(view.host.textContent).toContain(enT('session.runtime.toolsDeferred', { count: 1 }))
  await view.render(
    createElement(SessionToolList, { tools: undefined, failed: true, busy: false, onRefresh() {}, t: enT }),
  )
  expect(view.host.textContent).toContain(enT('session.runtime.toolsUnavailable'))
  // The list is a flex column, so rows keep their height instead of being squashed into overlap.
  const homePages = readFileSync(resolve(import.meta.dirname, '../public/styles/30-home-pages.css'), 'utf8')
  const groupList = cssRule(homePages, '.session-runtime-tool-groups')
  expect(groupList).toContain('display: flex')
  expect(groupList).toContain('flex-direction: column')
  expect(groupList).toContain('max-height: 17.5rem')
  expect(groupList).toContain('overflow-y: auto')
  expect(cssRule(homePages, '.session-runtime-tool-groups > *')).toContain('flex: 0 0 auto')
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
