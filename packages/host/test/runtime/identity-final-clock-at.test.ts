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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'identity-final-at-')))
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
  let at = Date.parse('2026-10-04T00:00:00Z')
  let reads = 0
  let afterClock: (() => void) | undefined
  const identity = createLocalDeploymentIdentity({
    database,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database, deploymentDirectory }),
    authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
    scope: {
      kind: 'session',
      installationId: 'installation',
      runtimeId: 'runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    now: () => {
      reads++
      afterClock?.()
      return at
    },
  })
  return {
    identity,
    database,
    at: () => at,
    reads: () => reads,
    setAt: (value: number) => {
      at = value
    },
    afterClock: (action: () => void) => {
      afterClock = action
    },
    close: () => {
      identity.close()
      if (database.isOpen) database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe.skipIf(typeof process.getuid !== 'function')('original local identity final Clock value', () => {
  it('returns the one actual issuer Clock value after the original native fence', async () => {
    const f = fixture()
    try {
      const connection = await f.identity.connect(new AbortController().signal)
      const context = connection.issue(new Date(f.at() + 60_000).toISOString(), 'trace')
      const capture = f.identity.capture(context)
      const before = f.reads()
      expect(capture.finalCheckAt()).toBe(f.at())
      expect(f.reads()).toBe(before + 1)
      connection.close()
    } finally {
      f.close()
    }
  })

  it('refuses the exact deadline and a changed original row after the Clock', async () => {
    const f = fixture()
    try {
      const connection = await f.identity.connect(new AbortController().signal)
      const deadline = f.at() + 60_000
      const context = connection.issue(new Date(deadline).toISOString(), 'trace')
      f.setAt(deadline)
      expect(() => f.identity.capture(context).finalCheckAt()).toThrow()
      f.setAt(deadline - 1)
      expect(() => f.identity.capture(context, new Date(deadline - 1).toISOString()).finalCheckAt()).toThrow()
      f.afterClock(() => f.identity.revoke())
      expect(() => f.identity.capture(context).finalCheckAt()).toThrow()
      connection.close()
    } finally {
      f.close()
    }
  })

  it('accepts a finite zero Clock value and refuses an identity row revoked on that Clock', async () => {
    const f = fixture()
    try {
      const connection = await f.identity.connect(new AbortController().signal)
      const context = connection.issue(new Date(f.at() + 60_000).toISOString(), 'trace')
      const capture = f.identity.capture(context)
      f.setAt(0)
      expect(capture.finalCheckAt()).toBe(0)
      f.afterClock(() => {
        f.database
          .prepare('UPDATE runtime_identity_instances SET revoked=1 WHERE authorization_ref=?')
          .run(context.authorizationRef)
      })
      expect(() => capture.finalCheckAt()).toThrow()
      connection.close()
    } finally {
      f.close()
    }
  })
})
