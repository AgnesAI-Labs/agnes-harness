import { writeSync } from 'node:fs'
import { boundedCanonicalJson, canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { admissionFixtureInput } from '../../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { createLocalDeploymentIdentity } from '../../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../../src/runtime/identity/local-deployment-owner.js'
import { createNativeStateReadOwner } from '../../../src/runtime/state/native-read-owner.js'
import { createStateQueryService } from '../../../src/runtime/state/query-service.js'
import { openJointAdmission } from './assembly-admission-joint.js'
import { localTestBridge } from './state-query-fixture.js'

/**
 * Child process for the cold-restart test. `open` reads one snapshot and then kills itself with
 * SIGKILL; `read` reopens the same database, checks that the killed process's snapshot is refused
 * and reads again from a fresh snapshot.
 */
const [deploymentDirectory, mode, oldSnapshot] = process.argv.slice(2)
if (!deploymentDirectory || (mode !== 'open' && mode !== 'read')) throw Error('usage: <directory> open|read')
const input = admissionFixtureInput()
const fixture = await openJointAdmission(deploymentDirectory, input)
const authority = { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 }
const runtimeScope = { installationId: 'fixture-installation', runtimeId: 'fixture-runtime' }
const scope = { kind: 'runtime' as const, ...runtimeScope }
const identity = createLocalDeploymentIdentity({
  database: fixture.db,
  deploymentDirectory,
  owner: captureLocalDeploymentOwner({ database: fixture.db, deploymentDirectory }),
  authority,
  scope,
  now: () => Date.parse(input.fixture.now),
})
const connection = await identity.connect(new AbortController().signal)
const context = connection.issue('2030-01-01T00:00:00Z', 'cold-state-query')
const owner = createNativeStateReadOwner({ originalState: fixture.state, runtimeScope })
const { bridge } = localTestBridge({ context, identity, scope, database: fixture.db })
const service = createStateQueryService({
  owner,
  bridge,
  authority,
  now: () => Date.parse(input.fixture.now),
})
const caller = {
  ...context,
  scope: {
    ...scope,
    kind: 'session' as const,
    workspaceId: 'fixture-workspace',
    sessionId: 'fixture-session',
  },
}
const methods = RuntimeMethodSchemaRefs['agh.state'].scan
const binding = {
  bindingId: 'state',
  contract: 'agh.state',
  logicalName: 'state',
  providerId: 'state-provider',
}
function scanOf(snapshot: unknown) {
  const request = { snapshot, collection: 'records', filter: {}, order: 'asc', cursor: null, limit: 500 }
  const body = boundedCanonicalJson(request, { maxBytes: 262_144, maxDepth: 64, maxMembers: 16_384 })
  if (!body.ok) throw Error('scan request bounds')
  return {
    target: binding,
    method: 'scan',
    snapshot: (snapshot as { snapshotId: string }).snapshotId,
    input: {
      kind: 'inline',
      schema: methods.input,
      value: body.value.json,
      digest: canonicalJsonDigest(body.value.json),
      bytes: body.value.bytes,
    },
  } as never
}
/** A pipe may take a write in pieces, so write until every byte is out before anything can kill us. */
function report(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  for (let at = 0; at < bytes.length; ) {
    try {
      at += writeSync(1, bytes, at)
    } catch (caught) {
      if ((caught as { code?: string }).code !== 'EAGAIN') throw caught
    }
  }
}
async function freshItems() {
  const opened = await service.open(
    { requestId: 'cold', authority, sessionId: 'fixture-session', mode: 'read', writerId: null, ttlMs: null },
    context,
  )
  if (!opened.ok) throw Error(JSON.stringify(opened.error))
  const reply = await service.query(scanOf(opened.value.snapshot), caller)
  if (!reply.ok || reply.value.kind !== 'value') throw Error(JSON.stringify(reply))
  const page = (reply.value.output as unknown as { value: { items: unknown[] } }).value
  return { snapshot: opened.value.snapshot, items: page.items }
}
try {
  if (mode === 'open') {
    const { snapshot, items } = await freshItems()
    // Written synchronously so the report survives the kill that follows.
    report({ snapshot, items })
    process.kill(process.pid, 'SIGKILL')
  } else {
    const old = await service.query(scanOf(JSON.parse(oldSnapshot ?? 'null')), caller)
    const { items } = await freshItems()
    report({ oldSnapshotError: old.ok ? null : old.error.detailCode, items })
  }
} finally {
  await service.close()
  await owner.close()
  identity.close()
  await fixture.close()
}
