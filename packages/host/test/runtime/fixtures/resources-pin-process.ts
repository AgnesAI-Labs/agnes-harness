import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { ResourceDescriptor, ScopeRef } from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createReferenceResources } from '../../../../../examples/runtime-reference/src/providers/resources.js'
import { createResourcesService } from '../../../src/runtime/providers/resources.js'

const provider = process.argv[2]
const directory = process.argv[3]
const mode = process.argv[4]
if (
  (provider !== 'default' && provider !== 'reference') ||
  !directory ||
  (mode !== 'hold' && mode !== 'read')
) {
  process.stderr.write('usage: resources-pin-process <default|reference> <directory> <hold|read>\n')
  process.exit(2)
}

// Local copies of the catalog fixture. This process entry is not a test file, so it cannot import testkit.
const scope: ScopeRef = {
  kind: 'workspace',
  installationId: 'fixture-installation',
  runtimeId: 'fixture-runtime',
  workspaceId: 'fixture-workspace',
}
const context: CallContext = {
  scope,
  signal: new AbortController().signal,
  principalRef: 'fixture-principal',
  authorizationRef: 'fixture-authorization',
  bindingId: 'fixture-binding',
  invocationId: 'fixture-invocation',
  deadline: '2030-01-01T00:00:00Z',
  traceRef: 'fixture-trace',
}
const definition = { name: 'review', description: 'Synthetic resource definition' }
const schema = {
  typeId: 'acme.catalog/definition@1',
  revision: 1,
  digest: canonicalJsonDigest('definition-schema'),
}
const descriptor: ResourceDescriptor = {
  id: 'review',
  kind: 'skill',
  version: '1',
  digest: canonicalJsonDigest(definition),
  namespace: 'fixture',
  tags: ['review'],
  inputSchema: schema,
  outputSchema: schema,
  requiredCapabilities: [],
  sourceRef: {
    kind: 'resource',
    value: { resourceId: 'source-package', version: '1', digest: canonicalJsonDigest('source-package') },
  },
  trust: 'user',
  ownerBinding: {
    bindingId: 'fixture-tools',
    contract: 'agh.tools',
    logicalName: 'tools',
    providerId: 'fixture/tools',
  },
  definition: {
    kind: 'inline',
    schema,
    value: definition,
    digest: canonicalJsonDigest(definition),
    bytes: Buffer.byteLength(JSON.stringify(definition)),
  },
}
const resource = {
  kind: 'resource' as const,
  value: { resourceId: descriptor.id, version: descriptor.version, digest: descriptor.digest },
}
const catalog = {
  directory,
  scope,
  authorize: (_method: string, _resource: ResourceDescriptor | null, caller: CallContext) =>
    caller.principalRef === 'fixture-principal',
  contributionReady: (_resource: ResourceDescriptor, release: string) => release === 'fixture-release',
  schemaAvailable: (item: { revision: number }) => item.revision === 1,
  discover: async () => {},
}
const gate = async () => {
  writeFileSync(join(directory, 'pin-ready'), 'ready')
  // A bare pending promise does not keep Node alive. The interval is the hold the parent kills.
  await new Promise<void>(() => {
    setInterval(() => undefined, 60_000)
  })
}
const service =
  provider === 'default'
    ? createResourcesService(mode === 'hold' ? { ...catalog, pinGate: gate } : catalog)
    : createReferenceResources(mode === 'hold' ? { ...catalog, holdPin: gate } : catalog)

function refused(result: Outcome<unknown>): string | null {
  return result.ok ? null : result.error.detailCode
}

async function main() {
  if (mode === 'hold') {
    const registered = await service.call(
      'register',
      { descriptor, ownerReleaseSetId: 'fixture-release' },
      context,
    )
    const registeredCode = refused(registered)
    if (registeredCode) throw new Error(registeredCode)
    const described = await service.call('describe', { resourceId: descriptor.id, version: '1' }, context)
    const describedCode = refused(described)
    if (describedCode) throw new Error(describedCode)
    const retained = await service.call('retain', { resource, purpose: 'continuation' }, context)
    const retainedCode = refused(retained)
    if (retainedCode) throw new Error(retainedCode)
    return
  }
  const retained = await service.call('retain', { resource, purpose: 'continuation' }, context)
  const retainedCode = refused(retained)
  if (retainedCode) throw new Error(retainedCode)
  if (!retained.ok) return
  const released = await service.call(
    'release',
    { retention: retained.value, reason: 'process restarted' },
    context,
  )
  const releasedCode = refused(released)
  if (releasedCode) throw new Error(releasedCode)
  if (!released.ok) return
  process.stdout.write(`${JSON.stringify({ retained: retained.value, released: released.value })}\n`)
  service.close()
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
