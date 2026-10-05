import { closeSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateFileSync } from '@agnes/system-node'
import { admissionFixtureInput } from '../../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { createLocalDeploymentIdentity } from '../../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../../src/runtime/maintenance/bootstrap-locator.js'
import { createNativeStateReadOwner } from '../../../src/runtime/state/native-read-owner.js'
import { openJointAdmission } from './assembly-admission-joint.js'

export async function originalNativeFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-native-state-read-')))
  const input = admissionFixtureInput()
  const deploymentDirectory = join(directory, 'deployment')
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
  if (!anchor.ok) throw Error(anchor.error.detailCode)
  const file = join(deploymentDirectory, 'joint.sqlite')
  closeSync(createPrivateFileSync(file))
  const setupDatabase = new DatabaseSync(file)
  const authority = { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 }
  const scope = {
    kind: 'runtime' as const,
    installationId: 'fixture-installation',
    runtimeId: 'fixture-runtime',
  }
  const now = () => Date.parse(input.fixture.now)
  const setupIdentity = createLocalDeploymentIdentity({
    database: setupDatabase,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database: setupDatabase, deploymentDirectory }),
    authority,
    scope,
    now,
  })
  setupIdentity.close()
  setupDatabase.close()
  const fixture = await openJointAdmission(deploymentDirectory, input)
  const identity = createLocalDeploymentIdentity({
    database: fixture.db,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database: fixture.db, deploymentDirectory }),
    authority,
    scope,
    now,
  })
  const connection = await identity.connect(new AbortController().signal)
  const context = connection.issue('2030-01-01T00:00:00Z', 'native-read')
  const reader = createNativeStateReadOwner({
    originalState: fixture.state,
    originalIdentity: identity,
    originalDatabase: fixture.db,
  })
  return {
    directory,
    deploymentDirectory,
    file,
    input,
    fixture,
    identity,
    context,
    reader,
    authority,
    scope,
    now,
  }
}
