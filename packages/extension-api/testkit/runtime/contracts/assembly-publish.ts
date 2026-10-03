import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, MaintenanceStore, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyPrepareResult,
  AssemblyPublishResult,
  BindingRef,
  DataRef,
  MaintenanceEnvelopeJsonValue,
  OutboxRecord,
  ReleasePlan,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import type { BuildIdentity } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import type { AssemblyLifecyclePorts, AssemblyPlanSubject } from './assembly.js'
import {
  type AssemblyFixture,
  assemblyFixture,
  fixtureHash,
  fixtureRef,
  fixtureWire,
  resealAssemblyFixture,
} from './assembly-fixture.js'

export const ASSEMBLY_PUBLICATION_COVERAGE = Object.freeze({
  implemented: [
    'maintenance-publish',
    'route-operation-cutover-outbox-atomicity',
    'package-pin',
    'maintenance-cold-replay',
  ],
  unfinished: ['runtime-admission', 'runtime-cold-recovery', 'persistent-pin-drain', 'production-wiring'],
  schemaStatus: 'provisional-awaiting-protocol-owner-confirmation',
  qualification: 'persistent-fixture',
})
export interface AssemblyMaintenanceFixturePorts {
  qualification: 'persistent-fixture'
  store: MaintenanceStore
  authority: StateAuthorityRef
  target: BindingRef
  credential: { principalRef: string; directoryId: string; credentialDigest: string }
  writerEpoch: number
  headRecordId: string
  now(): string
  authorize(context: CallContext, plan: ReleasePlan | null): Promise<boolean>
}
export interface AssemblyMaintenanceSnapshot {
  records: MaintenanceEnvelopeJsonValue[]
  outbox: OutboxRecord[]
  transactions: string[]
}
export interface AssemblyPublishSubject extends AssemblyPlanSubject {
  publish(request: unknown, context: CallContext): Promise<Outcome<AssemblyPublishResult>>
}
export interface AssemblyPersistentFixture {
  ports: AssemblyMaintenanceFixturePorts
  lifecycle: AssemblyLifecyclePorts
  control: { authorized: boolean; failCommit: boolean; pauseCommit: boolean }
  paused: Promise<void>
  current(): { state: string; staged: boolean } | undefined
  snapshot(): AssemblyMaintenanceSnapshot
  close(): Promise<void>
}
export interface AssemblyPublishContractBinding {
  providerId: string
  providerDigest: string
  command: string
  build: BuildIdentity
  context(): CallContext
  create(
    input: unknown,
    lifecycle?: AssemblyLifecyclePorts,
    maintenance?: AssemblyMaintenanceFixturePorts,
  ): AssemblyPublishSubject
  open(input: AssemblyFixture, directory: string): Promise<AssemblyPersistentFixture>
  coldReplay(directory: string): Promise<{
    published: Outcome<AssemblyPublishResult>
    activePins: Outcome<DataRef[]>
    snapshot: AssemblyMaintenanceSnapshot
  }>
}
export function maintenanceData(record: MaintenanceEnvelopeJsonValue) {
  const body = fixtureWire('JsonValue', record.payload)
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !body.data ||
    typeof body.data !== 'object' ||
    Array.isArray(body.data)
  )
    throw new Error('Malformed maintenance fixture envelope')
  return body.data
}
function snapshotDigest(snapshot: AssemblyMaintenanceSnapshot) {
  return fixtureHash({
    records: snapshot.records.map((row) => fixtureHash(row)),
    outbox: snapshot.outbox.map((row) => fixtureHash(row)),
    transactions: snapshot.transactions,
  })
}
export function upgradeAssemblyFixture(): AssemblyFixture {
  const input = assemblyFixture(),
    release = input.plan.targetReleaseSet
  const previous = structuredClone(release),
    before = structuredClone(input.configuration)
  input.fixture.previousRelease = previous
  input.fixture.previousConfiguration = before
  input.plan.operation = 'upgrade'
  input.plan.expectedRouteRevision = 1
  input.plan.sourceReleaseSetId = previous.releaseSetId
  const directory = { ...input.fixture.directory, routeRevision: 1, releaseSetId: previous.releaseSetId }
  input.fixture.directory = directory
  release.configSnapshotRef.value.directory = structuredClone(directory)
  input.plan.permissionDifference.beforeProfileDigest = before.profileDigest
  input.plan.permissionDifference.added = []
  input.plan.permissionDifference.policyChanges = []
  const pkg = release.packages[0],
    lock = input.resolution.lockGraph.entries[0],
    declared = input.configuration.profile.packages[0]
  if (!pkg || !lock || !declared || declared.source.kind !== 'local')
    throw new Error('Missing source package fixture')
  const tree = fixtureHash('synthetic package v2'),
    manifest = fixtureRef({ packageId: pkg.packageId, version: '2.0.0', packageDigest: tree })
  Object.assign(pkg, { version: '2.0.0', digest: tree, integrityRef: manifest.digest })
  Object.assign(lock, { version: '2.0.0', digest: tree, manifestRef: manifest })
  lock.locator.digest = tree
  declared.source.packageDigest = tree
  declared.manifestDigest = manifest.digest
  for (const row of release.bindings)
    if (row.descriptor.packageDigest !== input.plan.targetReleaseSet.packages[1]?.digest) {
      row.descriptor.packageVersion = '2.0.0'
      row.descriptor.packageDigest = tree
    }
  resealAssemblyFixture(input)
  return input
}

export async function exerciseAssemblyPublication(
  binding: AssemblyPublishContractBinding,
  scenario: 'select' | 'normal' | 'deny' | 'cancel' | 'recover' | 'dispose',
) {
  const input = upgradeAssemblyFixture(),
    directory = mkdtempSync(join(tmpdir(), 'agnes-assembly-publish-'))
  const fixture = await binding.open(input, directory),
    subject = binding.create(input, fixture.lifecycle, fixture.ports)
  try {
    const planned = await subject.plan(
      { configRef: input.graph.configRef, lock: input.graph.lock },
      binding.context(),
    )
    const prepared: Outcome<AssemblyPrepareResult> = await subject.prepare(
      { graph: input.graph },
      binding.context(),
    )
    if (!prepared.ok) throw new Error(prepared.error.detailCode)
    const request = { candidateRef: prepared.value.candidateRef, expectedPublishedRevision: 1 }
    const previous = fixture.snapshot()
    let passed =
      planned.ok &&
      prepared.value.readiness.state === 'ready' &&
      fixture.current()?.staged === true &&
      subject.providerId === `agh.${binding.providerId}/assembly`
    fixture.control.failCommit = scenario === 'deny'
    fixture.control.pauseCommit = scenario === 'cancel'
    const cancel = new AbortController()
    const pending = subject.publish(request, { ...binding.context(), signal: cancel.signal })
    if (scenario === 'cancel') {
      await fixture.paused
      // A separate committed reader must still see exactly the previous route/journal/outbox.
      passed = passed && snapshotDigest(fixture.snapshot()) === snapshotDigest(previous)
      cancel.abort()
    }
    const result = await pending
    if (scenario === 'deny' || scenario === 'cancel')
      passed =
        passed &&
        !result.ok &&
        result.error.detailCode ===
          (scenario === 'deny' ? 'fixture_commit_failed' : 'maintenance_cancelled') &&
        snapshotDigest(fixture.snapshot()) === snapshotDigest(previous) &&
        fixture.current()?.staged === true
    else {
      const snapshot = fixture.snapshot(),
        route = snapshot.records.find((row) => row.recordId === `release-route:${input.plan.routeId}`)
      const operation = snapshot.records.find((row) => row.recordId === `upgrade:${input.plan.upgradeId}`)
      const cutover = snapshot.records.find((row) => row.recordId === `cutover:${input.plan.upgradeId}`)
      const release = snapshot.records.find(
        (row) => row.recordId === `release:${input.plan.targetReleaseSet.releaseSetId}`,
      )
      const pointer = operation ? fixtureWire('DataRef', maintenanceData(operation).targetRef) : null
      passed =
        passed &&
        result.ok &&
        Boolean(
          route &&
            route.revision === 2 &&
            maintenanceData(route).activeReleaseSetId === input.plan.targetReleaseSet.releaseSetId,
        ) &&
        Boolean(operation && maintenanceData(operation).state === 'committed') &&
        Boolean(
          release &&
            pointer?.kind === 'inline' &&
            pointer.value &&
            typeof pointer.value === 'object' &&
            !Array.isArray(pointer.value) &&
            pointer.value.recordId === release.recordId &&
            pointer.value.contentDigest === maintenanceData(release).contentDigest,
        ) &&
        Boolean(cutover && maintenanceData(cutover).commitRef === `publish:${input.plan.upgradeId}`) &&
        snapshot.outbox.length === 1 &&
        snapshot.outbox[0]?.sourceCommitId === `publish:${input.plan.upgradeId}` &&
        fixture.current()?.staged === false
      const repeated = await subject.publish(request, binding.context())
      passed =
        passed &&
        repeated.ok &&
        result.ok &&
        fixtureHash(repeated.value) === fixtureHash(result.value) &&
        snapshotDigest(fixture.snapshot()) === snapshotDigest(snapshot)
      const pins = snapshot.records.filter((row) => row.recordId.startsWith('pin:'))
      passed = passed && pins.length > 0 && pins.every((row) => maintenanceData(row).status === 'active')
      if (scenario === 'recover') {
        writeFileSync(join(directory, 'input.json'), JSON.stringify(input), { mode: 0o600 })
        writeFileSync(join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600 })
        await subject.dispose()
        await fixture.close()
        const cold = await binding.coldReplay(directory)
        passed =
          passed &&
          cold.published.ok &&
          result.ok &&
          fixtureHash(cold.published.value) === fixtureHash(result.value) &&
          cold.activePins.ok &&
          cold.activePins.value.length === pins.length &&
          snapshotDigest(cold.snapshot) === snapshotDigest(snapshot)
      }
      if (scenario === 'dispose') {
        await subject.dispose()
        const stopped = await subject.publish(request, binding.context())
        passed =
          passed &&
          !stopped.ok &&
          stopped.error.detailCode === 'candidate_disposed' &&
          snapshotDigest(fixture.snapshot()) === snapshotDigest(snapshot)
      }
    }
    return { passed, input }
  } finally {
    await subject.dispose()
    await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
export function registerAssemblyPublishContract(
  harness: ConformanceHarness,
  binding: AssemblyPublishContractBinding,
) {
  for (const scenario of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)
    harness.registerCase({
      contract: 'agh.assembly',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const result = await exerciseAssemblyPublication(binding, scenario)
        return {
          id: `agh.assembly/${binding.providerId}/maintenance-publish/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'maintenance-publish/persistent-fixture',
          features: ASSEMBLY_PUBLICATION_COVERAGE.implemented,
          build: binding.build,
          consumer: 'maintenance-assembly-consumer',
          command: binding.command,
          status: result.passed ? 'passed' : 'failed',
          configDigest: result.input.plan.configDigest,
          releaseSetDigest: result.input.plan.targetReleaseSet.releaseSetId,
          attachmentDigest: fixtureHash(ASSEMBLY_PUBLICATION_COVERAGE),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: 'maintenance',
            lifecycle: 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
