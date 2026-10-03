import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyGraph,
  AssemblyPrepareResult,
  AssemblyPublishResult,
  MaintenanceEnvelopeJsonValue,
  ReleasePlan,
} from '@agnes/protocol/runtime'
import { constructReferenceReleaseSet } from './assembly.js'
import type { ReferenceCandidateLifecycle } from './assembly-candidate.js'
import {
  assertJournal,
  JournalFault,
  journalHash,
  journalSame,
  journalWire,
  type ReferenceMaintenancePorts,
  referenceAuthorized,
  referenceBody,
  referenceCommit,
  referenceDigests,
  referenceObject,
  referenceRead,
  referenceRef,
  referenceResult,
  referenceSnapshot,
  referenceWrite,
} from './assembly-journal.js'

export function referencePublication(
  input: { plan: ReleasePlan; graph: AssemblyGraph; raw: unknown },
  ports: ReferenceMaintenancePorts,
) {
  const plan = structuredClone(input.plan),
    graph = structuredClone(input.graph),
    rawInput = structuredClone(input.raw)
  let acceptedEvidence: string | undefined
  let acceptedRelease: ReleasePlan['targetReleaseSet'] | undefined
  const keys = {
    plan: `plan:${plan.planId}`,
    operation: `upgrade:${plan.upgradeId}`,
    release: `release:${plan.targetReleaseSet.releaseSetId}`,
    route: `release-route:${plan.routeId}`,
    cutover: `cutover:${plan.upgradeId}`,
    transaction: `publish:${plan.upgradeId}`,
  }
  const planData = () => {
    const compact = { ...plan } as Record<string, unknown>
    delete compact.targetReleaseSet
    compact.targetReleaseSetId = plan.targetReleaseSet.releaseSetId
    return {
      plan: compact,
      graph: {
        digest: graph.digest,
        graphId: graph.graphId,
        configDigest: graph.configRef.kind === 'blob' ? graph.configRef.blob.digest : graph.configRef.digest,
        lockDigest: graph.lock.digest,
      },
    }
  }
  const releasePointer = (release: ReleasePlan['targetReleaseSet']) => {
    return referenceRef(
      {
        contentDigest: referenceSnapshot(release).contentDigest,
        recordId: `release:${release.releaseSetId}`,
      },
      'release-set-record',
    )
  }
  const time = () => journalWire('Timestamp', ports.now())
  async function load(call: CallContext) {
    await referenceAuthorized(ports, call, plan)
    const entries = await referenceRead(ports, call, [
      ports.headRecordId,
      keys.plan,
      keys.operation,
      keys.release,
      keys.route,
      keys.cutover,
      ...plan.requiredPins.map((id) => `pin:${id}`),
    ])
    const index = new Map(entries.map((row) => [row.recordId, row]))
    const read = (id: string) => index.get(id) ?? null
    const header = read(ports.headRecordId)
    assertJournal(header, 'maintenance_head_unavailable')
    assertJournal(header.writerEpoch === ports.writerEpoch, 'maintenance_epoch_mismatch')
    const observation = referenceObject(referenceBody(header, 'current-head'), [
      'directory',
      'jointDomains',
      'migrations',
      'stateAuthorityRef',
    ])
    const authority = journalWire('StateAuthorityRef', observation.stateAuthorityRef)
    assertJournal(authority.tenantId === ports.authority.tenantId, 'maintenance_authority_mismatch')
    const guard = (at: string) =>
      referenceWrite(ports, header.recordId, 'current-head', observation, header, at)
    return { read, observation, authority, guard }
  }
  type View = Awaited<ReturnType<typeof load>>
  function checkPlan(view: View) {
    const saved = view.read(keys.plan),
      release = view.read(keys.release)
    assertJournal(
      release &&
        journalSame(referenceBody(release, 'release-snapshot'), referenceSnapshot(plan.targetReleaseSet)),
      'release_digest_mismatch',
    )
    assertJournal(
      saved && journalSame(referenceBody(saved, 'release-plan'), planData()),
      'plan_journal_mismatch',
    )
  }
  function operation(record: MaintenanceEnvelopeJsonValue | null) {
    if (!record) return null
    const item = referenceObject(referenceBody(record, 'upgrade-operation'), [
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
    ])
    const { planFingerprint: omitted, ...body } = plan
    assertJournal(
      item.upgradeId === plan.upgradeId &&
        item.kind === 'release' &&
        item.planFingerprint === journalHash(body),
      'upgrade_fingerprint_conflict',
    )
    assertJournal(
      journalSame(item.targetRef, releasePointer(plan.targetReleaseSet)) &&
        item.policyRef === plan.authorizedBy,
      'plan_journal_mismatch',
    )
    return item
  }
  function validate(view: View) {
    const base = referenceObject(structuredClone(rawInput)),
      fixture = referenceObject(base.fixture)
    const directory = {
      ...referenceObject(view.observation.directory, [
        'locatorId',
        'locatorRevision',
        'directoryEpoch',
        'routeId',
        'routeRevision',
        'releaseSetId',
      ]),
    }
    const route = view.read(keys.route)
    if (route) {
      const value = referenceObject(referenceBody(route, 'release-route'), [
        'routeId',
        'activeReleaseSetId',
        'authorityEpoch',
        'cutoverId',
      ])
      assertJournal(
        value.routeId === directory.routeId && value.authorityEpoch === view.authority.authorityEpoch,
        'locator_route_stale',
      )
      directory.routeRevision = route.revision
      directory.releaseSetId = journalWire('Id', value.activeReleaseSetId)
    } else Object.assign(directory, { routeRevision: null, releaseSetId: null })
    const { planFingerprint, ...identity } = plan
    assertJournal(journalHash(identity) === planFingerprint, 'plan_fingerprint_mismatch')
    const observed = {
      directory,
      now: time(),
      jointDomains: view.observation.jointDomains,
      migrations: view.observation.migrations,
    }
    const evidence = journalHash(observed)
    if (acceptedRelease && evidence === acceptedEvidence) return acceptedRelease
    const checked = constructReferenceReleaseSet({ ...base, fixture: { ...fixture, ...observed } })
    if (!checked.ok) throw new JournalFault(checked.error.detailCode, checked.error)
    acceptedEvidence = evidence
    acceptedRelease = checked.value
    return checked.value
  }
  return {
    async stage(call: CallContext): Promise<Outcome<void>> {
      return referenceResult(async () => {
        const view = await load(call),
          saved = operation(view.read(keys.operation))
        validate(view)
        if (saved) {
          checkPlan(view)
          return
        }
        const at = time(),
          release = plan.targetReleaseSet
        assertJournal(
          plan.requiredPins.length > 0 &&
            plan.requiredPins.every((id, position, pins) => pins.indexOf(id) === position),
          'package_pin_missing',
        )
        const source = referenceObject(referenceObject(rawInput).fixture).previousRelease
        const record = {
          upgradeId: plan.upgradeId,
          kind: 'release',
          planFingerprint: plan.planFingerprint,
          sourceRef: source ? releasePointer(journalWire('ReleaseSet', source)) : null,
          targetRef: releasePointer(release),
          expectedHeads: {
            kind: 'release',
            routeId: plan.routeId,
            routeRevision: plan.expectedRouteRevision,
            releaseSetId: plan.sourceReleaseSetId,
          },
          state: 'planned',
          resumeFrom: null,
          policyRef: plan.authorizedBy,
          actorRef: call.principalRef,
          recoveryOwnerRef: ports.authority.authorityId,
          reason: plan.operation,
          checkpoints: [],
          candidateRef: null,
          commitRef: null,
        }
        const writes = [
          view.guard(at),
          referenceWrite(ports, keys.plan, 'release-plan', planData(), null, at),
          referenceWrite(ports, keys.operation, 'upgrade-operation', record, null, at),
        ]
        const oldRelease = view.read(keys.release)
        if (oldRelease)
          assertJournal(
            journalSame(referenceBody(oldRelease, 'release-snapshot'), referenceSnapshot(release)),
            'release_digest_mismatch',
          )
        else
          writes.push(
            referenceWrite(ports, keys.release, 'release-snapshot', referenceSnapshot(release), null, at),
          )
        plan.requiredPins.forEach((pinId) => {
          assertJournal(!view.read(`pin:${pinId}`), 'package_pin_conflict')
          const pin = {
            pinId,
            releaseSetId: release.releaseSetId,
            requiredDigests: referenceDigests(release),
            maintenanceCommitId: `stage:${plan.upgradeId}`,
            issuer: ports.authority,
            scope: call.scope,
            ownerKind: 'upgrade',
            ownerId: plan.upgradeId,
            status: 'active',
          }
          writes.push(referenceWrite(ports, `pin:${pinId}`, 'package-pin-receipt', pin, null, at))
        })
        await referenceCommit(ports, `stage:${plan.upgradeId}`, writes, [], call)
      })
    },
    async beginPrepare(call: CallContext): Promise<Outcome<void>> {
      return referenceResult(async () => {
        const view = await load(call),
          record = view.read(keys.operation),
          state = operation(record)
        checkPlan(view)
        assertJournal(state && record, 'plan_journal_mismatch')
        if (new Set(['verified', 'preparing']).has(String(state.state))) return
        assertJournal(state.state === 'planned', 'candidate_not_prepared')
        validate(view)
        const at = time()
        const progress = {
          ...state,
          state: 'preparing',
          checkpoints: [
            {
              key: 'preparing',
              inputDigest: plan.planFingerprint,
              evidence: [referenceRef(planData(), 'release-plan-record')],
              completedAt: at,
            },
          ],
        }
        await referenceCommit(
          ports,
          `prepare:${plan.upgradeId}`,
          [view.guard(at), referenceWrite(ports, keys.operation, 'upgrade-operation', progress, record, at)],
          [],
          call,
        )
      })
    },
    async verified(
      result: AssemblyPrepareResult,
      generationId: string,
      call: CallContext,
    ): Promise<Outcome<AssemblyPrepareResult>> {
      return referenceResult(async () => {
        const view = await load(call),
          stored = view.read(keys.operation),
          state = operation(stored)
        checkPlan(view)
        assertJournal(state && stored, 'plan_journal_mismatch')
        const candidateRef = referenceRef(
          {
            kind: 'journal-assembly-candidate',
            qualification: 'persistent-fixture',
            generationId,
            graphId: graph.graphId,
            graphDigest: graph.digest,
            releaseSetId: plan.targetReleaseSet.releaseSetId,
            planId: plan.planId,
            upgradeId: plan.upgradeId,
            planFingerprint: plan.planFingerprint,
            planRecordId: keys.plan,
            operationRecordId: keys.operation,
            memoryCandidateRef: result.candidateRef,
          },
          'journal-candidate',
        )
        const prepared = { candidateRef, readiness: result.readiness }
        if (['verified', 'committed'].includes(String(state.state))) {
          assertJournal(journalSame(state.candidateRef, candidateRef), 'candidate_journal_mismatch')
          return prepared
        }
        assertJournal(
          state.state === 'preparing' && result.readiness.state === 'ready',
          'candidate_not_prepared',
        )
        validate(view)
        const at = time()
        assertJournal(Array.isArray(state.checkpoints), 'schema_invalid')
        await referenceCommit(
          ports,
          `verify:${plan.upgradeId}`,
          [
            view.guard(at),
            referenceWrite(
              ports,
              keys.operation,
              'upgrade-operation',
              {
                ...state,
                state: 'verified',
                candidateRef,
                checkpoints: [
                  ...state.checkpoints,
                  {
                    key: 'candidate-ready',
                    inputDigest: plan.planFingerprint,
                    evidence: [candidateRef],
                    completedAt: at,
                  },
                ],
              },
              stored,
              at,
            ),
          ],
          [],
          call,
        )
        return prepared
      })
    },
    async publish(
      raw: unknown,
      memory: { state: string; candidateRef: unknown } | undefined,
      lifetime: ReferenceCandidateLifecycle | undefined,
      call: CallContext,
    ): Promise<Outcome<AssemblyPublishResult>> {
      return referenceResult(async () => {
        const wanted = journalWire('AssemblyPublishRequest', raw),
          view = await load(call)
        const stored = view.read(keys.operation),
          state = operation(stored)
        checkPlan(view)
        assertJournal(
          state && stored && journalSame(state.candidateRef, wanted.candidateRef),
          'candidate_journal_mismatch',
        )
        assertJournal(wanted.expectedPublishedRevision === (plan.expectedRouteRevision ?? 0), 'plan_stale')
        const releaseRef = releasePointer(plan.targetReleaseSet)
        if (state.state === 'committed') {
          const cut = view.read(keys.cutover)
          assertJournal(
            cut &&
              referenceBody(cut, 'cutover-record').commitRef === keys.transaction &&
              journalSame(referenceBody(cut, 'cutover-record').targetRef, releaseRef) &&
              state.commitRef === keys.transaction,
            'maintenance_commit_mismatch',
          )
          const active = view.read(keys.route)
          if (
            active &&
            referenceBody(active, 'release-route').cutoverId === keys.cutover &&
            lifetime?.view()?.staged
          )
            lifetime.activate?.()
          return { releaseRef: referenceRef(plan.targetReleaseSet, 'release-set') }
        }
        const observation = lifetime?.view()
        assertJournal(
          state.state === 'verified' &&
            memory?.state === 'ready' &&
            observation?.state === 'ready' &&
            observation.staged &&
            lifetime?.activate,
          'candidate_not_prepared',
        )
        const body = wanted.candidateRef.kind === 'inline' ? wanted.candidateRef.value : null
        assertJournal(
          body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            journalSame(body.memoryCandidateRef, memory.candidateRef),
          'candidate_journal_mismatch',
        )
        validate(view)
        for (const pinId of plan.requiredPins) {
          const row = view.read(`pin:${pinId}`)
          assertJournal(row, 'package_pin_missing')
          const pin = referenceBody(row, 'package-pin-receipt')
          assertJournal(
            pin.status === 'active' &&
              pin.releaseSetId === plan.targetReleaseSet.releaseSetId &&
              journalSame(pin.requiredDigests, referenceDigests(plan.targetReleaseSet)),
            'package_pin_missing',
          )
        }
        await referenceAuthorized(ports, call, plan)
        const at = time(),
          oldRoute = view.read(keys.route)
        const route = {
          routeId: plan.routeId,
          activeReleaseSetId: plan.targetReleaseSet.releaseSetId,
          authorityEpoch: view.authority.authorityEpoch,
          cutoverId: keys.cutover,
        }
        const cut = {
          cutoverId: keys.cutover,
          upgradeId: plan.upgradeId,
          kind: 'release',
          sourceRef: state.sourceRef,
          targetRef: releaseRef,
          expectedHeads: state.expectedHeads,
          fenceProofRef: null,
          validationRef: wanted.candidateRef,
          commitRef: keys.transaction,
          committedAt: at,
        }
        assertJournal(Array.isArray(state.checkpoints), 'schema_invalid')
        const updates = [
          view.guard(at),
          referenceWrite(ports, keys.route, 'release-route', route, oldRoute, at),
          referenceWrite(ports, keys.cutover, 'cutover-record', cut, null, at),
          referenceWrite(
            ports,
            keys.operation,
            'upgrade-operation',
            {
              ...state,
              state: 'committed',
              commitRef: keys.transaction,
              checkpoints: [
                ...state.checkpoints,
                {
                  key: 'cutting-over',
                  inputDigest: plan.planFingerprint,
                  evidence: [wanted.candidateRef],
                  completedAt: at,
                },
                {
                  key: 'route-committed',
                  inputDigest: plan.planFingerprint,
                  evidence: [wanted.candidateRef, releaseRef],
                  completedAt: at,
                },
              ],
            },
            stored,
            at,
          ),
        ]
        for (const id of plan.requiredPins) {
          const saved = view.read(`pin:${id}`)
          assertJournal(saved, 'package_pin_missing')
          updates.push(
            referenceWrite(
              ports,
              saved.recordId,
              'package-pin-receipt',
              referenceBody(saved, 'package-pin-receipt'),
              saved,
              at,
            ),
          )
        }
        const notification = referenceRef(route, 'release-published')
        const event = journalWire('OutboxRecord', {
          eventId: `event:${keys.transaction}`,
          sourceAuthorityId: ports.authority.authorityId,
          sourceCommitId: keys.transaction,
          destination: 'assembly-release-route',
          typeId: notification.schema.typeId,
          payload: notification,
          fingerprint: journalHash(route),
          delivery: 'pending',
          attempts: 0,
          nextAttemptAt: at,
          claim: null,
          ackRef: null,
          consecutiveFailures: 0,
          lastError: null,
        })
        await referenceCommit(ports, keys.transaction, updates, [event], call)
        lifetime.activate()
        return { releaseRef: referenceRef(plan.targetReleaseSet, 'release-set') }
      })
    },
  }
}
