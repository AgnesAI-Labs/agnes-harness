import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ApprovalGrantsPort, presetDefaults, SeamRuntime } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import type { ApprovalGrant } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ApprovalGrantBinding,
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

const policyDigest = `sha256-${'a'.repeat(64)}`
const query: ApprovalGrantBinding = {
  policyDigest,
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
async function open(root: string) {
  const session = await sqlitePersistenceProvider.open({ dataDir: root })
  if (!session.metadata) throw new Error('metadata port missing')
  const ns = session.metadata.namespace('@agnes/host/approval-grants', 'grants')
  return {
    storage: { close: () => session.close() },
    store: createApprovalGrantStore(ns),
    grants: createApprovalGrantControlPlane(ns).port,
  }
}

async function activate(opened: Awaited<ReturnType<typeof open>>, value: ApprovalGrant): Promise<void> {
  await opened.grants.put(value)
}

describe('Host approval grant store', () => {
  it('keeps the Core activation control plane off the public Host barrel', async () => {
    const publicHost = await import('@agnes/host')
    expect(publicHost).not.toHaveProperty('createApprovalGrantControlPlane')
    expect(publicHost).toHaveProperty('createApprovalGrantStore')
    expect(publicHost).not.toHaveProperty('createSqliteComputerUseEffectStore')
    expect(publicHost).not.toHaveProperty('createSqliteLockedPackageOperationReceiptPort')
  })

  it('persists across reopen and matches every binding dimension exactly', async () => {
    const root = temp()
    const first = await open(root)
    await activate(first, grant)
    await activate(first, grant)
    await first.storage.close()

    const second = await open(root)
    try {
      expect(second.store.list(query)).toEqual([grant])
      for (const changed of [
        { actorId: 'actor-2' },
        { actorOrg: 'org-2' },
        { policyDigest: `sha256-${'b'.repeat(64)}` },
        { toolId: 'other-tool' },
        { scope: 'cua:type:foreground' },
        { policyVersion: 'v2' },
      ])
        expect(second.store.list({ ...query, ...changed })).toEqual([])
      // One holder's grants across every tool, and nobody else's: no tool has to be named.
      const holder = { policyDigest: query.policyDigest, actorId: query.actorId, actorOrg: query.actorOrg }
      const other = {
        ...grant,
        grantId: 'grant-2',
        toolId: 'other-tool',
        createdAt: '2026-09-18T00:00:00.000Z',
      }
      await activate(second, other)
      await activate(second, { ...grant, grantId: 'grant-3', actorId: 'actor-2' })
      expect(second.store.listHolder(holder)).toEqual([grant, other])
      for (const changed of [
        { actorId: 'actor-3' },
        { actorOrg: 'org-2' },
        { policyDigest: `sha256-${'b'.repeat(64)}` },
      ])
        expect(second.store.listHolder({ ...holder, ...changed })).toEqual([])
      expect(() => second.store.listHolder({ ...holder, policyDigest: 'not-a-digest' })).toThrow(
        /invalid approval grant policyDigest/,
      )
      second.store.revoke({ ...query, toolId: 'other-tool' }, 'grant-2', '2026-09-19T00:00:00.000Z')
      expect(second.store.listHolder(holder)).toEqual([grant])
    } finally {
      await second.storage.close()
    }
  })

  it('supports two open stores and keeps exact recovery puts idempotent', async () => {
    const root = temp()
    const left = await open(root)
    const right = await open(root)
    try {
      await activate(left, grant)
      await activate(right, grant)
      expect(right.store.list(query)).toEqual([grant])
      await expect(activate(right, { ...grant, createdAt: '2026-09-17T00:00:01.000Z' })).rejects.toThrow(
        /id collision/,
      )
    } finally {
      await left.storage.close()
      await right.storage.close()
    }
  })

  it('requires a reset for a metadata store of another version or with grants but no version', async () => {
    const session = await sqlitePersistenceProvider.open({ dataDir: temp() })
    try {
      if (!session.metadata) throw new Error('metadata port missing')
      const future = session.metadata.namespace('@agnes/host/approval-grants', 'future')
      future.set('version', 99)
      expect(() => createApprovalGrantStore(future).list(query)).toThrow(
        /reset-required: E_APPROVAL_GRANT_SCHEMA_VERSION/,
      )
      const unversioned = session.metadata.namespace('@agnes/host/approval-grants', 'unversioned')
      unversioned.set('grant:x', { ...grant, grantId: 'x' })
      expect(() => createApprovalGrantStore(unversioned).list(query)).toThrow(
        /reset-required: unversioned approval grant metadata/,
      )
      expect(unversioned.get('version')).toBeUndefined()
    } finally {
      await session.close()
    }
  })

  it('strictly rejects extra fields and impossible calendar dates', async () => {
    const root = temp()
    const opened = await open(root)
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
      expect(Object.keys(opened.store).sort()).toEqual(['list', 'listHolder', 'revoke'])
      expect('put' in opened.store).toBe(false)
      expect('revokeById' in opened.store).toBe(false)
      expect(opened.store.list(query)).toEqual([])
    } finally {
      await opened.storage.close()
    }
  })

  it('requires the full binding to revoke and makes revocation visible on the next uncached read', async () => {
    const root = temp()
    const opened = await open(root)
    const second = await open(root)
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
      await opened.storage.close()
      await second.storage.close()
    }
  })

  it('fans a durable bound revoke out to active seams and independent readers immediately', async () => {
    const root = temp()
    const firstStorage = await sqlitePersistenceProvider.open({ dataDir: root })
    const secondStorage = await sqlitePersistenceProvider.open({ dataDir: root })
    if (!firstStorage.metadata || !secondStorage.metadata) throw new Error('metadata port missing')
    const first = createApprovalGrantControlPlane(
      firstStorage.metadata.namespace('@agnes/host/approval-grants', 'grants'),
    )
    const second = createApprovalGrantControlPlane(
      secondStorage.metadata.namespace('@agnes/host/approval-grants', 'grants'),
    )
    await first.port.put(grant)
    const grants: ApprovalGrant[] = []
    const offManagement = first.management.onRevoked((value) => grants.push(value))
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

      const revoked = first.management.revoke(query, grant.grantId, '2026-09-17T00:01:00Z')
      expect(revoked).toEqual({ ...grant, revokedAt: '2026-09-17T00:01:00Z' })
      expect(grants).toEqual([revoked])
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
      offReentrant()
      await firstStorage.close()
      await secondStorage.close()
    }

    const reopened = await open(root)
    try {
      expect(reopened.store.list(query)).toEqual([])
    } finally {
      await reopened.storage.close()
    }
  })

  it('turns store failures into Core fail-closed answers', async () => {
    const root = temp()
    const session = await sqlitePersistenceProvider.open({ dataDir: root })
    if (!session.metadata) throw new Error('metadata port missing')
    const failures: string[] = []
    const port = createApprovalGrantControlPlane(
      session.metadata.namespace('@agnes/host/approval-grants', 'grants'),
    ).port
    await session.close()
    const runtime = new SeamRuntime(fakeSeams(), presetDefaults(), {
      clock: () => 0,
      onFailure: (failure) => failures.push(`${failure.seam}.${failure.op}`),
      approvalGrants: port,
    })
    const signal = new AbortController().signal
    await expect(runtime.approvalGrants(query, signal)).resolves.toEqual([])
    await expect(runtime.approvalPutGrant(grant, signal)).resolves.toBe(false)
    expect(failures).toEqual(['approval.listGrants', 'approval.putGrant'])
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

  it('wires the Host store into the Kernel grants port and preserves grants across Host reopen', async () => {
    const dataDir = temp()
    const first = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      const port = (first.host.kernel as unknown as { o: { approvalGrants: ApprovalGrantsPort } }).o
        .approvalGrants
      await port.put(grant)
      expect(first.host.approvalGrants.list(query)).toEqual([grant])
      await port.put(grant)
      expect(first.host.approvalGrants.list(query)).toEqual([grant])
    } finally {
      await first.host.close()
    }

    const second = await createTestHost({ dataDir, disableSessionTitle: true })
    try {
      const port = (second.host.kernel as unknown as { o: { approvalGrants: ApprovalGrantsPort } }).o
        .approvalGrants
      await expect(port.list(query)).resolves.toEqual([grant])
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
  await control.port.put(grant)
  await control.port.put(grant)
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
