import type { JsonValue, ProfileServiceCallResult, ProfileServiceReceipt } from '@agnes/protocol'

/** Host-selected profile and loader-selected owner. No profile, owner or actor selectors. */
export interface ProfilePluginServices {
  query<O extends JsonValue>(service: string, input: Record<string, JsonValue>): Promise<O>
  effect(
    service: string,
    input: Record<string, JsonValue>,
    options: { operationId: string },
  ): Promise<ProfileServiceCallResult>
  readOperation(service: string, operationId: string): Promise<ProfileServiceReceipt>
}

/** Bounded JSON state. Transactions are synchronous; promises abort the transaction. */
export interface OwnedStore {
  get(key: string): JsonValue | undefined
  set(key: string, value: JsonValue): void
  delete(key: string): void
  transaction<T>(work: () => T): T
}
export interface WakeTarget {
  readonly bindingId: string
}
/** Only an admitted session invocation can bind a target. */
export interface SessionWakePort {
  bind(): Promise<WakeTarget>
}
export interface BoundWakeInput {
  readonly target: WakeTarget
  readonly idempotencyKey: string
  readonly event: { readonly name: string; readonly summary: string; readonly data?: JsonValue }
  readonly delivery?: 'next-turn' | 'follow-steer'
}
export interface BoundWakeReceipt {
  readonly wakeId: string
  readonly state: 'queued' | 'delivered' | 'refused'
  readonly code?: string
}
/** Owner comes from the authenticated producer connection, never from this input. */
export interface BoundWakes {
  enqueue(input: BoundWakeInput): Promise<BoundWakeReceipt>
  read(wakeId: string): Promise<BoundWakeReceipt>
}
