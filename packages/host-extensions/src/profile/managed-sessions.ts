import type { ManagedInputAdmission, ManagedInputResult, ManagedSessions } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'

/** The Host-verified row a managed service runs for. The daemon rechecks it against fresh inventory. */
export interface ManagedSessionCaller {
  readonly owner: string
  readonly packageId: string
  readonly integrity: string
  readonly service: string
}

/** How the Host resolved the receipt of an owner message; same shape as the daemon's `HostInputResolution`. */
export type HostInputResolutionWire =
  | {
      readonly kind: 'receipt'
      readonly receiptId: string
      readonly text: string
      readonly contentDigest: string
      readonly source: {
        readonly instanceId: string
        readonly pairingId: string
        readonly eventId: string
        readonly messageId: string
        readonly kind: 'message' | 'action'
        readonly actionId?: string
        readonly at: string
      }
    }
  | {
      readonly kind: 'unresolved'
      readonly receiptId: string
      readonly reason: 'receiptUnknown' | 'pairingChanged'
    }

/**
 * The Host's own view of the port. `admitResolved` carries the Host's receipt resolution beside the
 * plugin's arguments; it is never part of what a plugin receives.
 */
export interface HostManagedSessions extends ManagedSessions {
  admitResolved(
    sessionId: string,
    input: ManagedInputAdmission,
    resolution: HostInputResolutionWire,
  ): Promise<ManagedInputResult>
}

export type ManagedSessionsFactory = (caller: ManagedSessionCaller) => HostManagedSessions

const denied = async (): Promise<never> => {
  throw rpcError('CAPABILITY_DENIED')
}

/** What a managed service without the reviewed `sessions` declaration receives. */
export const deniedManagedSessions: HostManagedSessions = {
  start: denied,
  send: denied,
  list: denied,
  status: denied,
  events: denied,
  result: denied,
  usage: denied,
  toolResult: denied,
  interrupt: denied,
  archive: denied,
  admitInput: denied,
  inputResult: denied,
  admitResolved: denied,
}
