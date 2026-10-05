import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-session-principal-')))
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

describe.skipIf(typeof process.getuid !== 'function')('local identity session principal alias', () => {
  it('maps only an original issued context without changing that context', async () => {
    const f = fixture()
    const other = fixture()
    try {
      const connection = await f.identity.connect(new AbortController().signal)
      const context = connection.issue(new Date(f.at() + 60_000).toISOString(), 'trace')
      const before = {
        principalRef: context.principalRef,
        authorizationRef: context.authorizationRef,
        scope: context.scope,
      }
      const alias = f.identity.captureSessionPrincipal(context)
      expect(alias.principalId).toBe('local')
      expect(alias.principalRef).toBe(context.principalRef)
      expect(alias.principalRef).not.toBe('local')
      expect(alias.authorizationRef).toBe(context.authorizationRef)
      expect(alias.deadline).toBe(f.at() + 60_000)
      expect(Object.isFrozen(alias)).toBe(true)
      expect(() => alias.check()).not.toThrow()
      expect({
        principalRef: context.principalRef,
        authorizationRef: context.authorizationRef,
        scope: context.scope,
      }).toEqual(before)
      expect(() => f.identity.captureSessionPrincipal({ ...context } as CallContext)).toThrow()
      expect(() => other.identity.captureSessionPrincipal(context)).toThrow()
      connection.close()
      expect(() => alias.check()).toThrow()
    } finally {
      other.close()
      f.close()
    }
  })

  it.each(['revoked', 'expired', 'aborted', 'closed'] as const)(
    'rejects an old alias when %s',
    async (reason) => {
      const f = fixture()
      try {
        const controller = new AbortController()
        const connection = await f.identity.connect(controller.signal)
        const context = connection.issue(new Date(f.at() + 60_000).toISOString(), 'trace')
        const alias = f.identity.captureSessionPrincipal(context)
        if (reason === 'revoked') f.identity.revoke()
        if (reason === 'expired') f.setAt(alias.deadline)
        if (reason === 'aborted') controller.abort()
        if (reason === 'closed') f.identity.close()
        expect(() => alias.check()).toThrow()
      } finally {
        f.close()
      }
    },
  )

  it('refuses revocation inside the final issuer clock', async () => {
    const f = fixture()
    try {
      const connection = await f.identity.connect(new AbortController().signal)
      const context = connection.issue(new Date(f.at() + 60_000).toISOString(), 'trace')
      const alias = f.identity.captureSessionPrincipal(context)
      f.afterClock(() => f.identity.revoke())
      expect(() => alias.check()).toThrow()
      expect(() => f.identity.captureSessionPrincipal(context)).toThrow()
    } finally {
      f.close()
    }
  })
})
