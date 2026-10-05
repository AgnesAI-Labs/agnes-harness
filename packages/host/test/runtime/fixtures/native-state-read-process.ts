import { admissionFixtureInput } from '../../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { createLocalDeploymentIdentity } from '../../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../../src/runtime/identity/local-deployment-owner.js'
import { createNativeStateReadOwner } from '../../../src/runtime/state/native-read-owner.js'
import { openJointAdmission } from './assembly-admission-joint.js'
import { localTestBridge } from './state-query-fixture.js'

const deploymentDirectory = process.argv[2]
if (!deploymentDirectory) throw Error('Original deployment directory required')
const input = admissionFixtureInput()
const fixture = await openJointAdmission(deploymentDirectory, input)
const identity = createLocalDeploymentIdentity({
  database: fixture.db,
  deploymentDirectory,
  owner: captureLocalDeploymentOwner({ database: fixture.db, deploymentDirectory }),
  authority: { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 },
  scope: {
    kind: 'runtime',
    installationId: 'fixture-installation',
    runtimeId: 'fixture-runtime',
  },
  now: () => Date.parse(input.fixture.now),
})
const connection = await identity.connect(new AbortController().signal)
const context = connection.issue('2030-01-01T00:00:00Z', 'cold-process-read')
const runtimeScope = { installationId: 'fixture-installation', runtimeId: 'fixture-runtime' }
const reader = createNativeStateReadOwner({ originalState: fixture.state, runtimeScope })
const grant = localTestBridge({
  context,
  identity,
  scope: { kind: 'runtime', ...runtimeScope },
  database: fixture.db,
}).bridge.grant(context, 'fixture-session')
if (!grant) throw Error('test bridge refused the fixture session')
try {
  const snapshot = await reader.openVerifiedSnapshot('fixture-session', grant)
  const page = await reader.scanVerifiedPage(
    snapshot,
    { snapshot, collection: 'records', filter: {}, order: 'asc', cursor: null, limit: 500 },
    grant,
  )
  process.stdout.write(JSON.stringify(page.items.map((item) => [item.recordId, item.digest])))
} finally {
  await reader.close()
  identity.close()
  await fixture.close()
}
