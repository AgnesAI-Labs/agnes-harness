import type { JsonValue } from '@agnes/protocol'

export type {
  ManagedServiceDescriptor,
  ManagedServiceReady,
  ManagedServiceStatus,
} from '@agnes/protocol/gen/managed-service'

export interface OwnedStoreTxn {
  get(key: string): { value: JsonValue; revision: string } | undefined
  put(key: string, value: JsonValue, expectedRevision: string | null): void
  remove(key: string, expectedRevision: string): void
}
/** Bound by the storage owner to one installation/profile/package/service namespace. */
export interface ManagedOwnedStore {
  transaction<T>(fn: (tx: OwnedStoreTxn) => T): Promise<T>
  scan(input: { prefix: string; limit: number; cursor?: string }): Promise<{
    rows: readonly { key: string; value: JsonValue; revision: string }[]
    nextCursor?: string
  }>
}
export interface ManagedServiceInit {
  readonly instanceId: string
  readonly incarnation: string
  readonly scopeId: string
  readonly listeners: Readonly<Record<string, { host: '127.0.0.1'; port: number }>>
  readonly store: ManagedOwnedStore
  readonly signal: AbortSignal
}
export interface ManagedServiceRuntime {
  /** Call only after storage checks, all listeners bound and the shutdown handler installed. */
  ready(info: { apiVersion: string; listeners: readonly string[] }): Promise<void>
  onShutdown(
    fn: (
      reason: 'disable' | 'upgrade' | 'exit',
      signal: AbortSignal,
    ) => Promise<{ state: 'settled' | 'unknown'; detail?: JsonValue }>,
  ): void
}
