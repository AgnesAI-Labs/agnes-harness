import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'
import {
  createNativeMaintenanceOwner,
  isNativeMaintenanceOwner,
  nativeMaintenanceOwnerUsesDatabase,
} from '../../src/runtime/maintenance/native-store.js'

async function originalOwner() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'maintenance-owner-binding-')))
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
  let clocks = 0
  const authority = { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 }
  const identity = createLocalDeploymentIdentity({
    database,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory }),
    authority,
    scope: {
      kind: 'session',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    now() {
      clocks++
      return Date.parse('2026-10-04T00:00:00Z')
    },
  })
  const connection = await identity.connect(new AbortController().signal)
  const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
  const owner = createNativeMaintenanceOwner({ database, identity, writerEpoch: 1 })
  return {
    file,
    database,
    identity,
    owner,
    context,
    authority,
    clocks: () => clocks,
    close() {
      owner.close()
      identity.close()
      if (database.isOpen) database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
function changes(database: DatabaseSync) {
  return database.prepare('SELECT total_changes() AS n').get()?.n
}

describe.skipIf(typeof process.getuid !== 'function')(
  'original maintenance owner connection membership',
  () => {
    it('checks the genuine connection without writing or reading the issuer clock; fake getters never run', async () => {
      const f = await originalOwner()
      try {
        const before = changes(f.database)
        const clocks = f.clocks()
        expect(isNativeMaintenanceOwner(f.owner)).toBe(true)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(true)
        expect(nativeMaintenanceOwnerUsesDatabase({ ...f.owner }, f.database)).toBe(false)
        let getters = 0
        const fake = Object.freeze({
          get database() {
            getters++
            return f.database
          },
          get originalConnection() {
            getters++
            throw new Error('A caller property is not native evidence')
          },
        })
        expect(nativeMaintenanceOwnerUsesDatabase(fake, f.database)).toBe(false)
        expect(nativeMaintenanceOwnerUsesDatabase(new Proxy(f.owner, {}), f.database)).toBe(false)
        expect(getters).toBe(0)
        expect(f.clocks()).toBe(clocks)
        expect(changes(f.database)).toBe(before)
        f.owner.close()
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(false)
        expect(changes(f.database)).toBe(before)
      } finally {
        f.close()
      }
    })

    it('rejects another actual connection to the same file even though it reads the same installation', async () => {
      const f = await originalOwner()
      const other = new DatabaseSync(f.file)
      try {
        const query = 'SELECT * FROM runtime_native_maintenance_installation'
        expect(other.prepare(query).all()).toEqual(f.database.prepare(query).all())
        const before = changes(other)
        expect(isNativeMaintenanceOwner(f.owner)).toBe(true)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, other)).toBe(false)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(true)
        expect(changes(other)).toBe(before)
      } finally {
        other.close()
        f.close()
      }
    })

    it('rejects the old native generation after close/open of the very same JS database object', async () => {
      const f = await originalOwner()
      try {
        const originalStatement = f.database.prepare('SELECT 1 AS n')
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(true)
        f.database.close()
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(false)
        f.database.open()
        expect(f.database.isOpen).toBe(true)
        expect(
          f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_installation').get()?.n,
        ).toBe(1)
        expect(() => originalStatement.get()).toThrow()
        const before = changes(f.database)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(false)
        expect(changes(f.database)).toBe(before)
      } finally {
        f.close()
      }
    })

    it('rejects missing original installation evidence without rebuilding it', async () => {
      const f = await originalOwner()
      try {
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(true)
        expect(f.database.prepare('DELETE FROM runtime_native_maintenance_installation').run().changes).toBe(
          1,
        )
        const before = changes(f.database)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(false)
        expect(
          f.database.prepare('SELECT count(*) AS n FROM runtime_native_maintenance_installation').get()?.n,
        ).toBe(0)
        expect(changes(f.database)).toBe(before)
      } finally {
        f.close()
      }
    })

    it('does not turn connection membership into permission when the original C14 is revoked', async () => {
      const f = await originalOwner()
      try {
        f.identity.revoke()
        const before = changes(f.database)
        expect(nativeMaintenanceOwnerUsesDatabase(f.owner, f.database)).toBe(true)
        expect(() =>
          f.owner.commit(
            {
              transactionId: 'revoked',
              authority: f.authority,
              expectedWriterEpoch: 1,
              mutations: [],
              outbox: [],
            },
            f.context,
          ),
        ).toThrow()
        expect(changes(f.database)).toBe(before)
      } finally {
        f.close()
      }
    })
  },
)
