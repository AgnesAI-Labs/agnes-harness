import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presetDefaults, SeamRuntime } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import type { ApprovalGrant } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalGrantBinding,
  bindApprovalGrantStore,
  createApprovalGrantControlPlane,
  createApprovalGrantStore,
} from '../src/runtime/approval/grants.js'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-approval-grants-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const profileHash = `sha256-${'a'.repeat(64)}`
const query: ApprovalGrantBinding = {
  profileHash,
  actorId: 'actor-1',
  actorOrg: 'org-1',
  toolId: 'computer',
  scope: 'cua:click:foreground',
  policyVersion: 'v1',
}
const grant: ApprovalGrant = {
  grantId: 'grant-1',
  ...query,
  sourceDecisionId: 'decision-1',
  issuer: { id: 'reviewer', org: 'org-1', role: 'user', deptPath: [], attrs: {} },
  definitionFingerprint: 'd'.repeat(64),
  policyBinding: 'e'.repeat(64),
  createdAt: '2026-09-17T00:00:00.000Z',
}
const GRANTS_DDL =
  'CREATE TABLE approval_grants (' +
  'grant_id TEXT PRIMARY KEY, profile_hash TEXT NOT NULL, actor_id TEXT NOT NULL, actor_org TEXT NOT NULL, ' +
  'tool_id TEXT NOT NULL, scope TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, ' +
  'source_decision_id TEXT NOT NULL, issuer TEXT NOT NULL, definition_fingerprint TEXT NOT NULL, policy_binding TEXT NOT NULL)'
const META_DDL =
  'CREATE TABLE approval_grant_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const INDEX_DDL =
  'CREATE INDEX approval_grants_binding ON approval_grants ' +
  '(profile_hash, actor_id, actor_org, tool_id, scope, policy_version, revoked_at)'

function open(root: string) {
  const storage = createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
  const tables = storage.tables('@agnes/host')
  return {
    storage,
    store: createApprovalGrantStore(tables),
    approval: bindApprovalGrantStore(fakeSeams().approval, tables),
  }
}

async function activate(opened: ReturnType<typeof open>, value: ApprovalGrant): Promise<void> {
  const put = opened.approval.putGrant
  if (!put) throw new Error('Host approval binding did not install putGrant')
  await put(value)
}

describe('Host approval grant store', () => {
  it('keeps the Core activation control plane off the public Host barrel', async () => {
    const publicHost = await import('@agnes/host')
    expect(publicHost).not.toHaveProperty('createApprovalGrantControlPlane')
    expect(publicHost).toHaveProperty('createApprovalGrantStore')
  })

  it('persists across reopen and matches every binding dimension exactly', async () => {
    const root = temp()
    const first = open(root)
    await activate(first, grant)
    await activate(first, grant)
    first.storage.close()

    const second = open(root)
    try {
      expect(second.store.list(query)).toEqual([grant])
      for (const changed of [
        { actorId: 'actor-2' },
        { actorOrg: 'org-2' },
        { profileHash: `sha256-${'b'.repeat(64)}` },
        { toolId: 'other-tool' },
        { scope: 'cua:type:foreground' },
        { policyVersion: 'v2' },
      ])
        expect(second.store.list({ ...query, ...changed })).toEqual([])
    } finally {
      second.storage.close()
    }
  })

  it('supports two open stores and keeps exact recovery puts idempotent', async () => {
    const root = temp()
    const left = open(root)
    const right = open(root)
    try {
      await activate(left, grant)
      await activate(right, grant)
      expect(right.store.list(query)).toEqual([grant])
      await expect(activate(right, { ...grant, createdAt: '2026-09-17T00:00:01.000Z' })).rejects.toThrow(
        /id collision/,
      )
    } finally {
      left.storage.close()
      right.storage.close()
    }
  })

  it('requires a reset for unversioned, old or future grant schemas', async () => {
    const compatibleRoot = temp()
    const compatibleStorage = createSqliteStorage({
      file: join(compatibleRoot, 'sessions.db'),
      tablesDir: join(compatibleRoot, 'tables'),
    })
    const compatibleTables = compatibleStorage.tables('@agnes/host')
    compatibleTables.table('approval_grants').exec(GRANTS_DDL)
    expect(() => createApprovalGrantStore(compatibleTables).list(query)).toThrow(/reset-required/)
    compatibleStorage.close()

    const missingRoot = temp()
    const missingStorage = createSqliteStorage({
      file: join(missingRoot, 'sessions.db'),
      tablesDir: join(missingRoot, 'tables'),
    })
    const missingTables = missingStorage.tables('@agnes/host')
    missingTables
      .table('approval_grants')
      .exec('CREATE TABLE approval_grants (grant_id TEXT PRIMARY KEY, profile_hash TEXT NOT NULL)')
    expect(() => createApprovalGrantStore(missingTables).list(query)).toThrow(/reset-required/)
    missingStorage.close()

    const futureRoot = temp()
    const futureStorage = createSqliteStorage({
      file: join(futureRoot, 'sessions.db'),
      tablesDir: join(futureRoot, 'tables'),
    })
    const futureTables = futureStorage.tables('@agnes/host')
    const future = futureTables.table('approval_grants')
    future.exec(
      'CREATE TABLE approval_grant_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
    )
    future.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, 99)')
    future.exec(GRANTS_DDL)
    future.exec(INDEX_DDL)
    expect(() => createApprovalGrantStore(futureTables).list(query)).toThrow(/reset-required/)
    futureStorage.close()
  })

  it('rejects malformed current-version table and metadata DDL', () => {
    const malformedRoot = temp()
    const malformedStorage = createSqliteStorage({
      file: join(malformedRoot, 'sessions.db'),
      tablesDir: join(malformedRoot, 'tables'),
    })
    const malformedTables = malformedStorage.tables('@agnes/host')
    const malformed = malformedTables.table('approval_grants')
    malformed.exec(META_DDL)
    malformed.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, 2)')
    malformed.exec(
      'CREATE TABLE approval_grants (' +
        'grant_id TEXT, profile_hash TEXT, actor_id TEXT, actor_org TEXT, tool_id TEXT, scope TEXT, ' +
        'policy_version TEXT, created_at TEXT, revoked_at TEXT)',
    )
    malformed.exec(INDEX_DDL)
    expect(() => createApprovalGrantStore(malformedTables).list(query)).toThrow(/reset-required/)
    malformedStorage.close()

    const malformedMetaRoot = temp()
    const malformedMetaStorage = createSqliteStorage({
      file: join(malformedMetaRoot, 'sessions.db'),
      tablesDir: join(malformedMetaRoot, 'tables'),
    })
    const malformedMetaTables = malformedMetaStorage.tables('@agnes/host')
    const malformedMeta = malformedMetaTables.table('approval_grants')
    malformedMeta.exec('CREATE TABLE approval_grant_meta (id INTEGER, version INTEGER)')
    malformedMeta.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, 2)')
    malformedMeta.exec(GRANTS_DDL)
    malformedMeta.exec(INDEX_DDL)
    expect(() => createApprovalGrantStore(malformedMetaTables).list(query)).toThrow(/reset-required/)
    malformedMetaStorage.close()
  })

  it('rejects missing or malformed binding indexes', () => {
    const missingIndexRoot = temp()
    const missingIndexStorage = createSqliteStorage({
      file: join(missingIndexRoot, 'sessions.db'),
      tablesDir: join(missingIndexRoot, 'tables'),
    })
    const missingIndexTables = missingIndexStorage.tables('@agnes/host')
    const missingIndex = missingIndexTables.table('approval_grants')
    missingIndex.exec(META_DDL)
    missingIndex.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, 2)')
    missingIndex.exec(GRANTS_DDL)
    expect(() => createApprovalGrantStore(missingIndexTables).list(query)).toThrow(/reset-required/)
    missingIndexStorage.close()

    const malformedIndexRoot = temp()
    const malformedIndexStorage = createSqliteStorage({
      file: join(malformedIndexRoot, 'sessions.db'),
      tablesDir: join(malformedIndexRoot, 'tables'),
    })
    const malformedIndexTables = malformedIndexStorage.tables('@agnes/host')
    const malformedIndex = malformedIndexTables.table('approval_grants')
    malformedIndex.exec(META_DDL)
    malformedIndex.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, 2)')
    malformedIndex.exec(GRANTS_DDL)
    malformedIndex.exec('CREATE INDEX approval_grants_binding ON approval_grants (grant_id)')
    expect(() => createApprovalGrantStore(malformedIndexTables).list(query)).toThrow(/reset-required/)
    malformedIndexStorage.close()
  })

  it('strictly rejects extra fields and impossible calendar dates', async () => {
    const root = temp()
    const opened = open(root)
    try {
      await expect(activate(opened, { ...grant, extra: true } as unknown as ApprovalGrant)).rejects.toThrow(
        /invalid approval grant fields/,
      )
      await expect(activate(opened, { ...grant, createdAt: '2026-02-30T00:00:00.000Z' })).rejects.toThrow(
        /invalid approval grant createdAt/,
      )
      expect(() => opened.store.list({ ...query, extra: true } as ApprovalGrantBinding)).toThrow(
        /invalid approval grant binding fields/,
      )
      expect(() => opened.store.list(Object.assign({ ...query }, { [Symbol('extra')]: true }))).toThrow(
        /invalid approval grant binding fields/,
      )
      const missing = { ...query } as Partial<ApprovalGrantBinding>
      delete missing.actorId
      expect(() => opened.store.list(missing as ApprovalGrantBinding)).toThrow(
        /invalid approval grant binding fields/,
      )
      for (const changed of [
        { issuer: { ...grant.issuer, role: 'agent' } },
        { definitionFingerprint: 'bad' },
        { policyBinding: 'bad' },
        { sourceDecisionId: '' },
      ])
        await expect(activate(opened, { ...grant, ...changed } as ApprovalGrant)).rejects.toThrow(
          /invalid approval grant/,
        )
      expect(Object.keys(opened.store).sort()).toEqual(['list', 'revoke'])
      expect('put' in opened.store).toBe(false)
      expect('revokeById' in opened.store).toBe(false)
      expect(opened.store.list(query)).toEqual([])
    } finally {
      opened.storage.close()
    }
  })

  it('requires the full binding to revoke and makes revocation visible on the next uncached read', async () => {
    const root = temp()
    const opened = open(root)
    const second = open(root)
    try {
      await activate(opened, grant)
      expect(
        second.store.revoke({ ...query, actorId: 'another-actor' }, grant.grantId, '2026-09-17T00:01:00Z'),
      ).toBeNull()
      expect(() =>
        second.store.revoke({ ...query, actorId: 'another-actor' }, grant.grantId, 'not-a-date'),
      ).toThrow(/invalid approval grant revokedAt/)
      expect(() => second.store.revoke(query, 'missing-grant', 'not-a-date')).toThrow(
        /invalid approval grant revokedAt/,
      )
      expect(opened.store.list(query)).toEqual([grant])
      expect(second.store.revoke(query, grant.grantId, '2026-09-17T00:01:00Z')).toEqual({
        ...grant,
        revokedAt: '2026-09-17T00:01:00Z',
      })
      expect(() => second.store.revoke(query, grant.grantId, '2026-02-30T00:00:00Z')).toThrow(
        /invalid approval grant revokedAt/,
      )
      await expect(activate(opened, grant)).rejects.toThrow(/id collision/)
      expect(opened.store.list(query)).toEqual([])
    } finally {
      opened.storage.close()
      second.storage.close()
    }
  })

  it('fans a durable bound revoke out to active seams and independent readers immediately', async () => {
    const root = temp()
    const firstStorage = createSqliteStorage({
      file: join(root, 'sessions.db'),
      tablesDir: join(root, 'tables'),
    })
    const secondStorage = createSqliteStorage({
      file: join(root, 'sessions.db'),
      tablesDir: join(root, 'tables'),
    })
    const first = createApprovalGrantControlPlane(firstStorage.tables('@agnes/host/approval-grants'))
    const second = createApprovalGrantControlPlane(secondStorage.tables('@agnes/host/approval-grants'))
    const seam = first.bind(fakeSeams().approval)
    const put = seam.putGrant
    if (!put) throw new Error('Host approval binding did not install putGrant')
    await put(grant)
    const grants: ApprovalGrant[] = []
    const ids: string[] = []
    const offManagement = first.management.onRevoked((value) => grants.push(value))
    const offSeam = seam.onGrantRevoked?.((grantId) => ids.push(grantId))
    let reentrantCalls = 0
    let resubscribed = false
    let offReentrant = () => {}
    const reentrant = () => {
      reentrantCalls += 1
      if (!resubscribed) {
        resubscribed = true
        offReentrant()
        offReentrant = first.management.onRevoked(reentrant)
      }
    }
    offReentrant = first.management.onRevoked(reentrant)
    first.management.onRevoked(() => {
      throw new Error('broken cache invalidator')
    })
    try {
      expect(
        first.management.revoke(
          { ...query, actorId: 'not-the-bound-actor' },
          grant.grantId,
          '2026-09-17T00:01:00Z',
        ),
      ).toBeNull()
      expect(grants).toEqual([])
      expect(ids).toEqual([])

      const revoked = first.management.revoke(query, grant.grantId, '2026-09-17T00:01:00Z')
      expect(revoked).toEqual({ ...grant, revokedAt: '2026-09-17T00:01:00Z' })
      expect(grants).toEqual([revoked])
      expect(ids).toEqual([grant.grantId])
      expect(reentrantCalls).toBe(1)
      expect(second.management.list(query)).toEqual([])

      // An idempotent repeat did not invalidate a second time, but still validates its timestamp.
      expect(first.management.revoke(query, grant.grantId, '2026-09-17T00:01:01Z')).toEqual(revoked)
      expect(grants).toHaveLength(1)
      expect(() => first.management.revoke(query, grant.grantId, 'not-a-date')).toThrow(
        /invalid approval grant revokedAt/,
      )
    } finally {
      offManagement()
      offSeam?.()
      offReentrant()
      firstStorage.close()
      secondStorage.close()
    }

    const reopened = open(root)
    try {
      expect(reopened.store.list(query)).toEqual([])
    } finally {
      reopened.storage.close()
    }
  })

  it('turns store failures into Core fail-closed answers', async () => {
    const root = temp()
    const storage = createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
    const failures: string[] = []
    const seams = fakeSeams()
    seams.approval = bindApprovalGrantStore(seams.approval, storage.tables('@agnes/host'))
    await storage.close()
    const runtime = new SeamRuntime(seams, presetDefaults(), {
      clock: () => 0,
      onFailure: (failure) => failures.push(`${failure.seam}.${failure.op}`),
    })
    const signal = new AbortController().signal
    await expect(runtime.approvalGrants(query, signal)).resolves.toEqual([])
    await expect(runtime.approvalPutGrant(grant, signal)).resolves.toBe(false)
    await expect(
      runtime.approvalRevokeGrant(grant.grantId, '2026-09-17T00:01:00Z', signal),
    ).resolves.toBeNull()
    expect(failures).toEqual(['approval.listGrants', 'approval.putGrant', 'approval.revokeGrant'])
  })

  it('composes the package revocation listener with the Host invalidation port', () => {
    const packageListeners = new Set<(grantId: string) => void>()
    const onGrantRevoked = (listener: (grantId: string) => void) => {
      packageListeners.add(listener)
      return () => packageListeners.delete(listener)
    }
    const seam = { ...fakeSeams().approval, onGrantRevoked }
    const root = temp()
    const storage = createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
    try {
      const bound = bindApprovalGrantStore(seam, storage.tables('@agnes/host'))
      const listener = vi.fn()
      const off = bound.onGrantRevoked?.(listener)
      for (const notify of packageListeners) notify('package-grant')
      expect(listener).toHaveBeenCalledWith('package-grant')
      off?.()
      expect(packageListeners).toHaveLength(0)
    } finally {
      void storage.close()
    }
  })

  it('preserves Host grant management when the package seam is fitted to a workspace', async () => {
    const fit = vi.fn(async () => fakeSeams().approval)
    const seam = Object.assign(fakeSeams().approval, { forWorkspace: fit })
    const root = temp()
    const storage = createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
    try {
      const bound = bindApprovalGrantStore(seam, storage.tables('@agnes/host'))
      const workspace = await bound.forWorkspace?.({ root: '/work/session-a' })
      expect(fit).toHaveBeenCalledWith({ root: '/work/session-a' })
      expect(workspace?.listGrants).toBeTypeOf('function')
      expect(workspace?.putGrant).toBeTypeOf('function')
      expect(workspace?.revokeGrant).toBeTypeOf('function')
    } finally {
      await storage.close()
    }
  })

  it('passes the resolved profile mode into the assembled Kernel', async () => {
    const dataDir = temp()
    const testHost = await createTestHost({
      dataDir,
      profileInputs: { user: { name: 'local-dev', approvals: { mode: 'auto-review' } } },
      disableSessionTitle: true,
    })
    try {
      expect((testHost.host.kernel as unknown as { o: { approvalMode?: string } }).o.approvalMode).toBe(
        'auto-review',
      )
    } finally {
      await testHost.host.close()
    }
  })

  it('wires the Host store into the approval seam and preserves grants across Host reopen', async () => {
    const dataDir = temp()
    const legacy = createSqliteStorage({
      file: join(dataDir, 'sessions.db'),
      tablesDir: join(dataDir, 'tables'),
    })
    const oldApproval = createApprovalGrantControlPlane(legacy.tables('@agnes/host/approval-grants')).bind(
      fakeSeams().approval,
    )
    if (!oldApproval.putGrant) throw new Error('activation port missing')
    await oldApproval.putGrant(grant)
    await legacy.close()
    const first = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      expect(first.host.approvalGrants.list(query)).toEqual([grant])
      const approval = (
        first.host.kernel as unknown as {
          o: { seams: { approval: { putGrant(value: ApprovalGrant): Promise<void> } } }
        }
      ).o.seams.approval
      await approval.putGrant(grant)
      expect(first.host.approvalGrants.list(query)).toEqual([grant])
    } finally {
      await first.host.close()
    }

    const second = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      const approval = (
        second.host.kernel as unknown as {
          o: { seams: { approval: { listGrants(value: ApprovalGrantBinding): Promise<ApprovalGrant[]> } } }
        }
      ).o.seams.approval
      await expect(approval.listGrants(query)).resolves.toEqual([grant])
      expect(second.host.approvalGrants.list(query)).toEqual([grant])
      second.host.approvalGrants.revoke(query, grant.grantId, '2026-10-07T00:00:00Z')
    } finally {
      await second.host.close()
    }
    const third = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      expect(third.host.approvalGrants.list(query)).toEqual([])
    } finally {
      await third.host.close()
    }
  })
})

it('persists metadata grants and revocation with exact bindings and malformed-row refusal', async () => {
  const { persistenceProvider } = await import(
    new URL('../../../examples/persistence/src/index.ts', import.meta.url).href
  )
  const root = temp()
  const first = await persistenceProvider.open({ dataDir: root })
  const ns = first.metadata.namespace('@agnes/host/approval-grants', 'grants')
  const control = createApprovalGrantControlPlane(ns)
  const fitted = control.bind(fakeSeams().approval)
  if (!fitted.putGrant) throw new Error('activation port missing')
  await fitted.putGrant(grant)
  await fitted.putGrant(grant)
  expect(control.management.list(query)).toEqual([grant])
  expect(control.management.list({ ...query, actorOrg: 'other' })).toEqual([])
  expect(
    control.management.revoke({ ...query, actorOrg: 'other' }, grant.grantId, '2026-10-07T00:00:00Z'),
  ).toBeNull()
  const notified: string[] = []
  control.management.onRevoked((row) => notified.push(row.grantId))
  control.management.revoke(query, grant.grantId, '2026-10-07T00:00:00Z')
  control.management.revoke(query, grant.grantId, '2026-10-07T01:00:00Z')
  expect(notified).toEqual([grant.grantId])
  await first.close()
  const second = await persistenceProvider.open({ dataDir: root })
  try {
    const durable = second.metadata.namespace('@agnes/host/approval-grants', 'grants')
    expect(createApprovalGrantStore(durable).list(query)).toEqual([])
    expect(durable.get(`grant:${grant.grantId}`)).toMatchObject({ revokedAt: '2026-10-07T00:00:00Z' })
    durable.set('grant:corrupt', { ...grant, grantId: 'other' })
    expect(() => createApprovalGrantStore(durable).list(query)).toThrow(/invalid metadata grant identity/)
  } finally {
    await second.close()
  }
})
