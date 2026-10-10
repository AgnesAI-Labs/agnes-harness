import { defineServiceKind, type ProviderIdentity, type ServicePorts } from '@agnes/extension-api'
import type { EventEnvelope } from '@agnes/protocol'

export interface ObservabilitySession {
  workspace?: string
  generation?: string
  pin?: string
  version?: string
  /** Content involving these private roots is always omitted. */
  privateRoots?: readonly string[]
}

export interface ObservabilityHealth {
  status: 'disabled' | 'idle' | 'ok' | 'backoff' | 'rejected' | 'closed'
  queued: number
  dropped: number
  failures: number
  lastExportAt?: string
}

/** Passive committed-event consumer. Failure must never change execution or authorization. */
export interface ObservabilityProvider extends ProviderIdentity {
  bindSession(key: string, resource?: ObservabilitySession): () => void
  observe(key: string, event: Readonly<EventEnvelope>): void
  child(parent: string, child: string, phase: 'start' | 'end', failed?: boolean): void
  lifecycle(
    component: 'daemon' | 'worker',
    phase: 'start' | 'stop' | 'restart',
    queueDepth?: number,
    id?: string,
  ): void
  queueDepth(depth: number): void
  correlation(key: string): { traceId: string; spanId: string } | undefined
  health?(): ObservabilityHealth
  flush(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Process-scoped exporter. The shared queue stays inside this package's home refcount.
 * The descriptor grants no ledger, input, or projection ports.
 */
export const observabilityKind = defineServiceKind<ObservabilityProvider, ServicePorts>({
  kind: 'observability',
  cardinality: 'single',
  instanceScope: 'process',
  scope: 'process',
  ports: [],
})
