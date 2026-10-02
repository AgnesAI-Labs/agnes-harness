import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeErrorDetails, validateRuntime } from '@agnes/protocol/runtime'
import type { ApprovalPreparationInput } from '../state/approval.js'
import type { RuntimeStateStore } from './state.js'

export const INTERACTION_CONTRACT = 'agh.interaction'
export const DEFAULT_INTERACTION_PROVIDER_ID = 'agh.default/interaction'

/** State does not yet run these in the approval transaction, so they refuse instead of approximating. */
const UNSUPPORTED = ['request', 'respond', 'acceptResponse', 'expire', 'cancel', 'formLink'] as const

export type InteractionStore = Pick<
  RuntimeStateStore,
  | 'prepareApproval'
  | 'resolveApproval'
  | 'readInteraction'
  | 'readInteractionResponseStatus'
  | 'pendingInteractions'
>
export interface InteractionOptions {
  readonly store: InteractionStore
  /** The capability the Host ingress issued for this exact call context, or null. Never part of a request. */
  responder(context: CallContext): object | null
}
export interface InteractionService
  extends Record<
    (typeof UNSUPPORTED)[number],
    (request: unknown, context: CallContext) => Promise<Outcome<never>>
  > {
  /** Host-private: the authorization driver opens an approval in its prepare commit through this provider. */
  prepareApproval(input: ApprovalPreparationInput): Promise<Outcome<Wire.InteractionRecord>>
  respondApproval(request: unknown, context: CallContext): Promise<Outcome<Wire.InteractionResponseStatus>>
  read(interactionId: string, context: CallContext): Promise<Outcome<Wire.InteractionRecord>>
  responseStatus(responseId: string, context: CallContext): Promise<Outcome<Wire.InteractionResponseStatus>>
  pending(
    request: Wire.InteractionClientPendingRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.PageInteractionRecord>>
}

function refusal(detailCode: 'invalid_request' | 'permission_denied' | 'unsupported', message: string) {
  return Promise.resolve<Outcome<never>>({
    ok: false,
    error: {
      code: RuntimeErrorDetails[detailCode].code,
      detailCode,
      message,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'interaction-provider',
    },
  })
}
const PUBLIC_DETAILS = new Map([
  ['invalid_input', 'invalid_request'],
  ['denied', 'permission_denied'],
])
/** Registered details pass through; State-local input and denial details become the public ones. */
async function mapped<T>(pending: Promise<Outcome<T>>): Promise<Outcome<T>> {
  const result = await pending
  if (result.ok || Object.hasOwn(RuntimeErrorDetails, result.error.detailCode)) return result
  const detailCode = PUBLIC_DETAILS.get(result.error.code)
  return detailCode ? { ok: false, error: { ...result.error, detailCode } } : result
}

export function createInteractionService(options: InteractionOptions): InteractionService {
  const { store } = options
  const unsupported = Object.fromEntries(
    UNSUPPORTED.map((method) => [
      method,
      () => refusal('unsupported', `interaction ${method} is not supported`),
    ]),
  ) as Record<(typeof UNSUPPORTED)[number], () => Promise<Outcome<never>>>
  return {
    ...unsupported,
    prepareApproval: (input) => mapped(store.prepareApproval(input)),
    respondApproval(request, context) {
      const authentication = options.responder(context)
      if (!authentication) return refusal('permission_denied', 'approval responder is not authenticated')
      const checked = validateRuntime('ApprovalRespondRequest', request)
      if (!checked.ok) return refusal('invalid_request', 'ApprovalRespondRequest is not valid')
      return mapped(store.resolveApproval({ request: checked.value, context, authentication }))
    },
    read: (interactionId, context) => mapped(store.readInteraction(interactionId, context)),
    responseStatus: (responseId, context) => mapped(store.readInteractionResponseStatus(responseId, context)),
    pending: (request, context) => mapped(store.pendingInteractions(request, context)),
  }
}
