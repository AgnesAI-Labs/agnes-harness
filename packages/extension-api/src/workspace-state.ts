import type { JsonValue } from '@agnes/protocol'
import { defineKind } from './provider-kind.js'
import type { ServiceInstance, ServicePorts } from './service-provider.js'

/** Read-only backend state dependency. No execution, ledger or write ports are granted. */
export interface WorkspaceState extends ServiceInstance {
  query(workspaceRoot: string): JsonValue | Promise<JsonValue>
}
export const workspaceStateKind = defineKind<WorkspaceState, ServicePorts>({
  kind: 'workspace-state',
  scope: 'session',
  pinned: true,
  versioned: true,
  bind: { cardinality: 'multi', instanceScope: 'request', ports: [] },
})
