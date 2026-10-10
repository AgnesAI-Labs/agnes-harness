import { Context } from '@agnes/cordis'
import { ProviderError, type ServiceProvider } from '@agnes/extension-api'
import { ServiceBindings, type ServiceCall } from '@agnes/host-common/assemble/service-binding'
import { type Actor, jcs, rpcError } from '@agnes/protocol'
import {
  FEEDBACK_DESCRIPTOR,
  FEEDBACK_OWNER,
  FEEDBACK_PACKAGE_ID,
  FEEDBACK_PROVIDER_ID,
  FEEDBACK_PROVIDER_VERSION,
  feedbackKind,
  type FeedbackAuthority,
  type FeedbackInstance,
} from './contract.js'
import { createFeedbackLedger } from './ledger.js'
import { createFeedbackService } from './service.js'

export interface FeedbackBind {
  readonly actor: Actor
  readonly signal: AbortSignal
  readonly authority: FeedbackAuthority
  readonly sessionId?: string
  readonly live?: ServiceCall['live']
}

interface Admission {
  readonly actor: Actor
  readonly authority: FeedbackAuthority
}

/**
 * One profile's feedback provider. The provider object is stateless. Each bind opens a new
 * instance around that request's authority, keyed by the request signal so principals do not
 * share a mutable context. Code replacement is restart-required; bind does not hot-swap it.
 */
export function createFeedbackOwner(profile: string) {
  const root = new Context()
  const bindings = new ServiceBindings(() => root.providers)
  bindings.install(root, feedbackKind, FEEDBACK_DESCRIPTOR)
  const admissions = new WeakMap<AbortSignal, Admission>()
  const provider: ServiceProvider<FeedbackInstance> = {
    id: FEEDBACK_PROVIDER_ID,
    version: FEEDBACK_PROVIDER_VERSION,
    open(ports) {
      const admitted = admissions.get(ports.binding.signal)
      if (!admitted || !ports.ledger || ports.input || ports.projections) {
        throw new ProviderError('E_PROVIDER_UNAVAILABLE', 'service binding is closed', {
          kind: feedbackKind.kind,
          operation: 'bind',
        })
      }
      const service = createFeedbackService(admitted.authority)
      return {
        // Async so a mismatch rejects the promise the binding facade is already tracking.
        async execute(input, actor, signal) {
          if (jcs(actor) !== jcs(admitted.actor)) {
            throw rpcError('CAPABILITY_DENIED', { reason: 'FEEDBACK_ACTOR_MISMATCH' })
          }
          return service.execute(input, actor, signal)
        },
      }
    },
  }
  root.providers.register(feedbackKind, FEEDBACK_PACKAGE_ID, provider)
  return {
    profile,
    async bind(input: FeedbackBind): Promise<FeedbackInstance> {
      const admitted: Admission = { actor: input.actor, authority: input.authority }
      admissions.set(input.signal, admitted)
      const call: ServiceCall = {
        owner: FEEDBACK_OWNER,
        packageId: FEEDBACK_PACKAGE_ID,
        signal: input.signal,
        workspaceKey: profile,
        watermark: 0,
        actor: input.actor,
        live:
          input.live ??
          (() => (input.signal.aborted ? undefined : { owner: FEEDBACK_OWNER, active: true })),
      }
      try {
        return await bindings.bind(feedbackKind, call, {
          ledger: () => createFeedbackLedger(input.authority, input.sessionId, input.actor),
        })
      } finally {
        admissions.delete(input.signal)
      }
    },
    async close(): Promise<void> {
      await root.fiber.dispose()
    },
  }
}

export type FeedbackOwner = ReturnType<typeof createFeedbackOwner>
