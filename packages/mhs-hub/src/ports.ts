import type { Json, Outcome, Registration, ResourceHolder } from '@agnes/mhs-device'

export interface StoreRow {
  key: string
  value: Json
  revision: string
}
export interface StoreTransaction {
  get(key: string): { value: Json; revision: string } | undefined
  put(key: string, value: Json, expectedRevision: string | null): void
  remove(key: string, expectedRevision: string): void
}
export interface OwnedStore {
  transaction<T>(fn: (tx: StoreTransaction) => T): Promise<T>
  scan(input: {
    prefix: string
    limit: number
    cursor?: string
  }): Promise<{ rows: readonly StoreRow[]; nextCursor?: string }>
}
export interface WakeTarget {
  readonly bindingId: string
}
export interface BoundWakes {
  enqueue(input: {
    target: WakeTarget
    idempotencyKey: string
    event: { name: string; summary: string; data?: Json }
    delivery?: 'next-turn' | 'follow-steer'
  }): Promise<{ wakeId: string; state: 'queued' | 'delivered' | 'refused' }>
}
export interface Invocation {
  operationId: string
  /** Constructed by a trusted author-API adapter, never from UI arguments. */
  context: unknown
  sessionId?: string
  laneId?: string
  target?: WakeTarget
}
export interface AdmissionSubject {
  operationId: string
  action: 'call' | 'set' | 'manual' | 'configure' | 'clip' | 'pause' | 'resume' | 'cancel'
  device: string
  revision: string
  input: Json
}
export interface Authority {
  assertActive(): Promise<void>
  /** Must consume Host admission for this exact subject. Throw unless admitted. */
  admit(subject: AdmissionSubject, context: unknown): Promise<void>
}
export interface DeviceLink {
  readonly registration: Registration
  readonly available: boolean
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  call(
    id: string,
    name: string,
    args: Json,
    caller?: string,
  ): Promise<{
    accepted: boolean
    reason?: string
    holder?: ResourceHolder
    needs?: string[]
    result: Promise<Outcome>
  }>
  clip?(id: string, rate: number, channels: number, pcm: Uint8Array): void | Promise<void>
  manual(axes: Record<string, number>): void
  close(): void
}
export interface SouthEvents {
  online(link: DeviceLink): void
  offline(device: string, link: DeviceLink): void
  state(device: string, values: Record<string, Json>): void
  observation(device: string, source: string, data: Json, bytes?: Uint8Array, mime?: string): void
  progress(device: string, call: string, data: Json): void
}
