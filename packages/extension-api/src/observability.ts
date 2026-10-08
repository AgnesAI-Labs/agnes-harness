import type { EventEnvelope } from '@agnes/protocol'
import { defineProviderKind, type ProviderIdentity } from './provider-kind.js'

/** Passive committed-event consumer. Failure must never change execution or authorization. */
export interface ObservabilityProvider extends ProviderIdentity {
  bindSession(key: string): () => void
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
  flush(): Promise<void>
  dispose(): Promise<void>
}
export const observabilityKind = defineProviderKind<ObservabilityProvider>({
  kind: 'observability',
  scope: 'generation',
  validate(provider) {
    for (const method of [
      'bindSession',
      'observe',
      'child',
      'lifecycle',
      'queueDepth',
      'correlation',
      'flush',
      'dispose',
    ] as const)
      if (typeof provider[method] !== 'function') throw new TypeError('Invalid observability provider')
  },
})
