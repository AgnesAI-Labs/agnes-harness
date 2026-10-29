/** @vitest-environment happy-dom */
import type { SkillScanReport } from '@agnes/protocol'
import type { ResourceAdminMount } from '@agnes/resource-control-web/admin'
import { installFeedbackSink, type OperationFeedback } from '@agnes/web-ui'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mountAdminWorkbench } from './legacy-admin-panes.js'

let mount: ResourceAdminMount | undefined
let workbench: Awaited<ReturnType<typeof mountAdminWorkbench>> | undefined
let release: (() => void) | undefined
function currentMount(): ResourceAdminMount {
  if (!mount) throw new Error('Resource controller did not mount.')
  return mount
}
const report: SkillScanReport = {
  operationId: 'scan-1',
  generation: 1,
  observedAt: '2026-10-29T08:00:00.000Z',
  configurationRevision: 'a'.repeat(64),
  complete: true,
  foundCount: 0,
  skippedCount: 0,
  unreadableDirectoryCount: 0,
  truncated: false,
  directories: [],
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeAll(async () => {
  await import('@agnes/resource-control-web/admin')
}, 60_000)
afterEach(async () => {
  mount?.dispose()
  await workbench?.runtime.dispose()
  release?.()
  vi.unstubAllGlobals()
  document.documentElement.replaceChildren()
})
async function setup(
  options: {
    operation?: Promise<Response>
    afterScan?: Promise<Response>
    initialReport?: SkillScanReport
    listPages?: Array<Response | Promise<Response>>
    readOnly?: boolean
    disconnectPoll?: boolean
    refresh?: Promise<Response>
    scanIds?: string[]
  } = {},
) {
  const feedback: OperationFeedback[] = []
  const reports: Array<SkillScanReport | undefined> = []
  const requests: string[] = []
  const requestBodies: Array<{ path: string; body: Record<string, unknown> }> = []
  let started = false
  release = installFeedbackSink({ publish: (value) => feedback.push(value), resolve() {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.replace('/admin/resources/api/', '')
      requests.push(path)
      requestBodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (path === 'context')
        return Response.json({
          profile: 'default',
          clientId: 'test',
          permissions: [],
          readOnly: options.readOnly ?? false,
        })
      if (path === 'skills/refresh') {
        started = true
        return options.refresh ?? Response.json({ operationId: options.scanIds?.shift() ?? 'scan-1' })
      }
      if (path === 'operations/get' && options.disconnectPoll) throw new Error('private network detail')
      if (path === 'operations/get' && init?.body && JSON.parse(String(init.body)).operationId === 'scan-2')
        return Response.json({
          operationId: 'scan-2',
          kind: '_agnes/v1/skills.refresh',
          target: 'skill/all',
          state: 'succeeded',
        })
      if (path === 'operations/get')
        return (
          options.operation ??
          Response.json({
            operationId: 'scan-1',
            kind: '_agnes/v1/skills.refresh',
            target: 'skill/all',
            state: 'succeeded',
          })
        )
      if (path === 'skills/list' && options.listPages?.length)
        return (await options.listPages.shift())?.clone()
      if (path === 'skills/list')
        return started && options.afterScan
          ? (await options.afterScan).clone()
          : Response.json({
              items: [],
              ...(options.initialReport ? { skillScanReport: options.initialReport } : {}),
            })
      if (path === '/api/triggers')
        return Response.json({
          snapshot: {
            config: { enabled: false, path: '/hooks/events', maxPayloadBytes: 65536 },
            rules: [],
            deliveries: [],
            secretRefs: [],
          },
        })
      return Response.json({ items: [] })
    }),
  )
  const { mountResourceAdmin } = await import('@agnes/resource-control-web/admin')
  workbench = await mountAdminWorkbench({
    mountResources: async (scope) => {
      mount = mountResourceAdmin({ ...scope, onSkillScanReport: (value) => reports.push(value) })
      return mount
    },
  })
  await workbench.open('resources', 'skills')
  await currentMount().ready
  return { feedback, reports, requests, requestBodies }
}
it('waits for the matching post-operation report before publishing scan completion', async () => {
  const operation = deferred<Response>()
  const page = deferred<Response>()
  const view = await setup({ operation: operation.promise, afterScan: page.promise })
  const scanning = currentMount().scanSkills()
  await vi.waitFor(() => expect(view.requests).toContain('operations/get'))
  expect(view.feedback).toEqual([])
  expect(document.getElementById('admin-confirm')?.hasAttribute('open')).toBe(false)
  operation.resolve(
    Response.json({
      operationId: 'scan-1',
      kind: '_agnes/v1/skills.refresh',
      target: 'skill/all',
      state: 'succeeded',
    }),
  )
  await vi.waitFor(() => expect(view.requests.filter((path) => path === 'skills/list')).toHaveLength(2))
  expect(view.feedback).toEqual([])
  page.resolve(Response.json({ items: [], skillScanReport: report }))
  await expect(scanning).resolves.toEqual(report)
  expect(view.reports.at(-1)).toEqual(report)
  expect(view.feedback).toHaveLength(1)
})
it.each([undefined, { ...report, operationId: 'older-scan' }])(
  'does not fabricate scan success for missing or older reports',
  async (value) => {
    const view = await setup({
      afterScan: Promise.resolve(Response.json({ items: [], ...(value ? { skillScanReport: value } : {}) })),
    })
    await expect(currentMount().scanSkills()).resolves.toBeUndefined()
    expect(view.feedback).toEqual([])
  },
)
it('rejects a cancelled scan and preserves the absence of a new report', async () => {
  const view = await setup({
    operation: Promise.resolve(
      Response.json({
        operationId: 'scan-1',
        kind: '_agnes/v1/skills.refresh',
        target: 'skill/all',
        state: 'cancelled',
      }),
    ),
  })
  await expect(currentMount().scanSkills()).rejects.toThrow()
  expect(view.feedback).toEqual([])
  expect(view.reports.filter(Boolean)).toEqual([])
})
it('rejects scans in read-only mode without submitting an operation', async () => {
  const view = await setup({ readOnly: true })
  await expect(currentMount().scanSkills()).rejects.toThrow()
  expect(view.requests).not.toContain('skills/refresh')
})
it('clears reports and ignores late completion after changing workspace', async () => {
  const operation = deferred<Response>()
  const view = await setup({
    operation: operation.promise,
    afterScan: Promise.resolve(Response.json({ items: [], skillScanReport: report })),
  })
  const scanning = currentMount().scanSkills()
  await vi.waitFor(() => expect(view.requests).toContain('operations/get'))
  await currentMount().sync({ tab: 'skills', workspaceId: 'b'.repeat(64) })
  const before = view.reports.length
  operation.resolve(
    Response.json({
      operationId: 'scan-1',
      kind: '_agnes/v1/skills.refresh',
      target: 'skill/all',
      state: 'succeeded',
    }),
  )
  await expect(scanning).rejects.toThrow()
  expect(view.reports).toHaveLength(before)
  expect(view.feedback).toEqual([])
})

it('surfaces connection loss without a successful scan result', async () => {
  const view = await setup({ disconnectPoll: true })
  await expect(currentMount().scanSkills()).rejects.toThrow()
  expect(view.feedback).toEqual([])
})

it('does not submit duplicate scans while the first receipt is pending', async () => {
  const pending = deferred<Response>()
  const view = await setup({ refresh: pending.promise })
  const first = currentMount().scanSkills()
  const second = currentMount()
    .scanSkills()
    .then(
      () => 'accepted',
      () => 'rejected',
    )
  pending.resolve(Response.json({ operationId: 'scan-1' }))
  await first
  expect(await second).toBe('rejected')
  expect(view.requests.filter((path) => path === 'skills/refresh')).toHaveLength(1)
  expect(view.feedback).toEqual([])
})

it('allows the new workspace to scan while an old workspace operation is pending', async () => {
  const operation = deferred<Response>()
  const view = await setup({
    scanIds: ['scan-1', 'scan-2'],
    operation: operation.promise,
    afterScan: Promise.resolve(
      Response.json({ items: [], skillScanReport: { ...report, operationId: 'scan-2' } }),
    ),
  })
  const old = currentMount()
    .scanSkills()
    .then(
      () => 'accepted',
      () => 'rejected',
    )
  await vi.waitFor(() => expect(view.requests).toContain('operations/get'))
  await currentMount().sync({ tab: 'skills', workspaceId: 'b'.repeat(64) })
  const next = currentMount().scanSkills()
  operation.resolve(
    Response.json({
      operationId: 'scan-1',
      kind: '_agnes/v1/skills.refresh',
      target: 'skill/all',
      state: 'succeeded',
    }),
  )
  await expect(next).resolves.toMatchObject({ operationId: 'scan-2' })
  expect(await old).toBe('rejected')
  expect(view.requests.filter((path) => path === 'skills/refresh')).toHaveLength(2)
})

it('does not show an old manual scan failure in the newly selected workspace', async () => {
  const operation = deferred<Response>()
  const view = await setup({ operation: operation.promise })
  document.getElementById('skill-refresh')?.click()
  await vi.waitFor(() => expect(document.getElementById('admin-confirm')?.hasAttribute('open')).toBe(true))
  document.getElementById('admin-confirm-action')?.click()
  await vi.waitFor(() => expect(view.requests).toContain('operations/get'))
  await currentMount().sync({ tab: 'skills', workspaceId: 'b'.repeat(64) })
  operation.resolve(
    Response.json({
      operationId: 'scan-1',
      kind: '_agnes/v1/skills.refresh',
      target: 'skill/all',
      state: 'cancelled',
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(document.getElementById('resource-notice')?.textContent).toBe('')
})

it('accepts the matching scan report when daemon restart resets the server generation', async () => {
  const previous = { ...report, operationId: 'before-restart', generation: 20 }
  const view = await setup({
    initialReport: previous,
    afterScan: Promise.resolve(Response.json({ items: [], skillScanReport: report })),
  })
  expect(view.reports.at(-1)).toEqual(previous)
  await expect(currentMount().scanSkills()).resolves.toEqual(report)
  expect(view.reports.at(-1)).toEqual(report)
  expect(view.feedback).toHaveLength(1)
})

it('rejects a scan until the new workspace is ready when an old list read is pending', async () => {
  const oldRead = deferred<Response>()
  const nextReport = { ...report, operationId: 'workspace-b-report' }
  const view = await setup({
    listPages: [
      Response.json({ items: [] }),
      Response.json({ items: [] }),
      oldRead.promise,
      Response.json({ items: [], skillScanReport: nextReport }),
    ],
  })
  await currentMount().sync({ tab: 'skills', workspaceId: 'a'.repeat(64) })
  const reading = currentMount().reload()
  await vi.waitFor(() => expect(view.requests.filter((path) => path === 'skills/list')).toHaveLength(3))
  const switching = currentMount().sync({ tab: 'skills', workspaceId: 'b'.repeat(64) })
  const scanning = currentMount()
    .scanSkills()
    .then(
      () => 'accepted',
      () => 'rejected',
    )
  oldRead.resolve(
    Response.json({ items: [], skillScanReport: { ...report, operationId: 'late-a', generation: 20 } }),
  )
  await Promise.all([reading, switching])
  expect(await scanning).toBe('rejected')
  expect(view.requests).not.toContain('skills/refresh')
  expect(view.reports.at(-1)).toEqual(nextReport)
  await currentMount().scanSkills()
  expect(view.requestBodies.filter(({ path }) => path === 'skills/refresh').at(-1)?.body.workspaceId).toBe(
    'b'.repeat(64),
  )
})

it('ignores an old list response across an A to B to A scope round trip', async () => {
  const oldRead = deferred<Response>()
  const nextReport = { ...report, operationId: 'current-a' }
  const view = await setup({
    listPages: [
      Response.json({ items: [] }),
      Response.json({ items: [] }),
      oldRead.promise,
      Response.json({ items: [], skillScanReport: nextReport }),
    ],
  })
  await currentMount().sync({ tab: 'skills', workspaceId: 'a'.repeat(64) })
  const reading = currentMount().reload()
  await vi.waitFor(() => expect(view.requests.filter((path) => path === 'skills/list')).toHaveLength(3))
  const leaving = currentMount().sync({ tab: 'skills', workspaceId: 'b'.repeat(64) })
  const returning = currentMount().sync({ tab: 'skills', workspaceId: 'a'.repeat(64) })
  const before = view.reports.length
  oldRead.resolve(
    Response.json({ items: [], skillScanReport: { ...report, operationId: 'late-a', generation: 20 } }),
  )
  await Promise.all([reading, leaving, returning])
  expect(view.reports.slice(before).filter(Boolean)).toEqual([nextReport])
})
