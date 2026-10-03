import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import type {
  ConfigResolveResult,
  ReleaseSet,
  RunBinding,
  SessionControlState,
} from '@agnes/protocol/runtime'
import { createReferenceAdmissionTickets } from '../../../../../examples/runtime-reference/src/providers/assembly-admission.js'
import { createReferenceAdmissionCoordinator } from '../../../../../examples/runtime-reference/src/providers/assembly-admission-coordinator.js'
import { createAdmissionCoordinator } from '../../../src/runtime/assembly/admission.js'
import { createAdmissionTickets, type TicketDraft } from '../../../src/runtime/assembly/admission-ticket.js'
import { restrictedAdmissionState } from './assembly-admission-state.js'
import {
  assemblyMaintenanceContext,
  type MaintenanceAssemblyInput,
  maintenanceFixtureRecord,
  maintenancePayload,
  persistentAssemblyFixture,
} from './assembly-maintenance.js'
import { fixtureHash, fixtureRef, fixtureWire } from './assembly-maintenance-wire.js'

export type AdmissionFixtureInput = MaintenanceAssemblyInput & { configuration: ConfigResolveResult }

/** Durable fixture locks and trusted identity are synthetic and cannot qualify a production State. */
export async function openAdmissionFixture(
  directory: string,
  provider: 'default' | 'reference',
  input: AdmissionFixtureInput,
  checkpoint?: (point: string) => Promise<void>,
) {
  const maintenance = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'), {
    lifecycle: false,
    beforeCommit: async (request) => {
      if (request.transactionId.startsWith('admission:')) await checkpoint?.('confirm:before')
      if (request.transactionId.startsWith('ticket:')) await checkpoint?.('issue:before')
    },
    afterCommit: async (request) => {
      if (request.transactionId.startsWith('admission:')) await checkpoint?.('confirm:after')
      if (request.transactionId.startsWith('ticket:')) await checkpoint?.('issue:after')
    },
  })
  const previous =
    input.fixture.previousRelease ??
    (() => {
      throw new Error('previous release missing')
    })()
  const target = input.plan.targetReleaseSet
  if (!maintenance.database.get(`release:${target.releaseSetId}`))
    maintenance.database.seed(
      maintenanceFixtureRecord(`release:${target.releaseSetId}`, 'release-snapshot', {
        canonicalJson: jcs(target),
        contentDigest: fixtureHash(target),
      }),
    )
  const now = input.fixture.now
  function binding(release: ReleaseSet, bindingId: string) {
    return fixtureWire('RunBinding', {
      bindingId,
      releaseSetId: release.releaseSetId,
      profileDigest: release.profileRef.digest,
      presetDigest: release.presetRef.digest,
      createdAt: now,
      minimumRecovery: 'R0',
      stateAuthorityAtCreation: maintenance.stateAuthorityRef,
      filesystemPolicy: {
        policyId: 'fixture-fs',
        digest: fixtureHash('fixture-fs'),
        scope: assemblyMaintenanceContext().scope,
        compilerVersion: 'fixture',
        roots: [],
        rules: [],
      },
      telemetryConsent: {
        sessionId: 'fixture-session',
        level: 'LOCAL',
        sourceDigest: fixtureHash('fixture-consent'),
        profileId: 'fixture-profile',
        recordedAt: now,
        explicitFull: false,
        evidence: 'trusted-config',
      },
      providers: release.bindings,
      jointDispatchDomains: [],
    })
  }
  const bindings = new Map<string, RunBinding>([
    ['fixture-old-binding', binding(previous, 'fixture-old-binding')],
    ['fixture-new-binding', binding(target, 'fixture-new-binding')],
  ])
  const initialSession: SessionControlState = fixtureWire('SessionControlState', {
    sessionId: 'fixture-session',
    revision: 1,
    activeRunId: null,
    activeTurnId: null,
    parameters: {
      sessionId: 'fixture-session',
      revision: 1,
      previousRevision: null,
      sourceRequestId: 'fixture-initial',
      presetId: previous.presetRef.id,
      presetDigest: previous.presetRef.digest,
      parameters: { schema: fixtureRef({}).schema, value: {} },
      effective: { kind: 'immediate', revision: 1, runId: null, afterRequestId: null },
      committedAt: now,
    },
  })
  const state = restrictedAdmissionState(join(directory, 'state.sqlite'), {
    maintenanceRecord: maintenance.database.get,
    binding: (id) => bindings.get(id),
    initialSession,
    now: () => maintenance.control.now,
    ...(checkpoint ? { checkpoint } : {}),
  })
  const construct = provider === 'default' ? createAdmissionCoordinator : createReferenceAdmissionCoordinator
  const coordinator = construct(maintenance.ports, state.ports)
  const tickets =
    provider === 'default'
      ? createAdmissionTickets(maintenance.ports)
      : createReferenceAdmissionTickets(maintenance.ports)
  function draft(generation: 'old' | 'new' = 'old', suffix: string = generation): TicketDraft {
    const release = generation === 'old' ? previous : target
    return {
      runKey: `fixture-key-${suffix}`,
      stateAuthorityRef: maintenance.stateAuthorityRef,
      grantRef: 'fixture-authorization',
      admission: {
        ticketId: `fixture-ticket-${suffix}`,
        releaseSetId: release.releaseSetId,
        bindingId: `fixture-${generation}-binding`,
        runId: `fixture-run-${suffix}`,
        sessionId: 'fixture-session',
        lane: 'foreground',
        workspaceId: 'fixture-workspace',
        input: fixtureRef({ prompt: 'synthetic' }),
        admittedAt: now,
        deadline: '2027-01-01T00:00:00Z',
        conversation: null,
      },
    }
  }
  return {
    input,
    maintenance,
    state,
    coordinator,
    tickets,
    draft,
    another: () => construct(maintenance.ports, state.ports),
    async switchRoute() {
      const recordId = `release-route:${input.plan.routeId}`
      const old = maintenance.database.get(recordId)
      if (!old) throw new Error('route missing')
      if (maintenancePayload(old).activeReleaseSetId === target.releaseSetId) return
      const result = await maintenance.database.store.commit(
        {
          transactionId: 'fixture-route-switch',
          authority: maintenance.database.authority,
          expectedWriterEpoch: 1,
          mutations: [
            {
              recordId,
              expectedRevision: old.revision,
              next: maintenanceFixtureRecord(
                recordId,
                'release-route',
                {
                  ...maintenancePayload(old),
                  activeReleaseSetId: target.releaseSetId,
                },
                old.revision + 1,
              ),
            },
          ],
          outbox: [],
        },
        assemblyMaintenanceContext(),
      )
      if (!result.ok) throw new Error(result.error.detailCode)
    },
    async close() {
      await coordinator.dispose()
      state.close()
      await maintenance.close()
    },
  }
}
