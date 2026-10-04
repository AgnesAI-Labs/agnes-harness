import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateFileSync } from '@agnes/system-node'
import { captureLocalDeploymentOwner } from '../../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../../src/runtime/maintenance/bootstrap-locator.js'

export function publicationNativeFixture() {
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
