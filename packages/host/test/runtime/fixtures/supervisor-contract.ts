import { createDefaultSupervisorFactory } from '@agnes/core'
import type { CallContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { createReferenceSupervisorFactory } from '../../../../../examples/runtime-reference/src/providers/supervisor.js'
import {
  type SupervisorContractFixture,
  supervisorConfig,
  supervisorDescriptor,
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
  const providerId = kind === 'default' ? 'agh.default/supervisor' : 'agh.reference/supervisor'
  const descriptor = supervisorDescriptor(providerId)
  // The identity fixture runs on a frozen clock, so the Supervisor must measure context deadlines against it.
  const deployment = { clock: f.options.now, sessionControl }
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
      revoke: () => f.identity.close(),
    },
    close: async () => f.close(),
  }
}
