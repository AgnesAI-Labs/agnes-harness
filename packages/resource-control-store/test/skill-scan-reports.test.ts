import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ResourceListResult,
  ResourceOperation,
  ResourceOperationReceipt,
  SkillScanObservation,
} from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { SkillCatalogAdapter } from '../src/adapters.js'
import {
  createResourceControlService,
  createResourceControlStore,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
} from '../src/index.js'
import { checkedSkillScanObservation, SkillScanReports } from '../src/skill-scan-reports.js'

const authority = {
  audience: 'admin' as const,
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const profile = 'local-dev'
const scope = { allowedProfiles: [profile, 'other'] }
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const observation = (revision = 'a'): SkillScanObservation => ({
  configurationRevision: revision.repeat(64),
  complete: true,
  foundCount: 0,
  skippedCount: 0,
  unreadableDirectoryCount: 0,
  truncated: false,
  directories: [],
})
async function setup(refresh: SkillCatalogAdapter['refresh']) {
  const directory = await mkdtemp(join(tmpdir(), 'agh-skill-scan-report-'))
  directories.push(directory)
  const adapter = { refresh, reconcile: async () => [] }
  const reopen = () => createResourceControlService(createSkillResourceStore({ directory, scope, adapter }))
  return { directory, reopen, service: reopen() }
}
type Service = ReturnType<typeof createResourceControlService>
const list = async (s: Service, p = profile, workspaceId?: string) =>
  (await s.call(
    '_agnes/v1/resources.list',
    {
      profile: p,
      kind: 'skill',
      ...(workspaceId ? { workspaceId } : {}),
    },
    authority,
  )) as ResourceListResult
const refresh = async (s: Service, commandId: string, workspaceId?: string, p = profile) =>
  (await s.call(
    '_agnes/v1/skills.refresh',
    {
      profile: p,
      clientId: 'client',
      commandId,
      ...(workspaceId ? { workspaceId } : {}),
    },
    authority,
  )) as ResourceOperationReceipt
const settled = async (s: Service, id: string, p = profile) =>
  vi.waitFor(async () => {
    const op = (await s.call(
      '_agnes/v1/resources.operation.get',
      { profile: p, operationId: id },
      authority,
    )) as ResourceOperation
    expect(['succeeded', 'failed', 'cancelled']).toContain(op.state)
    return op
  })

it('publishes a report only after the refresh succeeds, without persisting it', async () => {
  const t = await setup(async () => ({
    candidates: [],
    failedRoots: [],
    skillScanObservation: observation(),
  }))
  const receipt = await refresh(t.service, 'scan')
  expect(await settled(t.service, receipt.operationId)).toMatchObject({ state: 'succeeded' })
  const result = await list(t.service)
  expect(result.skillScanReport).toMatchObject({
    operationId: receipt.operationId,
    generation: 1,
    ...observation(),
  })
  expect(result.skillScanReport?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  for (const file of await readdir(t.directory)) {
    if (file.endsWith('.json'))
      expect(await readFile(join(t.directory, file), 'utf8')).not.toContain('skillScan')
  }
  expect((await list(t.reopen())).skillScanReport).toBeUndefined()
})

it('fences same-configuration overlapping scans by their admission generation', async () => {
  let finish!: () => void
  let calls = 0
  const t = await setup(async () => {
    if (++calls === 1)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return { candidates: [], failedRoots: [], skillScanObservation: observation() }
  })
  const old = await refresh(t.service, 'old')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const current = await refresh(t.service, 'current')
  await settled(t.service, current.operationId)
  expect((await list(t.service)).skillScanReport).toMatchObject({
    operationId: current.operationId,
    generation: 2,
  })
  finish()
  await settled(t.service, old.operationId)
  expect((await list(t.service)).skillScanReport?.operationId).toBe(current.operationId)
})

it('keeps the previous report when a later scan is cancelled and isolates scopes', async () => {
  let blocked = false
  let finish!: () => void
  const t = await setup(async () => {
    if (blocked)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return { candidates: [], failedRoots: [], skillScanObservation: observation() }
  })
  const initial = await refresh(t.service, 'initial', 'a'.repeat(64))
  await settled(t.service, initial.operationId)
  expect((await list(t.service, profile, 'b'.repeat(64))).skillScanReport).toBeUndefined()
  expect((await list(t.service, 'other', 'a'.repeat(64))).skillScanReport).toBeUndefined()
  blocked = true
  const pending = await refresh(t.service, 'pending', 'a'.repeat(64))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await t.service.call(
    '_agnes/v1/resources.operation.cancel',
    { profile, clientId: 'client', commandId: 'cancel', operationId: pending.operationId },
    authority,
  )
  finish()
  expect(await settled(t.service, pending.operationId)).toMatchObject({ state: 'cancelled' })
  expect((await list(t.service, profile, 'a'.repeat(64))).skillScanReport?.operationId).toBe(
    initial.operationId,
  )
})

it('does not fabricate a report for old adapters and rejects inconsistent or secret-bearing reports', async () => {
  let observed: unknown
  const t = await setup(
    async () =>
      ({
        candidates: [],
        failedRoots: [],
        ...(observed === undefined ? {} : { skillScanObservation: observed }),
      }) as never,
  )
  const old = await refresh(t.service, 'legacy')
  await settled(t.service, old.operationId)
  expect((await list(t.service)).skillScanReport).toBeUndefined()
  for (const [i, value] of [
    { ...observation(), foundCount: 99 },
    { ...observation(), path: '/private/secret' },
  ].entries()) {
    observed = value
    const bad = await refresh(t.service, `bad-${i}`)
    expect(await settled(t.service, bad.operationId)).toMatchObject({ state: 'failed' })
    expect((await list(t.service)).skillScanReport).toBeUndefined()
  }
})

it('keeps report projection through the unified resource service and rejects read-only effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agh-skill-unified-scan-'))
  directories.push(directory)
  const service = createResourceControlService(
    createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => ({ candidates: [], failedRoots: [], skillScanObservation: observation() }),
        reconcile: async () => [],
      },
    }),
  )
  await expect(
    service.call(
      '_agnes/v1/skills.refresh',
      { profile, clientId: 'client', commandId: 'readonly' },
      {
        ...authority,
        permissions: ['resources.read'],
      },
    ),
  ).rejects.toMatchObject({
    data: { reason: 'resource administration requires server-granted admin authority' },
  })
  const receipt = await refresh(service, 'unified')
  expect(await settled(service, receipt.operationId)).toMatchObject({ state: 'succeeded' })
  expect((await list(service)).skillScanReport?.operationId).toBe(receipt.operationId)
  expect(
    await service.call('_agnes/v1/resources.list', { profile, kind: 'mcp' }, authority),
  ).not.toHaveProperty('skillScanReport')
})

it('fences A-to-B-to-A scans, bounds retained scopes, and returns immutable copies', () => {
  const reports = new SkillScanReports(2)
  const oldA = reports.begin(profile, undefined, 'old-a')
  const b = reports.begin(profile, undefined, 'b')
  reports.publish(b, observation('b'))
  const currentA = reports.begin(profile, undefined, 'current-a')
  reports.publish(currentA, observation())
  reports.publish(oldA, observation())
  expect(reports.read(profile)?.operationId).toBe('current-a')
  const copy = reports.read(profile)!
  copy.directories.length = 12
  expect(reports.read(profile)?.directories).toEqual([])
  reports.begin(profile, 'workspace-2', 'two')
  reports.begin('other', 'workspace-3', 'three')
  expect(reports.read(profile)).toBeUndefined()
  reports.publish(currentA, observation())
  expect(reports.read(profile)).toBeUndefined()
})

it('publishes a scan that finishes while a later scan of the same scope is still running', () => {
  const reports = new SkillScanReports()
  const previous = reports.begin(profile, undefined, 'previous')
  reports.publish(previous, observation())
  // A person's rescan begins; a watcher refresh of the same folders begins while it runs.
  const rescan = reports.begin(profile, undefined, 'rescan')
  const watcher = reports.begin(profile, undefined, 'watcher')
  reports.publish(rescan, observation('b'))
  expect(reports.read(profile)).toMatchObject({ operationId: 'rescan', generation: rescan.generation })
  reports.publish(watcher, observation('c'))
  expect(reports.read(profile)).toMatchObject({ operationId: 'watcher', generation: watcher.generation })
  // An earlier scan that settles last never replaces a later one.
  reports.publish(rescan, observation('b'))
  expect(reports.read(profile)?.operationId).toBe('watcher')
})

it('rejects excessive cross-directory detail, unsafe counts and false complete observations', () => {
  const issue = { code: 'invalid-frontmatter' as const, stage: 'parse' as const }
  const dir = {
    directoryId: 'b'.repeat(64),
    rootKey: 'user-agnes' as const,
    state: 'partial' as const,
    complete: true,
    foundCount: 0,
    skippedCount: 70,
    unreadable: false,
    truncated: false,
    issues: Array.from({ length: 70 }, () => issue),
  }
  expect(() =>
    checkedSkillScanObservation({
      ...observation(),
      skippedCount: 140,
      directories: [dir, { ...dir, directoryId: 'c'.repeat(64) }],
    }),
  ).toThrow('inconsistent')
  expect(() =>
    checkedSkillScanObservation({ ...observation(), foundCount: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow()
  expect(() => checkedSkillScanObservation({ ...observation(), complete: false })).toThrow('inconsistent')
})
