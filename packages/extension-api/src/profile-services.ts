import type { JsonValue, ProfileServiceCallResult, ProfileServiceReceipt } from '@agnes/protocol'

/** Host-selected profile and loader-selected owner. No profile, owner or actor selectors. */
export interface ProfilePluginServices {
  query<O extends JsonValue>(
    service: string,
    input: Record<string, JsonValue>,
    options?: { sessionReads?: readonly string[] },
  ): Promise<O>
  effect(
    service: string,
    input: Record<string, JsonValue>,
    options: { operationId: string },
  ): Promise<ProfileServiceCallResult>
  readOperation(service: string, operationId: string): Promise<ProfileServiceReceipt>
}

/** Bounded JSON state. Transactions are synchronous; promises abort the transaction. */
export interface OwnedStore {
  scan(input: { prefix: string; limit: number; cursor?: string }): {
    rows: readonly { key: string; value: JsonValue }[]
    nextCursor?: string
  }
  get(key: string): JsonValue | undefined
  set(key: string, value: JsonValue): void
  delete(key: string): void
  /** Nested calls join the root transaction; every joined admission is rechecked before its commit. */
  transaction<T>(work: () => T, admission?: import('@agnes/protocol').PermissionEffectAdmission): T
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
