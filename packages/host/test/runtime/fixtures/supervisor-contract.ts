import { createDefaultSupervisorFactory } from '@agnes/core'
import type { CallContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { createReferenceSupervisorFactory } from '../../../../../examples/runtime-reference/src/providers/supervisor.js'
import {
  createRestrictedSupervisorAdmission,
  type SupervisorContractFixture,
  supervisorConfig,
  supervisorDescriptor,
  supervisorInput,
} from '../../../../extension-api/testkit/runtime/contracts/supervisor.js'
import { createTestServiceContainer } from '../../../../extension-api/testkit/runtime/harness.js'
import { createStateSessionControlFixture } from './runtime-session-control.js'

/** Real State, real identity-issued contexts. Effects, Loop and the directory are deliberately absent: the scenarios that
 * need them report a named unavailable consumer instead of passing. */
export async function openSupervisorHostFixture(
  kind: 'default' | 'reference',
): Promise<SupervisorContractFixture> {
  const f = await createStateSessionControlFixture()
  const calls: string[] = []
  let hold: Promise<void> | null = null
  let sequence = 0
  const gate = async (name: string) => {
    calls.push(name)
    if (hold) await hold
  }
  const store = f.store
  const sessionControl = {
    readSessionControl: async (
      request: Parameters<typeof store.readSessionControl>[0],
      context: CallContext,
    ) => {
      await gate('read')
      return store.readSessionControl(request, context)
    },
    submitSessionControl: async (
      request: Parameters<typeof store.submitSessionControl>[0],
      context: CallContext,
    ) => {
      await gate('submit')
      return store.submitSessionControl(request, context)
    },
    sessionControlStatus: async (
      request: Parameters<typeof store.sessionControlStatus>[0],
      context: CallContext,
    ) => {
      await gate('status')
      return store.sessionControlStatus(request, context)
    },
  }
  // Admission runs on a restricted in-memory mirror of the coordinator; the real coordinator is covered by the joint test.
  const peer = createRestrictedSupervisorAdmission()
  let revoked = false
  const authority = {
    authorityId: 'supervisor-contract-state',
    tenantId: 'supervisor-contract',
    authorityEpoch: 1,
  }
  const loopBinding: W.BindingRef = {
    contract: 'agh.loop',
    logicalName: 'default',
    providerId: 'supervisor-contract-loop',
    bindingId: 'supervisor-contract-loop-binding',
  }
  const release = {
    releaseSetId: 'supervisor-contract-release',
    stateAuthorityRef: authority,
    lane: 'foreground',
    runBinding: {
      bindingId: 'supervisor-contract-binding',
      providers: [{ binding: loopBinding }],
    } as unknown as W.RunBinding,
  }
  const unused = async (): Promise<never> => {
    throw new Error('not used by this scenario')
  }
  const providerId = kind === 'default' ? 'agh.default/supervisor' : 'agh.reference/supervisor'
  const descriptor = supervisorDescriptor(providerId)
  // The identity fixture runs on a frozen clock, so the Supervisor must measure context deadlines against it.
  const deployment = {
    clock: f.options.now,
    sessionControl,
    admission: peer.port as never,
    releases: {
      select: async () => ({ ok: true as const, value: release }),
      bound: async () => ({ ok: true as const, value: release }),
    },
    identity: {
      issue: unused,
      issueRuntime: unused,
      check() {
        if (revoked) throw new Error('revoked')
      },
      delegationExpiresAt: () => null,
    },
    limits: {
      workflowLifetimeMs: 86_400_000,
      actionDefaultTimeoutMs: 120_000,
      pollMs: 1000,
      leaseTtlMs: 15_000,
      cycleMs: 30_000,
      invocationMs: 5000,
      graceMs: 2000,
      queryAllowance: 64,
    },
  }
  const factory =
    kind === 'default'
      ? createDefaultSupervisorFactory(descriptor, deployment)
      : createReferenceSupervisorFactory(descriptor, deployment)
  const scope = f.context.scope
  if (scope.kind !== 'session') throw new Error('the fixture must use a full session scope')
  const binding: W.BindingRef = {
    contract: 'agh.supervisor',
    logicalName: 'default',
    providerId,
    bindingId: `supervisor-${kind}`,
  }
  return {
    factory,
    config: supervisorConfig(),
    dependencies: createTestServiceContainer().dependencies,
    factoryContext: {
      instanceId: `supervisor-${kind}`,
      scope: { kind: 'runtime', installationId: scope.installationId, runtimeId: scope.runtimeId },
      bindingId: binding.bindingId,
      signal: new AbortController().signal,
    },
    binding,
    sessionId: scope.sessionId,
    // A fresh context per call: same actor and scope as the fixture's, never a copy of an issued object.
    context(signal = new AbortController().signal) {
      sequence += 1
      // The identity owner refuses an already aborted signal, so the context is issued against a live one that
      // follows the caller's signal, and is aborted at once when the caller's already is.
      const own = new AbortController()
      const issued = f.identity.issue(f.context.authorizationRef, {
        bindingId: f.context.bindingId,
        scope: f.context.scope,
        invocationId: `supervisor-contract-${sequence}`,
        traceRef: 'trace',
        deadline: f.context.deadline,
        signal: own.signal,
      })
      if (!issued) throw new Error('the identity owner refused a context')
      if (signal.aborted) own.abort()
      else signal.addEventListener('abort', () => own.abort(), { once: true })
      return issued
    },
    admission: {
      spec: (key) => ({
        presetRef: 'supervisor-contract-preset',
        // Any schema-valid inline DataRef serves as the run input.
        inputRef: supervisorInput('readSessionControl', key),
        idempotencyKey: key,
      }),
      holdCreate: () => {
        peer.hold.next = true
      },
      runRefOf: (key) => peer.runRefOf(key),
      issued: () => peer.tickets.size,
      created: () => peer.created(),
    },
    state: {
      calls: () => calls,
      hang() {
        let release = () => {}
        hold = new Promise<void>((resolve) => (release = resolve))
        return () => {
          release()
          hold = null
        }
      },
      revoke: () => {
        revoked = true
        f.identity.close()
      },
    },
    close: async () => f.close(),
  }
}
