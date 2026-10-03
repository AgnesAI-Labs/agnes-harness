import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  AssemblyGraph,
  DispatchAtomicDomain,
  MaintenanceStoreCommitRequest,
  ReleasePlan,
  ReleaseSet,
} from '@agnes/protocol/runtime'
import { memoryAssemblyLifecycle } from './assembly-lifecycle.js'
import { maintenanceStoreFixture } from './assembly-maintenance-store.js'
import { fixtureHash, fixtureWire } from './assembly-maintenance-wire.js'

export interface MaintenanceAssemblyInput {
  graph: AssemblyGraph
  plan: ReleasePlan
  fixture: {
    now: string
    directory: unknown
    jointDomains: DispatchAtomicDomain[]
    migrations: unknown[]
    previousRelease: ReleaseSet | null
  }
}
export const assemblyMaintenanceContext = (signal = new AbortController().signal): CallContext => ({
  signal,
  principalRef: 'fixture-principal',
  bindingId: 'fixture-binding',
  invocationId: 'fixture-invocation',
  deadline: '2030-01-01T00:00:00Z',
  traceRef: 'fixture-trace',
  authorizationRef: 'fixture-authorization',
  scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
})
export function maintenanceFixtureRecord(recordId: string, kind: string, data: unknown, revision = 1) {
  const typeId = `agh.assembly/${kind}@1`,
    payload = fixtureWire('JsonValue', {
      schemaStatus: 'provisional-awaiting-protocol-owner-confirmation',
      kind,
      data,
    })
  return fixtureWire('MaintenanceEnvelopeJsonValue', {
    recordId,
    revision,
    writerEpoch: 1,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    schema: {
      typeId,
      revision: 1,
      digest: fixtureHash({ typeId, schemaStatus: 'provisional-awaiting-protocol-owner-confirmation' }),
    },
    payload,
    fingerprint: fixtureHash(payload),
  })
}
export function maintenancePayload(record: { payload: unknown } | undefined) {
  const value = fixtureWire('JsonValue', record?.payload)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data)
  )
    throw new Error('fixture record missing')
  return value.data
}

export async function persistentAssemblyFixture(
  input: MaintenanceAssemblyInput,
  file: string,
  options: {
    beforeCommit?: (request: MaintenanceStoreCommitRequest, context: CallContext) => Promise<void>
    afterCommit?: (request: MaintenanceStoreCommitRequest, context: CallContext) => Promise<void>
    lifecycle?: boolean
  } = {},
) {
  let started = () => {}
  const paused = new Promise<void>((resolve) => {
    started = resolve
  })
  const control = { authorized: true, now: input.fixture.now, failCommit: false, pauseCommit: false }
  const database = maintenanceStoreFixture(file, {
    async beforeCommit(request, context) {
      if (request.transactionId.startsWith('publish:')) {
        if (control.pauseCommit) {
          started()
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve()
            else context.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        if (control.failCommit) throw new Error('fixture_commit_failed')
      }
      await options.beforeCommit?.(request, context)
    },
    ...(options.afterCommit ? { afterCommit: options.afterCommit } : {}),
  })
  const stateAuthorityRef = { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 }
  const headRecordId = 'fixture-current-head'
  if (!database.get(headRecordId)) {
    database.seed(
      maintenanceFixtureRecord(headRecordId, 'current-head', {
        directory: input.fixture.directory,
        jointDomains: input.fixture.jointDomains,
        migrations: input.fixture.migrations,
        stateAuthorityRef,
      }),
    )
    const prior = input.fixture.previousRelease
    if (prior && input.plan.sourceReleaseSetId) {
      database.seed(
        maintenanceFixtureRecord(`release:${prior.releaseSetId}`, 'release-snapshot', {
          canonicalJson: jcs(prior),
          contentDigest: fixtureHash(prior),
        }),
      )
      database.seed(
        maintenanceFixtureRecord(
          `release-route:${input.plan.routeId}`,
          'release-route',
          {
            routeId: input.plan.routeId,
            activeReleaseSetId: prior.releaseSetId,
            authorityEpoch: 1,
            cutoverId: 'fixture-original',
          },
          input.plan.expectedRouteRevision ?? 1,
        ),
      )
    }
  }
  const ports = {
    qualification: 'persistent-fixture' as const,
    store: database.store,
    authority: database.authority,
    target: database.target,
    writerEpoch: 1,
    headRecordId,
    credential: {
      principalRef: 'fixture-principal',
      directoryId: 'fixture-directory',
      credentialDigest: fixtureHash('synthetic credential'),
    },
    now: () => control.now,
    async authorize(context: CallContext, plan: { authorizedBy: string } | null) {
      return (
        control.authorized &&
        context.principalRef === 'fixture-principal' &&
        context.authorizationRef === 'fixture-authorization' &&
        context.scope.kind === 'runtime' &&
        context.scope.installationId === 'fixture-installation' &&
        (plan === null || plan.authorizedBy === 'fixture-authorizer')
      )
    },
  }
  const schemas = input.plan.targetReleaseSet.schemasRef
  if (
    schemas.kind !== 'inline' ||
    !schemas.value ||
    typeof schemas.value !== 'object' ||
    Array.isArray(schemas.value) ||
    !Array.isArray(schemas.value.contracts)
  )
    throw new Error('fixture requires inline schema catalog')
  const contracts = schemas.value.contracts.map((row) => fixtureWire('CommunityContractDefinition', row))
  const memory =
    options.lifecycle === false
      ? undefined
      : await memoryAssemblyLifecycle({
          graph: input.graph,
          plan: {
            targetReleaseSet: {
              releaseSetId: input.plan.targetReleaseSet.releaseSetId,
              schemasRef: { value: { contracts } },
            },
          },
        })
  let changes = 0
  return {
    ports,
    database,
    memory,
    control,
    paused,
    file,
    stateAuthorityRef,
    current() {
      return memory?.lifecycle.view()
    },
    async updateHead(change: (data: ReturnType<typeof maintenancePayload>) => void) {
      const previous = database.get(headRecordId)
      if (!previous) throw new Error('fixture head missing')
      const data = structuredClone(maintenancePayload(previous))
      change(data)
      const result = await database.store.commit(
        {
          transactionId: `fixture-head-change:${++changes}`,
          authority: database.authority,
          expectedWriterEpoch: 1,
          mutations: [
            {
              recordId: headRecordId,
              expectedRevision: previous.revision,
              next: maintenanceFixtureRecord(headRecordId, 'current-head', data, previous.revision + 1),
            },
          ],
          outbox: [],
        },
        assemblyMaintenanceContext(),
      )
      if (!result.ok) throw new Error(result.error.detailCode)
    },
    async close() {
      await memory?.cleanup()
      database.close()
    },
  }
}
