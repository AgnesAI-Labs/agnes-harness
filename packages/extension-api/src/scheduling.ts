import type { ScheduleRun, SchedulesControlParams, ScheduleTarget, ScheduleView, ServiceCapability } from '@agnes/protocol'
import { defineKind } from './provider-kind.js'
import type { ServiceInstance, ServicePorts } from './service-provider.js'

/** All operations are scoped to the Host-admitted session; callers cannot supply an owner. */
export interface SchedulingService extends ServiceInstance {
  list(input?: {
    includeArchived?: boolean
    recentDeliverySince?: number
  }): Promise<{ schedules: ScheduleView[]; recentDelivery?: { title: string; prompt: string } }>
  get(id: string): Promise<ScheduleView | undefined>
  upsert(input: {
    id?: string
    title: string
    prompt: string
    selector: ScheduleView['selector']
    target?: ScheduleTarget
  }): Promise<ScheduleView | { updated: false; code: string }>
  control(input: SchedulesControlParams): Promise<ScheduleView | { updated: false; code: string }>
  archive(input: { id: string }): Promise<{ deleted: boolean }>
  runs(id: string): Promise<ScheduleRun[]>
}

/** A fixed daemon service, never an author-replaceable scheduling engine. */
export const schedulingKind = defineKind<SchedulingService, ServicePorts>({
  kind: 'scheduling',
  authority: 'host',
  register: false,
  bind: { cardinality: 'single', instanceScope: 'request', ports: [] },
})

/** Declare these standard service capabilities and obtain the corresponding lease grants. */
export const schedulingServiceCapabilities = ['list', 'get', 'upsert', 'control', 'archive', 'runs'].map(
  (operation): ServiceCapability => ({
    name: `scheduling.${operation}`,
    kind: (['list', 'get', 'runs'].includes(operation) ? 'query' : 'effect') as 'query' | 'effect',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
    timeoutMs: 30000,
    maxResultBytes: 1048576,
  }),
)

/** Trusted daemon transport. The Host supplies session identity, never plugin input. */
export type SchedulingBridge = (
  session: { key: string; workspaceRoot: string },
  operation: 'list' | 'get' | 'upsert' | 'control' | 'archive' | 'runs',
  input: unknown,
  signal: AbortSignal,
) => Promise<unknown>
