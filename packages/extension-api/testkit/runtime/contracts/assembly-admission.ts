import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AdmissionProbe,
  RunAdmission,
  RunBinding,
  SessionControlRequest,
  SessionControlResult,
  SessionControlState,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import type { BuildIdentity } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import { fixtureHash, resealAssemblyFixture } from './assembly-fixture.js'
import { upgradeAssemblyFixture } from './assembly-publish.js'

export function admissionFixtureInput() {
  const input = upgradeAssemblyFixture()
  input.configuration.preset.id = 'fixture-preset-v2'
  resealAssemblyFixture(input)
  return input
}

export const ASSEMBLY_ADMISSION_COVERAGE = Object.freeze({
  implemented: [
    'ticket-state-confirm',
    'cancel-tombstone-pin',
    'pending-next-run-atomic-consumption',
    'restricted-state-cold-recovery',
  ],
  unfinished: [
    'production-state-qualification',
    'production-wiring',
    'authority-migration',
    'full-session-command-set',
  ],
  qualification: 'restricted-persistent-state-fixture',
})
export interface AssemblyAdmissionDraft {
  runKey: string
  admission: Omit<RunAdmission, 'fingerprint' | 'packagePinReceipt'>
  stateAuthorityRef: StateAuthorityRef
  grantRef: string
}
export interface AssemblyAdmissionSubject {
  readonly providerId: string
  coordinate(draft: AssemblyAdmissionDraft, context: CallContext): Promise<Outcome<AdmissionProbe>>
  cancel(ticketId: string, fingerprint: string, context: CallContext): Promise<Outcome<AdmissionProbe>>
  probe(ticketId: string, context: CallContext): Promise<Outcome<AdmissionProbe>>
  submitSessionControl(
    request: SessionControlRequest,
    context: CallContext,
  ): Promise<Outcome<SessionControlResult>>
  readSessionControl(sessionId: string, context: CallContext): Promise<Outcome<SessionControlState>>
  sessionControlStatus(
    sessionId: string,
    requestId: string,
    context: CallContext,
  ): Promise<Outcome<SessionControlResult | null>>
  dispose(): Promise<void>
}
export interface AssemblyAdmissionSnapshot {
  runs: { admission: RunAdmission; binding: RunBinding }[]
  pins: { ticketId: string; status: string }[]
}
export interface AssemblyAdmissionContractBinding {
  providerId: string
  providerDigest: string
  build: BuildIdentity
  command: string
  context(): CallContext
  open(directory: string): Promise<{
    subject: AssemblyAdmissionSubject
    draft(): AssemblyAdmissionDraft
    nextDraft(): AssemblyAdmissionDraft
    switchRoute(): Promise<void>
    nextPreset: { id: string; digest: string }
    issue(draft: AssemblyAdmissionDraft): Promise<Outcome<{ admission: RunAdmission }>>
    snapshot(): AssemblyAdmissionSnapshot
    close(): Promise<void>
  }>
  coldRecover(
    directory: string,
  ): Promise<{ result: Outcome<AdmissionProbe>; snapshot: AssemblyAdmissionSnapshot }>
}
export async function exerciseAssemblyAdmission(
  binding: AssemblyAdmissionContractBinding,
  scenario: 'select' | 'normal' | 'deny' | 'cancel' | 'recover' | 'dispose',
) {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-admission-conformance-'))
  const fixture = await binding.open(directory)
  const draft = fixture.draft(),
    ctx = binding.context()
  let closed = false
  try {
    let passed = false
    if (scenario === 'deny') {
      const result = await fixture.subject.coordinate(draft, { ...ctx, principalRef: 'unauthorized' })
      passed =
        fixture.subject.providerId === `agh.${binding.providerId}/assembly` &&
        !result.ok &&
        result.error.detailCode === 'maintenance_denied' &&
        fixture.snapshot().runs.length === 0 &&
        fixture.snapshot().pins.length === 0
    } else if (scenario === 'cancel') {
      const issued = await fixture.issue(draft)
      if (!issued.ok) throw new Error(issued.error.detailCode)
      const result = await fixture.subject.cancel(
        draft.admission.ticketId,
        issued.value.admission.fingerprint,
        ctx,
      )
      const retry = await fixture.subject.coordinate(draft, ctx)
      passed =
        result.ok &&
        result.value.state === 'cancelled' &&
        retry.ok &&
        fixtureHash(retry.value) === fixtureHash(result.value) &&
        fixture.snapshot().runs.length === 0 &&
        fixture.snapshot().pins.every((pin) => pin.status === 'released')
    } else {
      const result = await fixture.subject.coordinate(draft, ctx)
      const replay = await fixture.subject.coordinate(draft, ctx)
      const snapshot = fixture.snapshot()
      passed =
        result.ok &&
        result.value.state === 'created' &&
        replay.ok &&
        fixtureHash(replay.value) === fixtureHash(result.value) &&
        snapshot.runs.length === 1 &&
        snapshot.runs[0]?.binding.releaseSetId === draft.admission.releaseSetId &&
        snapshot.runs[0]?.binding.bindingId === draft.admission.bindingId &&
        snapshot.pins.length === 1 &&
        snapshot.pins[0]?.status === 'active'
      if (scenario === 'recover') {
        await fixture.close()
        closed = true
        const recovered = await binding.coldRecover(directory)
        passed =
          passed &&
          recovered.result.ok &&
          result.ok &&
          fixtureHash(recovered.result.value) === fixtureHash(result.value) &&
          fixtureHash(recovered.snapshot) === fixtureHash(snapshot)
      }
      if (scenario === 'normal') {
        const before = await fixture.subject.readSessionControl(draft.admission.sessionId, ctx)
        const request: SessionControlRequest = {
          sessionId: draft.admission.sessionId,
          requestId: 'contract-preset-change',
          expectedRevision: before.ok ? before.value.revision : null,
          command: {
            kind: 'set-preset',
            presetId: fixture.nextPreset.id,
            presetDigest: fixture.nextPreset.digest,
            apply: 'next-run',
          },
        }
        const accepted = await fixture.subject.submitSessionControl(request, ctx)
        const pending = await fixture.subject.readSessionControl(draft.admission.sessionId, ctx)
        await fixture.switchRoute()
        const next = await fixture.subject.coordinate(fixture.nextDraft(), ctx)
        const applied = await fixture.subject.sessionControlStatus(request.sessionId, request.requestId, ctx)
        const after = await fixture.subject.readSessionControl(request.sessionId, ctx)
        const previousRun = fixture
          .snapshot()
          .runs.find((run) => run.admission.runId === draft.admission.runId)
        passed =
          passed &&
          accepted.ok &&
          accepted.value.status === 'accepted' &&
          before.ok &&
          pending.ok &&
          fixtureHash(before.value) === fixtureHash(pending.value) &&
          next.ok &&
          next.value.state === 'created' &&
          applied.ok &&
          applied.value?.status === 'applied' &&
          after.ok &&
          after.value.parameters.presetDigest === fixture.nextPreset.digest &&
          fixtureHash(previousRun) === fixtureHash(snapshot.runs[0])
      }
      if (scenario === 'dispose') {
        await fixture.subject.dispose()
        const after = await fixture.subject.coordinate(draft, ctx)
        passed =
          passed &&
          !after.ok &&
          after.error.detailCode === 'admission_disposed' &&
          fixtureHash(snapshot) === fixtureHash(fixture.snapshot())
      }
    }
    return { passed: passed && fixture.subject.providerId === `agh.${binding.providerId}/assembly`, draft }
  } finally {
    if (!closed) await fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
export function registerAssemblyAdmissionContract(
  harness: ConformanceHarness,
  binding: AssemblyAdmissionContractBinding,
) {
  for (const scenario of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)
    harness.registerCase({
      contract: 'agh.assembly',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const result = await exerciseAssemblyAdmission(binding, scenario)
        return {
          id: `agh.assembly/${binding.providerId}/restricted-admission/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'restricted-persistent-state-fixture',
          features: ASSEMBLY_ADMISSION_COVERAGE.implemented,
          build: binding.build,
          consumer: 'restricted-admission-consumer',
          command: binding.command,
          status: result.passed ? 'passed' : 'failed',
          configDigest: fixtureHash(result.draft.admission.input),
          releaseSetDigest: result.draft.admission.releaseSetId,
          attachmentDigest: fixtureHash(ASSEMBLY_ADMISSION_COVERAGE),
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
