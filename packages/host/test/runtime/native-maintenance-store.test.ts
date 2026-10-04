import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJsonDigest, type MaintenanceStoreCommitRequest } from '@agnes/protocol/runtime'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'
import {
  createNativeMaintenanceOwner,
  isNativeMaintenanceOwner,
  openNativeMaintenanceHistory,
} from '../../src/runtime/maintenance/native-store.js'

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-maintenance-')))
  const deploymentDirectory = join(root, 'deployment')
  const anchor = createBootstrapAnchor(deploymentDirectory, {
    principalRef: 'not-an-identity-proof',
    locator: {
      directoryId: 'directory',
      providerLockRef: inlineData({ locator: true }, 'agh.maintenance/provider-lock@1'),
      endpointRef: deploymentDirectory,
      epoch: 1,
      revision: 1,
      cutoverId: 'cutover',
    },
  })
  if (!anchor.ok) throw new Error(anchor.error.detailCode)
  const file = join(deploymentDirectory, 'state.sqlite')
  closeSync(createPrivateFileSync(file))
  const database = new DatabaseSync(file)
  let hook: (() => void) | undefined
  const authority = { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 }
  const options = {
    database,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory }),
    authority,
    scope: {
      kind: 'session' as const,
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    now: () => {
      hook?.()
      return Date.parse('2026-10-04T00:00:00Z')
    },
  }
  const identity = createLocalDeploymentIdentity(options)
  const connection = await identity.connect(new AbortController().signal)
  const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
  const claims = connection.actor.identity.claims
  if (claims.kind !== 'inline') throw new Error('Original inline local claims are required')
  const request: MaintenanceStoreCommitRequest = {
    transactionId: 'technical-commit',
    authority,
    expectedWriterEpoch: 1,
    outbox: [],
    mutations: [
      {
        recordId: 'technical-claims',
        expectedRevision: null,
        next: {
          recordId: 'technical-claims',
          revision: 1,
          writerEpoch: 1,
          createdAt: '2026-10-04T00:00:00Z',
          updatedAt: '2026-10-04T00:00:00Z',
          schema: claims.schema,
          payload: claims.value,
          fingerprint: canonicalJsonDigest(claims.value),
        },
      },
    ],
  }
  return {
    database,
    options,
    identity,
    context,
    request,
    file,
    clock(value?: () => void) {
      hook = value
    },
    close() {
      identity.close()
      if (database.isOpen) database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
function changes(database: DatabaseSync) {
  return database.prepare('SELECT total_changes() AS n').get()?.n
}

describe.skipIf(typeof process.getuid !== 'function')('original native technical maintenance owner', () => {
  it('uses the real same-connection C14, original official commit and pointer-only receipt; replay writes nothing', async () => {
    const f = await fixture()
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      expect(isNativeMaintenanceOwner(owner)).toBe(true)
      expect(isNativeMaintenanceOwner({ ...owner })).toBe(false)
      const result = owner.commit(f.request, f.context)
      expect(result.revisions).toEqual([{ recordId: 'technical-claims', revision: 1 }])
      expect(owner.readOriginalReceipt(result).request).toEqual(f.request)
      expect(() => owner.readOriginalReceipt({ ...result })).toThrow()
      const before = changes(f.database)
      expect(owner.commit(f.request, f.context)).toEqual(result)
      expect(changes(f.database)).toBe(before)
      expect(() => owner.commit({ ...f.request, expectedWriterEpoch: 2 }, f.context)).toThrow()
      expect(() => owner.commit(f.request, { ...f.context })).toThrow()
      const conflict = structuredClone(f.request)
      const mutation = conflict.mutations[0]
      if (!mutation) throw new Error('Original mutation is required')
      mutation.next.updatedAt = '2026-10-04T00:00:01Z'
      expect(() => owner.commit(conflict, f.context)).toThrow()
      expect(changes(f.database)).toBe(before)
    } finally {
      f.close()
    }
  })
  it('records the original empty slot once and refuses pre-slot C14 installations without a schema migration', async () => {
    const f = await fixture()
    try {
      expect(
        f.database.prepare('SELECT maintenance_json FROM runtime_local_identity_installation').get()
          ?.maintenance_json,
      ).toBe(null)
      f.database.exec('ALTER TABLE runtime_local_identity_installation DROP COLUMN maintenance_json')
      const before = changes(f.database)
      expect(() =>
        createNativeMaintenanceOwner({ database: f.database, identity: f.identity, writerEpoch: 1 }),
      ).toThrow()
      expect(changes(f.database)).toBe(before)
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_native_maintenance_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      f.close()
    }
  })
  it('does not retain active state or roll back someone else after BEGIN fails; the same owner can retry', async () => {
    const f = await fixture()
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      f.database.exec('BEGIN IMMEDIATE')
      expect(() => owner.commit(f.request, f.context)).toThrow()
      // A failed nested BEGIN must leave the original outer transaction intact.
      f.database.exec('ROLLBACK')
      expect(owner.commit(f.request, f.context).transactionId).toBe('technical-commit')
    } finally {
      f.close()
    }
  })
  it('does not install a new maintenance owner from a closed original identity', async () => {
    const f = await fixture()
    try {
      f.identity.close()
      const before = changes(f.database)
      expect(() =>
        createNativeMaintenanceOwner({ database: f.database, identity: f.identity, writerEpoch: 1 }),
      ).toThrow()
      expect(changes(f.database)).toBe(before)
      expect(
        f.database.prepare('SELECT maintenance_json FROM runtime_local_identity_installation').get()
          ?.maintenance_json,
      ).toBe(null)
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_native_maintenance_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      f.close()
    }
  })
  it('refuses reads and original receipt access if another original commit or member is deleted', async () => {
    const f = await fixture()
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      const result = owner.commit(f.request, f.context)
      const second = structuredClone(f.request)
      second.transactionId = 'second-commit'
      const mutation = second.mutations[0]
      if (!mutation) throw new Error('Original mutation is required')
      mutation.recordId = 'second-claims'
      mutation.next.recordId = 'second-claims'
      owner.commit(second, f.context)
      f.database.exec('SAVEPOINT remove_commit')
      f.database.prepare('DELETE FROM runtime_native_maintenance_commits WHERE id=?').run('second-commit')
      expect(() => owner.readHistorical(result.transactionId)).toThrow()
      expect(() => owner.readOriginalReceipt(result)).toThrow()
      f.database.exec('ROLLBACK TO remove_commit; RELEASE remove_commit')
      owner.readOriginalReceipt(result).staticCheck()
      f.database
        .prepare('DELETE FROM runtime_native_maintenance_versions WHERE commit_id=?')
        .run('second-commit')
      const before = changes(f.database)
      expect(() => owner.readHistorical(result.transactionId)).toThrow()
      expect(() => owner.readOriginalReceipt(result)).toThrow()
      expect(changes(f.database)).toBe(before)
    } finally {
      f.close()
    }
  })
  it('rejects foreign native connections and fake identity callbacks before any native owner DDL', async () => {
    const f = await fixture(),
      foreign = new DatabaseSync(f.file)
    try {
      expect(() =>
        createNativeMaintenanceOwner({ database: foreign, identity: f.identity, writerEpoch: 1 }),
      ).toThrow()
      expect(() =>
        createNativeMaintenanceOwner({ database: f.database, identity: { ...f.identity }, writerEpoch: 1 }),
      ).toThrow()
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_native_maintenance_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      foreign.close()
      f.close()
    }
  })
  it('binds installed state to the original C14 row: deleting all owner tables never creates fresh history', async () => {
    const f = await fixture()
    try {
      createNativeMaintenanceOwner({ database: f.database, identity: f.identity, writerEpoch: 1 }).commit(
        f.request,
        f.context,
      )
      f.database.exec(
        'DROP TABLE runtime_native_maintenance_versions; DROP TABLE runtime_native_maintenance_commits; DROP TABLE runtime_native_maintenance_installation',
      )
      const before = changes(f.database)
      expect(() =>
        createNativeMaintenanceOwner({ database: f.database, identity: f.identity, writerEpoch: 1 }),
      ).toThrow()
      expect(changes(f.database)).toBe(before)
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_native_maintenance_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      f.close()
    }
  })
  it('refuses missing original commit/member history instead of reseeding a replay', async () => {
    const f = await fixture()
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      owner.commit(f.request, f.context)
      f.database.prepare('DELETE FROM runtime_native_maintenance_versions').run()
      const before = changes(f.database)
      expect(() => owner.commit(f.request, f.context)).toThrow()
      expect(() =>
        createNativeMaintenanceOwner({ database: f.database, identity: f.identity, writerEpoch: 1 }),
      ).toThrow()
      expect(changes(f.database)).toBe(before)
    } finally {
      f.close()
    }
  })
  it('checks real SQL after the final issuer Clock and rolls back an actual deletion on the original connection', async () => {
    const f = await fixture()
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      let deleted = 0,
        observed = -1,
        materializedClocks = 0
      f.clock(() => {
        if (f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n !== 1)
          return
        if (++materializedClocks !== 3) return
        f.clock()
        deleted = Number(f.database.prepare('DELETE FROM runtime_native_maintenance_commits').run().changes)
        observed = Number(
          f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n,
        )
      })
      expect(() => owner.commit(f.request, f.context)).toThrow()
      expect(materializedClocks).toBe(3)
      expect(deleted).toBe(1)
      expect(observed).toBe(0)
      expect(
        f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n,
      ).toBe(0)
      expect(
        f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_versions').get()?.n,
      ).toBe(0)
      expect(owner.commit(f.request, f.context).transactionId).toBe('technical-commit')
      f.identity.revoke()
      expect(() => owner.commit(f.request, f.context)).toThrow()
    } finally {
      f.close()
    }
  })
  it('does not look up a caller-controlled DatabaseSync method after the final issuer Clock', async () => {
    const f = await fixture()
    let getterCalls = 0,
      materializedClocks = 0
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      f.clock(() => {
        if (f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n !== 1)
          return
        if (++materializedClocks !== 3) return
        f.clock()
        Object.defineProperty(f.database, 'exec', {
          configurable: true,
          get() {
            getterCalls++
            throw new Error('An author-controlled postclock lookup must never run')
          },
        })
      })
      expect(owner.commit(f.request, f.context).transactionId).toBe('technical-commit')
      expect(materializedClocks).toBe(3)
      expect(getterCalls).toBe(0)
      expect(
        f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n,
      ).toBe(1)
    } finally {
      Reflect.deleteProperty(f.database, 'exec')
      f.close()
    }
  })
  it('keeps native row keys fixed when the final Clock replaces global Object.keys', async () => {
    const f = await fixture()
    const originalKeys = Object.keys
    let calls = 0,
      materializedClocks = 0
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      f.clock(() => {
        if (f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n !== 1)
          return
        if (++materializedClocks !== 3) return
        f.clock()
        Object.keys = () => {
          calls++
          throw new Error('A changed global must not run after Clock')
        }
      })
      const result = owner.commit(f.request, f.context)
      Object.keys = originalKeys
      expect(calls).toBe(0)
      expect(materializedClocks).toBe(3)
      expect(result.transactionId).toBe('technical-commit')
      expect(
        f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_commits').get()?.n,
      ).toBe(1)
    } finally {
      Object.keys = originalKeys
      f.close()
    }
  })
  it('reads retained original history on a fresh connection after all original owners close without C14 renewal or writes', async () => {
    const f = await fixture()
    let fresh: DatabaseSync | undefined
    try {
      const owner = createNativeMaintenanceOwner({
        database: f.database,
        identity: f.identity,
        writerEpoch: 1,
      })
      const result = owner.commit(f.request, f.context)
      owner.close()
      f.identity.close()
      f.database.close()
      const reopened = new DatabaseSync(f.file)
      fresh = reopened
      const before = changes(reopened)
      const installationId = reopened.prepare('SELECT id FROM runtime_local_identity_installation').get()?.id
      if (typeof installationId !== 'string') throw new Error('Original installation is required')
      const recovered = openNativeMaintenanceHistory({
        database: reopened,
        identityInstallationId: installationId,
      })
      expect(recovered.readHistorical('technical-commit').result).toEqual(result)
      recovered.readHistorical('technical-commit').staticCheck()
      expect(changes(reopened)).toBe(before)
      reopened.prepare('DELETE FROM runtime_native_maintenance_commits').run()
      const missingChanges = changes(reopened)
      expect(() =>
        openNativeMaintenanceHistory({ database: reopened, identityInstallationId: installationId }),
      ).toThrow()
      expect(changes(reopened)).toBe(missingChanges)
    } finally {
      fresh?.close()
      f.close()
    }
  })
})
