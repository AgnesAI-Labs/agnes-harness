import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyPrepareResult,
  AssemblyPublishResult,
  MaintenanceEnvelopeJsonValue,
  ReleaseSet,
} from '@agnes/protocol/runtime'
import type { AssemblyCandidate, CandidateLifecycle } from './candidate.js'
import type { ReleaseSetInputs } from './inputs.js'
import { readLocatorRoute } from './inputs.js'
import {
  type AssemblyMaintenancePorts,
  authorizeMaintenance,
  journalCommit,
  journalData,
  journalEvent,
  journalMutation,
  journalRead,
  journalRef,
  MaintenanceFailure,
  maintenanceOutcome,
  releaseSnapshot,
} from './maintenance-journal.js'
import { array, digest, equal, fields, freeze, readWire, requireRelease } from './primitives.js'
import { releasePlanFingerprint, revalidateReleasePublication } from './release-set.js'

export function releaseRequiredDigests(release: ReleaseSet): string[] {
  return [
    ...new Set(
      release.packages.flatMap((pkg) => [
        pkg.digest,
        ...Object.values(pkg.entries).map((entry) => entry.digest),
      ]),
    ),
  ].sort()
}

interface PublicationSnapshot {
  records: MaintenanceEnvelopeJsonValue[]
  get(id: string): MaintenanceEnvelopeJsonValue | null
  head: MaintenanceEnvelopeJsonValue
  data: Record<string, unknown>
  authority: import('@agnes/protocol/runtime').StateAuthorityRef
}

/** Private maintenance journal; no startup registration or Runtime admission coordination. */
export class AssemblyPublication {
  readonly input: ReleaseSetInputs
  #validated: { key: string; release: ReleaseSet } | undefined
  constructor(
    input: ReleaseSetInputs,
    readonly ports: AssemblyMaintenancePorts,
  ) {
    this.input = freeze(structuredClone(input))
  }
  get ids() {
    const plan = this.input.plan
    return {
      plan: `plan:${plan.planId}`,
      operation: `upgrade:${plan.upgradeId}`,
      release: `release:${plan.targetReleaseSet.releaseSetId}`,
      route: `release-route:${plan.routeId}`,
      cutover: `cutover:${plan.upgradeId}`,
      transaction: `publish:${plan.upgradeId}`,
    }
  }
  async #records(context: CallContext): Promise<PublicationSnapshot> {
    await authorizeMaintenance(this.ports, context, this.input.plan)
    const records: MaintenanceEnvelopeJsonValue[] = []
    for (const id of [
      this.ports.headRecordId,
      this.ids.plan,
      this.ids.operation,
      this.ids.release,
      this.ids.route,
      this.ids.cutover,
      ...this.input.plan.requiredPins.map((pin) => `pin:${pin}`),
    ])
      records.push(...(await journalRead(this.ports, [id], context)))
    const get = (id: string) => records.find((row) => row.recordId === id) ?? null
    const head = get(this.ports.headRecordId)
    requireRelease(head, 'maintenance_head_unavailable', '/maintenance/head')
    requireRelease(
      head.writerEpoch === this.ports.writerEpoch,
      'maintenance_epoch_mismatch',
      '/maintenance/epoch',
    )
    const data = fields(
      journalData(head, 'current-head'),
      ['directory', 'jointDomains', 'migrations', 'stateAuthorityRef'],
      '/maintenance/head',
    )
    const authority = readWire('StateAuthorityRef', data.stateAuthorityRef)
    requireRelease(
      authority.tenantId === this.ports.authority.tenantId,
      'maintenance_authority_mismatch',
      '/maintenance/head',
    )
    return { records, get, head, data, authority }
  }
  #revalidate(snapshot: PublicationSnapshot) {
    const directory = readLocatorRoute(snapshot.data.directory)
    const route = snapshot.get(this.ids.route)
    if (route) {
      const active = fields(
        journalData(route, 'release-route'),
        ['routeId', 'activeReleaseSetId', 'authorityEpoch', 'cutoverId'],
        '/maintenance/route',
      )
      requireRelease(
        active.routeId === directory.routeId && active.authorityEpoch === snapshot.authority.authorityEpoch,
        'locator_route_stale',
        '/maintenance/route',
      )
      directory.routeRevision = route.revision
      directory.releaseSetId = readWire('Id', active.activeReleaseSetId)
    } else {
      directory.routeRevision = null
      directory.releaseSetId = null
    }
    requireRelease(
      this.input.plan.planFingerprint === releasePlanFingerprint(this.input.plan),
      'plan_fingerprint_mismatch',
      '/plan/planFingerprint',
    )
    const observation = {
      now: readWire('Timestamp', this.ports.now()),
      directory,
      jointDomains: snapshot.data.jointDomains,
      migrations: snapshot.data.migrations,
    }
    const key = digest(observation)
    // The captured input is immutable. Only identical current evidence and time can reuse its full validation.
    if (this.#validated?.key === key) return this.#validated.release
    const current = revalidateReleasePublication(this.input, observation)
    if (!current.ok) throw new MaintenanceFailure(current.error)
    this.#validated = { key, release: current.value }
    return current.value
  }
  #guard(snapshot: PublicationSnapshot, now: string) {
    return journalMutation(
      this.ports,
      snapshot.head.recordId,
      'current-head',
      snapshot.data,
      snapshot.head,
      now,
    )
  }
  #operation(record: MaintenanceEnvelopeJsonValue | null): Record<string, unknown> | null {
    if (!record) return null
    const data = fields(
      journalData(record, 'upgrade-operation'),
      [
        'upgradeId',
        'kind',
        'planFingerprint',
        'sourceRef',
        'targetRef',
        'expectedHeads',
        'state',
        'resumeFrom',
        'policyRef',
        'actorRef',
        'recoveryOwnerRef',
        'reason',
        'checkpoints',
        'candidateRef',
        'commitRef',
      ],
      '/maintenance/operation',
    )
    requireRelease(
      data.upgradeId === this.input.plan.upgradeId &&
        data.kind === 'release' &&
        data.planFingerprint === releasePlanFingerprint(this.input.plan),
      'upgrade_fingerprint_conflict',
      '/maintenance/operation',
    )
    requireRelease(
      equal(data.targetRef, this.#releasePointer(this.input.plan.targetReleaseSet)) &&
        data.policyRef === this.input.plan.authorizedBy,
      'plan_journal_mismatch',
      '/maintenance/operation',
    )
    return data
  }
  #planData() {
    const { targetReleaseSet, ...plan } = this.input.plan
    return {
      plan: { ...plan, targetReleaseSetId: targetReleaseSet.releaseSetId },
      graph: {
        graphId: this.input.graph.graphId,
        digest: this.input.graph.digest,
        lockDigest: this.input.graph.lock.digest,
        configDigest:
          this.input.graph.configRef.kind === 'inline'
            ? this.input.graph.configRef.digest
            : this.input.graph.configRef.blob.digest,
      },
    }
  }
  #releasePointer(release: ReleaseSet) {
    return journalRef(
      { recordId: `release:${release.releaseSetId}`, contentDigest: releaseSnapshot(release).contentDigest },
      'release-set-record',
    )
  }
  #checkPlan(snapshot: PublicationSnapshot) {
    const record = snapshot.get(this.ids.plan)
    const release = snapshot.get(this.ids.release)
    requireRelease(
      release &&
        equal(journalData(release, 'release-snapshot'), releaseSnapshot(this.input.plan.targetReleaseSet)),
      'release_digest_mismatch',
      '/maintenance/release',
    )
    requireRelease(
      record && equal(journalData(record, 'release-plan'), this.#planData()),
      'plan_journal_mismatch',
      '/maintenance/plan',
    )
  }
  async stage(context: CallContext): Promise<Outcome<void>> {
    return this.#outcome(async () => {
      const snapshot = await this.#records(context),
        op = this.#operation(snapshot.get(this.ids.operation))
      this.#revalidate(snapshot)
      if (op) {
        this.#checkPlan(snapshot)
        return
      }
      const now = readWire('Timestamp', this.ports.now()),
        plan = this.input.plan,
        target = plan.targetReleaseSet
      requireRelease(
        new Set(plan.requiredPins).size === plan.requiredPins.length && plan.requiredPins.length > 0,
        'package_pin_missing',
        '/plan/requiredPins',
      )
      const source = this.input.fixture.previousRelease
      const operation = {
        upgradeId: plan.upgradeId,
        kind: 'release',
        planFingerprint: plan.planFingerprint,
        sourceRef: source ? this.#releasePointer(source) : null,
        targetRef: this.#releasePointer(target),
        expectedHeads: {
          kind: 'release',
          routeId: plan.routeId,
          routeRevision: plan.expectedRouteRevision,
          releaseSetId: plan.sourceReleaseSetId,
        },
        state: 'planned',
        resumeFrom: null,
        policyRef: plan.authorizedBy,
        actorRef: context.principalRef,
        recoveryOwnerRef: this.ports.authority.authorityId,
        reason: plan.operation,
        checkpoints: [],
        candidateRef: null,
        commitRef: null,
      }
      const mutations = [
        this.#guard(snapshot, now),
        journalMutation(this.ports, this.ids.plan, 'release-plan', this.#planData(), null, now),
        journalMutation(this.ports, this.ids.operation, 'upgrade-operation', operation, null, now),
      ]
      const oldRelease = snapshot.get(this.ids.release)
      if (oldRelease)
        requireRelease(
          equal(journalData(oldRelease, 'release-snapshot'), releaseSnapshot(target)),
          'release_digest_mismatch',
          '/maintenance/release',
        )
      else
        mutations.push(
          journalMutation(
            this.ports,
            this.ids.release,
            'release-snapshot',
            releaseSnapshot(target),
            null,
            now,
          ),
        )
      for (const pinId of plan.requiredPins) {
        requireRelease(!snapshot.get(`pin:${pinId}`), 'package_pin_conflict', '/maintenance/pin')
        mutations.push(
          journalMutation(
            this.ports,
            `pin:${pinId}`,
            'package-pin-receipt',
            {
              pinId,
              releaseSetId: target.releaseSetId,
              requiredDigests: releaseRequiredDigests(target),
              maintenanceCommitId: `stage:${plan.upgradeId}`,
              issuer: this.ports.authority,
              scope: context.scope,
              ownerKind: 'upgrade',
              ownerId: plan.upgradeId,
              status: 'active',
            },
            null,
            now,
          ),
        )
      }
      await journalCommit(this.ports, `stage:${plan.upgradeId}`, mutations, [], context)
    })
  }
  async beginPrepare(context: CallContext): Promise<Outcome<void>> {
    return this.#outcome(async () => {
      const snapshot = await this.#records(context),
        record = snapshot.get(this.ids.operation),
        op = this.#operation(record)
      this.#checkPlan(snapshot)
      requireRelease(op && record, 'plan_journal_mismatch', '/maintenance/operation')
      if (op.state === 'preparing' || op.state === 'verified') return
      requireRelease(op.state === 'planned', 'candidate_not_prepared', '/maintenance/operation')
      this.#revalidate(snapshot)
      const now = readWire('Timestamp', this.ports.now())
      await journalCommit(
        this.ports,
        `prepare:${this.input.plan.upgradeId}`,
        [
          this.#guard(snapshot, now),
          journalMutation(
            this.ports,
            this.ids.operation,
            'upgrade-operation',
            {
              ...op,
              state: 'preparing',
              checkpoints: [
                {
                  key: 'preparing',
                  inputDigest: this.input.plan.planFingerprint,
                  evidence: [journalRef(this.#planData(), 'release-plan-record')],
                  completedAt: now,
                },
              ],
            },
            record,
            now,
          ),
        ],
        [],
        context,
      )
    })
  }
  async verified(
    prepared: AssemblyPrepareResult,
    generationId: string,
    context: CallContext,
  ): Promise<Outcome<AssemblyPrepareResult>> {
    return this.#outcome(async () => {
      const snapshot = await this.#records(context),
        record = snapshot.get(this.ids.operation),
        op = this.#operation(record)
      this.#checkPlan(snapshot)
      requireRelease(op && record, 'plan_journal_mismatch', '/maintenance/operation')
      const candidateRef = journalRef(
        {
          kind: 'journal-assembly-candidate',
          qualification: 'persistent-fixture',
          generationId,
          graphId: this.input.graph.graphId,
          graphDigest: this.input.graph.digest,
          releaseSetId: this.input.plan.targetReleaseSet.releaseSetId,
          planId: this.input.plan.planId,
          upgradeId: this.input.plan.upgradeId,
          planFingerprint: this.input.plan.planFingerprint,
          planRecordId: this.ids.plan,
          operationRecordId: this.ids.operation,
          memoryCandidateRef: prepared.candidateRef,
        },
        'journal-candidate',
      )
      if (op.state === 'verified' || op.state === 'committed') {
        requireRelease(
          equal(op.candidateRef, candidateRef),
          'candidate_journal_mismatch',
          '/maintenance/candidate',
        )
        return { candidateRef, readiness: prepared.readiness }
      }
      requireRelease(
        op.state === 'preparing' && prepared.readiness.state === 'ready',
        'candidate_not_prepared',
        '/maintenance/candidate',
      )
      this.#revalidate(snapshot)
      const now = readWire('Timestamp', this.ports.now())
      await journalCommit(
        this.ports,
        `verify:${this.input.plan.upgradeId}`,
        [
          this.#guard(snapshot, now),
          journalMutation(
            this.ports,
            this.ids.operation,
            'upgrade-operation',
            {
              ...op,
              state: 'verified',
              candidateRef,
              checkpoints: [
                ...array(op.checkpoints, '/maintenance/checkpoints'),
                {
                  key: 'candidate-ready',
                  inputDigest: this.input.plan.planFingerprint,
                  evidence: [candidateRef],
                  completedAt: now,
                },
              ],
            },
            record,
            now,
          ),
        ],
        [],
        context,
      )
      return { candidateRef, readiness: prepared.readiness }
    })
  }
  async publish(
    request: unknown,
    candidate: AssemblyCandidate | undefined,
    lifecycle: CandidateLifecycle | undefined,
    context: CallContext,
  ): Promise<Outcome<AssemblyPublishResult>> {
    return this.#outcome(async () => {
      const parsed = readWire('AssemblyPublishRequest', request),
        snapshot = await this.#records(context)
      const record = snapshot.get(this.ids.operation),
        op = this.#operation(record)
      this.#checkPlan(snapshot)
      requireRelease(
        op && record && equal(op.candidateRef, parsed.candidateRef),
        'candidate_journal_mismatch',
        '/publish/candidateRef',
      )
      requireRelease(
        parsed.expectedPublishedRevision === (this.input.plan.expectedRouteRevision ?? 0),
        'plan_stale',
        '/publish/revision',
      )
      const releaseRef = this.#releasePointer(this.input.plan.targetReleaseSet)
      if (op.state === 'committed') {
        const cutover = snapshot.get(this.ids.cutover)
        requireRelease(
          cutover &&
            journalData(cutover, 'cutover-record').commitRef === this.ids.transaction &&
            equal(journalData(cutover, 'cutover-record').targetRef, releaseRef) &&
            op.commitRef === this.ids.transaction,
          'maintenance_commit_mismatch',
          '/publish/replay',
        )
        const activeRoute = snapshot.get(this.ids.route)
        if (
          activeRoute &&
          journalData(activeRoute, 'release-route').cutoverId === this.ids.cutover &&
          lifecycle?.view()?.staged
        )
          lifecycle.activate?.()
        return { releaseRef: journalRef(this.input.plan.targetReleaseSet, 'release-set') }
      }
      requireRelease(
        op.state === 'verified' &&
          candidate?.inspect().state === 'ready' &&
          lifecycle?.view()?.state === 'ready' &&
          lifecycle.view()?.staged &&
          lifecycle.activate,
        'candidate_not_prepared',
        '/publish/candidate',
      )
      const candidateBody = parsed.candidateRef.kind === 'inline' ? parsed.candidateRef.value : null
      requireRelease(
        candidateBody &&
          typeof candidateBody === 'object' &&
          !Array.isArray(candidateBody) &&
          equal(candidateBody.memoryCandidateRef, candidate.inspect().candidateRef),
        'candidate_journal_mismatch',
        '/publish/candidate',
      )
      this.#revalidate(snapshot)
      for (const pinId of this.input.plan.requiredPins) {
        const record = snapshot.get(`pin:${pinId}`)
        requireRelease(
          record &&
            journalData(record, 'package-pin-receipt').status === 'active' &&
            journalData(record, 'package-pin-receipt').releaseSetId ===
              this.input.plan.targetReleaseSet.releaseSetId &&
            equal(
              journalData(record, 'package-pin-receipt').requiredDigests,
              releaseRequiredDigests(this.input.plan.targetReleaseSet),
            ),
          'package_pin_missing',
          '/publish/pins',
        )
      }
      await authorizeMaintenance(this.ports, context, this.input.plan)
      const now = readWire('Timestamp', this.ports.now()),
        route = snapshot.get(this.ids.route)
      const routeData = {
        routeId: this.input.plan.routeId,
        activeReleaseSetId: this.input.plan.targetReleaseSet.releaseSetId,
        authorityEpoch: snapshot.authority.authorityEpoch,
        cutoverId: this.ids.cutover,
      }
      const cutover = {
        cutoverId: this.ids.cutover,
        upgradeId: this.input.plan.upgradeId,
        kind: 'release',
        sourceRef: op.sourceRef,
        targetRef: releaseRef,
        expectedHeads: op.expectedHeads,
        fenceProofRef: null,
        validationRef: parsed.candidateRef,
        commitRef: this.ids.transaction,
        committedAt: now,
      }
      const mutations = [
        this.#guard(snapshot, now),
        journalMutation(this.ports, this.ids.route, 'release-route', routeData, route, now),
        journalMutation(this.ports, this.ids.cutover, 'cutover-record', cutover, null, now),
        journalMutation(
          this.ports,
          this.ids.operation,
          'upgrade-operation',
          {
            ...op,
            state: 'committed',
            commitRef: this.ids.transaction,
            checkpoints: [
              ...array(op.checkpoints, '/maintenance/checkpoints'),
              {
                key: 'cutting-over',
                inputDigest: this.input.plan.planFingerprint,
                evidence: [parsed.candidateRef],
                completedAt: now,
              },
              {
                key: 'route-committed',
                inputDigest: this.input.plan.planFingerprint,
                evidence: [parsed.candidateRef, releaseRef],
                completedAt: now,
              },
            ],
          },
          record,
          now,
        ),
      ]
      for (const pinId of this.input.plan.requiredPins) {
        const pinRecord = snapshot.get(`pin:${pinId}`)
        requireRelease(pinRecord, 'package_pin_missing', '/publish/pins')
        mutations.push(
          journalMutation(
            this.ports,
            pinRecord.recordId,
            'package-pin-receipt',
            journalData(pinRecord, 'package-pin-receipt'),
            pinRecord,
            now,
          ),
        )
      }
      await journalCommit(
        this.ports,
        this.ids.transaction,
        mutations,
        [journalEvent(this.ports, this.ids.transaction, now, routeData)],
        context,
      )
      // No author code executes here. Durable route is authoritative even if local activation fails.
      lifecycle.activate()
      return { releaseRef: journalRef(this.input.plan.targetReleaseSet, 'release-set') }
    })
  }
  async #outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    return maintenanceOutcome(work)
  }
}
