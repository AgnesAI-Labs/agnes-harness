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

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-deployment-identity-')))
  const deploymentDirectory = join(root, 'deployment')
  const anchor = createBootstrapAnchor(deploymentDirectory, {
    principalRef: 'not-an-authentication-proof',
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
  let at = Date.parse('2026-10-04T00:00:00Z')
  let clockHook: (() => void) | undefined
  const options = {
    database,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory }),
    authority: { authorityId: 'state-authority', tenantId: 'tenant', authorityEpoch: 1 },
    scope: {
      kind: 'session' as const,
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    now: () => {
      clockHook?.()
      return at
    },
  }
  return {
    options,
    database,
    file,
    deploymentDirectory,
    clock(hook?: () => void) {
      clockHook = hook
    },
    advance(ms: number) {
      at += ms
    },
    close() {
      if (database.isOpen) database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe.skipIf(typeof process.getuid !== 'function')('local original C14 deployment identity', () => {
  it('authenticates from the original OS connection and consumes the real issued context', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const connection = await identity.connect(new AbortController().signal)
      expect(connection.actor.identity.authKind).toBe('local')
      expect(connection.actor.identity.principalRef).not.toBe('not-an-authentication-proof')
      const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(context)
      cap.dynamicCheck()
      cap.finalCheck()
      expect(() => identity.capture({ ...context })).toThrow()
      expect(f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n).toBe(1)
      connection.close()
      expect(() => identity.capture(context)).toThrow()
    } finally {
      identity.close()
      f.close()
    }
  })
  it('rejects cloned OS capabilities and a foreign connection before installing any tables', () => {
    const f = fixture()
    const foreign = new DatabaseSync(f.file)
    try {
      expect(() => createLocalDeploymentIdentity({ ...f.options, owner: { ...f.options.owner } })).toThrow()
      expect(() => createLocalDeploymentIdentity({ ...f.options, database: foreign })).toThrow()
      expect(
        f.database
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'runtime_local_identity_%'")
          .get()?.n,
      ).toBe(0)
    } finally {
      foreign.close()
      f.close()
    }
  })
  it('rolls back a real generation revocation in the final issuer clock', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const c = await identity.connect(new AbortController().signal)
      const ctx = c.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(ctx)
      cap.dynamicCheck()
      let changes = 0
      f.database.exec('BEGIN IMMEDIATE')
      f.clock(() => {
        f.clock()
        changes = Number(
          f.database.prepare('UPDATE runtime_local_identity_connections SET closed=1').run().changes,
        )
      })
      expect(() => cap.finalCheck()).toThrow()
      expect(changes).toBe(1)
      expect(f.database.prepare('SELECT closed FROM runtime_local_identity_connections').get()?.closed).toBe(
        1,
      )
      f.database.exec('ROLLBACK')
      expect(f.database.prepare('SELECT closed FROM runtime_local_identity_connections').get()?.closed).toBe(
        0,
      )
      cap.finalCheck()
    } finally {
      identity.close()
      f.close()
    }
  })
  it('rejects deleted original claims at the last clock and does not reissue on recovery', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const c = await identity.connect(new AbortController().signal)
      const ctx = c.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(ctx)
      let changes = 0
      f.clock(() => {
        f.clock()
        changes = Number(f.database.prepare('DELETE FROM runtime_local_identity_claims').run().changes)
      })
      expect(() => cap.finalCheck()).toThrow()
      expect(changes).toBe(1)
      identity.close()
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n
      expect(() => createLocalDeploymentIdentity(f.options)).toThrow(/incomplete/)
      expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(before)
    } finally {
      identity.close()
      f.close()
    }
  })
  it('restores only complete original tables and creates a fresh process connection', async () => {
    const f = fixture()
    const first = createLocalDeploymentIdentity(f.options)
    const original = await first.connect(new AbortController().signal)
    const ctx = original.issue('2026-10-04T00:01:00Z', 'trace')
    first.close()
    f.database.close()
    const freshDatabase = new DatabaseSync(f.file)
    const restoredOptions = {
      ...f.options,
      database: freshDatabase,
      owner: captureLocalDeploymentOwner({
        database: freshDatabase,
        deploymentDirectory: f.deploymentDirectory,
      }),
    }
    const next = createLocalDeploymentIdentity(restoredOptions)
    try {
      expect(() => next.capture(ctx)).toThrow()
      const fresh = await next.connect(new AbortController().signal)
      expect(fresh.actor.authorizationRef).not.toBe(original.actor.authorizationRef)
      next.capture(fresh.issue('2026-10-04T00:01:00Z', 'fresh')).finalCheck()
      next.close()
      freshDatabase.exec('DROP TABLE runtime_local_identity_claims')
      expect(() => createLocalDeploymentIdentity(restoredOptions)).toThrow()
      expect(
        freshDatabase
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='runtime_local_identity_claims'")
          .get()?.n,
      ).toBe(0)
    } finally {
      next.close()
      freshDatabase.close()
      f.close()
    }
  })
  it('rejects original signal abort at the final clock and persisted installation revocation', async () => {
    const f = fixture()
    const identity = createLocalDeploymentIdentity(f.options)
    try {
      const controller = new AbortController()
      const connection = await identity.connect(controller.signal)
      const context = connection.issue('2026-10-04T00:01:00Z', 'trace')
      const cap = identity.capture(context)
      f.clock(() => {
        f.clock()
        controller.abort()
      })
      expect(() => cap.finalCheck()).toThrow()
      const second = await identity.connect(new AbortController().signal)
      const secondContext = second.issue('2026-10-04T00:01:00Z', 'second')
      const secondCap = identity.capture(secondContext)
      identity.revoke()
      expect(() => secondCap.finalCheck()).toThrow()
      expect(() => identity.capture(secondContext)).toThrow()
      const count = f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n
      await expect(identity.connect(new AbortController().signal)).rejects.toThrow()
      expect(f.database.prepare('SELECT count(*) AS n FROM runtime_identity_instances').get()?.n).toBe(count)
    } finally {
      identity.close()
      f.close()
    }
  })
})
