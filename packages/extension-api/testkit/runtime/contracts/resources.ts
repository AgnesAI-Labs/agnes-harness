import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  BindingRef,
  ResourceDescriptor,
  ResourcesReleaseResult,
  RetentionRef,
  SchemaRef,
  ScopeRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export const RESOURCE_CATALOG_COVERAGE = {
  implemented: ['list', 'describe', 'register', 'remove', 'retain', 'release', 'resources_discover'],
  incomplete: ['production-wiring', 'tools-consumer'],
} as const
export interface ResourceCatalogSubject {
  readonly binding: BindingRef
  call(method: string, input: unknown, context: CallContext): Promise<Outcome<unknown>>
  close(): void
}
export interface ResourceCatalogInput {
  directory: string
  scope: ScopeRef
  authorize(method: string, resource: ResourceDescriptor | null, context: CallContext): boolean
  contributionReady(resource: ResourceDescriptor, releaseSetId: string): boolean
  schemaAvailable(schema: SchemaRef): boolean
  discover(
    event: 'resources_discover',
    resources: readonly ResourceDescriptor[],
    context: CallContext,
  ): Promise<void>
}
export const resourceCatalogScope: ScopeRef = {
  kind: 'workspace',
  installationId: 'fixture-installation',
  runtimeId: 'fixture-runtime',
  workspaceId: 'fixture-workspace',
}
export function resourceCatalogContext(signal = new AbortController().signal): CallContext {
  return {
    scope: resourceCatalogScope,
    signal,
    principalRef: 'fixture-principal',
    authorizationRef: 'fixture-authorization',
    bindingId: 'fixture-binding',
    invocationId: 'fixture-invocation',
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'fixture-trace',
  }
}
export function resourceCatalogDescriptor(
  id = 'review',
  kind: ResourceDescriptor['kind'] = 'skill',
): ResourceDescriptor {
  const schema = {
    typeId: 'acme.catalog/definition@1',
    revision: 1,
    digest: canonicalJsonDigest('definition-schema'),
  }
  const value = { name: id, description: 'Synthetic resource definition' }
  return {
    id,
    kind,
    version: '1',
    digest: canonicalJsonDigest(value),
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
      value,
      digest: canonicalJsonDigest(value),
      bytes: Buffer.byteLength(JSON.stringify(value)),
    },
  }
}
export function resourceCatalogFixtureInput(directory: string): ResourceCatalogInput {
  return {
    directory,
    scope: resourceCatalogScope,
    authorize: (_method, _resource, context) => context.principalRef === 'fixture-principal',
    contributionReady: (_resource, release) => release === 'fixture-release',
    schemaAvailable: (schema) => schema.revision === 1,
    discover: async () => {},
  }
}
function insist(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
}
export function resourceCatalogValue<T>(schema: string, result: Outcome<unknown>): T {
  insist(result.ok, `${schema} refused`)
  const checked = validateRuntime(schema as 'ResourceDescriptor', result.value)
  insist(checked.ok, `${schema} invalid`)
  return checked.value as T
}
const detail = (result: Outcome<unknown>) => (result.ok ? 'ok' : result.error.detailCode)

export interface ResourceCatalogContractBinding {
  providerId: 'default' | 'reference'
  providerDigest: string
  command: string
  build: BuildIdentity
  create(input: ResourceCatalogInput): ResourceCatalogSubject
  /** Must read the closed catalog in a newly started process, with no inherited provider object. */
  coldRead(directory: string, descriptor: ResourceDescriptor): Promise<Outcome<unknown>>
}

/** Six lifecycle scenarios for the catalog, including the first-pin exemption. */
function resourceRef(descriptor: ResourceDescriptor) {
  return {
    kind: 'resource' as const,
    value: { resourceId: descriptor.id, version: descriptor.version, digest: descriptor.digest },
  }
}
export async function exerciseResourceCatalog(
  binding: ResourceCatalogContractBinding,
  scenario: ScenarioName,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'resource-catalog-contract-'))
  const options = resourceCatalogFixtureInput(directory)
  const events: string[] = []
  options.discover = async (event) => {
    events.push(event)
  }
  const subject = binding.create(options)
  const call = (method: string, input: unknown, ctx = resourceCatalogContext()) =>
    subject.call(method, input, ctx)
  const descriptor = resourceCatalogDescriptor()
  const query = { kind: 'skill', filter: {}, cursor: null, limit: 1 }
  try {
    insist(subject.binding.providerId === `agh.${binding.providerId}/resources`, 'selected provider identity')
    insist((await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })).ok, 'registration')
    const described = await call('describe', { resourceId: descriptor.id, version: '1' })
    insist(
      described.ok &&
        canonicalJsonDigest(resourceCatalogValue<ResourceDescriptor>('ResourceDescriptor', described)) ===
          canonicalJsonDigest(descriptor),
      'exact descriptor',
    )
    insist(events.includes('resources_discover'), 'Hook boundary')
    switch (scenario) {
      case 'select':
        break
      case 'normal': {
        const another = resourceCatalogDescriptor('z-review')
        insist(
          (await call('register', { descriptor: another, ownerReleaseSetId: 'fixture-release' })).ok,
          'second registration',
        )
        const first = resourceCatalogValue<{ items: ResourceDescriptor[]; nextCursor: string }>(
          'ResourcesListResult',
          await call('list', query),
        )
        insist(first.items[0]?.id === descriptor.id && first.nextCursor !== null, 'bounded first page')
        const second = resourceCatalogValue<{ items: ResourceDescriptor[]; complete: boolean }>(
          'ResourcesListResult',
          await call('list', { ...query, cursor: first.nextCursor }),
        )
        insist(second.items[0]?.id === another.id && second.complete, 'complete next page')
        insist((await call('remove', { id: another.id, expectedRevision: 2 })).ok, 'remove current revision')
        insist(
          detail(await call('describe', { resourceId: another.id, version: null })) === 'resources_not_found',
          'removed resource',
        )
        const pinned = resourceCatalogValue<RetentionRef>(
          'RetentionRef',
          await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' }),
        )
        insist(
          pinned.kind === 'domain-record' &&
            pinned.authorityId === 'agh.resources' &&
            pinned.resourceId === descriptor.id &&
            pinned.version === descriptor.version &&
            pinned.digest === descriptor.digest,
          'first retain binds the discovered version',
        )
        const replay = resourceCatalogValue<RetentionRef>(
          'RetentionRef',
          await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' }),
        )
        insist(replay.pinId === pinned.pinId, 'same owner replays the pin')
        insist(
          detail(await call('retain', { resource: resourceRef(descriptor), purpose: 'job' })) ===
            'resources_pin_required',
          'another purpose is not a new acquisition',
        )
        const previous = options.authorize
        options.authorize = (method, resource, ctx) =>
          previous(method, resource, ctx) || ctx.principalRef === 'second-principal'
        insist(
          detail(
            await call(
              'retain',
              { resource: resourceRef(descriptor), purpose: 'continuation' },
              { ...resourceCatalogContext(), principalRef: 'second-principal' },
            ),
          ) === 'resources_pin_required',
          'ordinary caller must already hold the pin',
        )
        options.authorize = previous
        const released = resourceCatalogValue<ResourcesReleaseResult>(
          'ResourcesReleaseResult',
          await call('release', { retention: pinned, reason: 'continuation finished' }),
        )
        insist(released.state === 'released', 'release with no active reference')
        const again = resourceCatalogValue<ResourcesReleaseResult>(
          'ResourcesReleaseResult',
          await call('release', { retention: pinned, reason: 'continuation finished' }),
        )
        insist(
          again.state === 'released' && again.receipt.digest === released.receipt.digest,
          'release replay',
        )
        break
      }
      case 'deny': {
        const badReady = { ...resourceCatalogDescriptor('unready'), version: '2' }
        insist(
          detail(await call('register', { descriptor: badReady, ownerReleaseSetId: 'not-ready' })) ===
            'resources_not_ready',
          'unready refused',
        )
        const staleSchema = {
          ...resourceCatalogDescriptor('stale'),
          inputSchema: { ...(descriptor.inputSchema as SchemaRef), revision: 2 },
        }
        insist(
          detail(
            await call('register', { descriptor: staleSchema, ownerReleaseSetId: 'fixture-release' }),
          ) === 'resources_schema_stale',
          'stale schema refused',
        )
        insist(
          detail(
            await call(
              'describe',
              { resourceId: descriptor.id, version: null },
              { ...resourceCatalogContext(), principalRef: 'outsider' },
            ),
          ) === 'resources_denied',
          'unauthorized resource',
        )
        insist(detail(await call('call', {})) === 'resources_unknown_method', 'unknown call')
        insist(
          detail(await call('register', { descriptor, ownerReleaseSetId: 'fixture-release' })) ===
            'resources_duplicate_registration',
          'duplicate registration',
        )
        insist(
          detail(
            await call('register', {
              descriptor: { ...descriptor, digest: '0'.repeat(64) },
              ownerReleaseSetId: 'fixture-release',
            }),
          ) === 'resources_version_conflict',
          'same version changed',
        )
        insist(
          detail(await call('remove', { id: descriptor.id, expectedRevision: 0 })) ===
            'resources_revision_conflict',
          'stale remove',
        )
        insist(
          detail(
            await call('retain', {
              resource: { kind: 'interaction', value: { interactionId: 'not-a-resource' } },
              purpose: 'history',
            }),
          ) === 'resources_not_resource',
          'non-resource input is not acquisition',
        )
        const unseen = resourceCatalogDescriptor('unseen')
        insist(
          (await call('register', { descriptor: unseen, ownerReleaseSetId: 'fixture-release' })).ok,
          'registered without a query',
        )
        insist(
          detail(await call('retain', { resource: resourceRef(unseen), purpose: 'job' })) ===
            'resources_not_discovered',
          'register does not discover',
        )
        const forged: RetentionRef = {
          kind: 'domain-record',
          authorityId: 'agh.resources',
          resourceId: descriptor.id,
          version: descriptor.version,
          digest: descriptor.digest,
          pinId: 'forged-pin',
        }
        insist(
          detail(await call('release', { retention: forged, reason: 'forged' })) === 'resources_pin_unknown',
          'forged pin refused',
        )
        insist(
          (
            await call('register', {
              descriptor: resourceCatalogDescriptor('z-review'),
              ownerReleaseSetId: 'fixture-release',
            })
          ).ok,
          'pagination setup',
        )
        const page = resourceCatalogValue<{ items: ResourceDescriptor[]; nextCursor: string | null }>(
          'ResourcesListResult',
          await call('list', query),
        )
        insist(
          page.items[0]?.id === descriptor.id && page.nextCursor !== null,
          'first page stays the discovered resource',
        )
        insist(
          (
            await call('register', {
              descriptor: { ...descriptor, version: '2' },
              ownerReleaseSetId: 'fixture-release',
            })
          ).ok,
          'new version',
        )
        insist(
          detail(await call('list', { ...query, cursor: page.nextCursor })) === 'resources_cursor_stale',
          'old catalog cursor',
        )
        insist(
          detail(await call('describe', { resourceId: descriptor.id, version: '1' })) ===
            'resources_version_stale',
          'old resource version',
        )
        insist(
          detail(await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })) ===
            'resources_version_stale',
          'retain does not follow the new version',
        )
        const latest = { ...descriptor, version: '2' }
        insist(
          detail(await call('retain', { resource: resourceRef(latest), purpose: 'artifact' })) ===
            'resources_not_discovered',
          'latest is not pinned without a new query',
        )
        break
      }
      case 'cancel': {
        const controller = new AbortController()
        options.discover = async () => {
          controller.abort()
          await new Promise<void>(() => {})
        }
        insist(
          detail(await call('list', query, resourceCatalogContext(controller.signal))) ===
            'resources_cancelled',
          'in-flight discovery cancelled',
        )
        options.discover = async () => {}
        insist((await call('list', query)).ok, 'catalog unchanged after cancellation')
        controller.abort()
        insist(
          detail(
            await call(
              'remove',
              { id: descriptor.id, expectedRevision: 1 },
              resourceCatalogContext(controller.signal),
            ),
          ) === 'resources_cancelled',
          'cancelled maintenance',
        )
        break
      }
      case 'recover': {
        const changed = { ...descriptor, version: '2' }
        insist(
          (await call('register', { descriptor: changed, ownerReleaseSetId: 'fixture-release' })).ok,
          'persist updated catalog',
        )
        subject.close()
        const cold = await binding.coldRead(directory, changed)
        insist(
          cold.ok &&
            canonicalJsonDigest(resourceCatalogValue<ResourceDescriptor>('ResourceDescriptor', cold)) ===
              canonicalJsonDigest(changed),
          'cold process recovered exact catalog version',
        )
        break
      }
      case 'dispose': {
        subject.close()
        subject.close()
        insist(detail(await call('list', query)) === 'resources_closed', 'disposed queries refused')
        insist(
          detail(await call('remove', { id: descriptor.id, expectedRevision: 1 })) === 'resources_closed',
          'disposed mutations refused',
        )
        insist(
          detail(await call('retain', { resource: resourceRef(descriptor), purpose: 'continuation' })) ===
            'resources_closed',
          'disposed retain refused',
        )
        break
      }
    }
  } finally {
    subject.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

export function registerResourceCatalogContract(
  harness: ConformanceHarness,
  binding: ResourceCatalogContractBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.resources',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        await exerciseResourceCatalog(binding, scenario)
        return {
          id: `agh.resources/${binding.providerId}/catalog/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'versioned-resource-catalog',
          features: ['list', 'describe', 'register', 'remove', 'retain', 'release'],
          build: binding.build,
          consumer: 'detached-resource-catalog-consumer',
          command: binding.command,
          status: 'passed',
          configDigest: canonicalJsonDigest(resourceCatalogScope),
          releaseSetDigest: canonicalJsonDigest('fixture-release'),
          attachmentDigest: canonicalJsonDigest({
            implemented: [...RESOURCE_CATALOG_COVERAGE.implemented],
            incomplete: [...RESOURCE_CATALOG_COVERAGE.incomplete],
          }),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: 'query',
            lifecycle:
              scenario === 'recover' || scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
