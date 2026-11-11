import type { ManagedSessions } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'

/** The Host-verified row a managed service runs for. The daemon rechecks it against fresh inventory. */
export interface ManagedSessionCaller {
  readonly owner: string
  readonly packageId: string
  readonly integrity: string
  readonly service: string
}

export type ManagedSessionsFactory = (caller: ManagedSessionCaller) => ManagedSessions

const denied = async (): Promise<never> => {
  throw rpcError('CAPABILITY_DENIED')
}

/** What a managed service without the reviewed `sessions` declaration receives. */
export const deniedManagedSessions: ManagedSessions = {
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
}
