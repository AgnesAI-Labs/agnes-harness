import type {
  ScheduleRun,
  SchedulesControlParams,
  ScheduleTarget,
  ScheduleView,
  ServiceCapability,
} from '@agnes/protocol'
import {
  SchedulesControlParams as ControlSchema,
  SchedulesArchiveParams,
  SchedulesUpsertParams,
} from '@agnes/protocol'
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

const idInput = JSON.parse(JSON.stringify(SchedulesArchiveParams))
const upsertInput = JSON.parse(JSON.stringify(SchedulesUpsertParams))
upsertInput.required = ['title', 'prompt', 'selector']
// The TypeScript interface reuses the protocol's full result types. Metadata remains bounded
// like other service declarations; daemon validation owns nested schedule semantics.
const view = { type: 'object', additionalProperties: true }
const refused = {
  type: 'object',
  properties: { updated: { const: false }, code: { type: 'string' } },
  required: ['updated', 'code'],
  additionalProperties: false,
}
const inputs = {
  list: {
    type: 'object',
    properties: { includeArchived: { type: 'boolean' }, recentDeliverySince: { type: 'number' } },
    additionalProperties: false,
  },
  get: idInput,
  upsert: upsertInput,
  control: JSON.parse(JSON.stringify(ControlSchema)),
  archive: idInput,
  runs: idInput,
}
const outputs = {
  list: {
    type: 'object',
    properties: {
      schedules: { type: 'array', items: view },
      recentDelivery: {
        type: 'object',
        properties: { title: { type: 'string' }, prompt: { type: 'string' } },
        required: ['title', 'prompt'],
        additionalProperties: false,
      },
    },
    required: ['schedules'],
    additionalProperties: false,
  },
  get: { anyOf: [view, { type: 'null' }] },
  upsert: { anyOf: [view, refused] },
  control: { anyOf: [view, refused] },
  archive: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
    required: ['deleted'],
    additionalProperties: false,
  },
  runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
}

/** Exact declarations used by the ordinary manifest and lease service grant checks. */
export const schedulingServiceCapabilities: ServiceCapability[] = (
  Object.keys(inputs) as (keyof typeof inputs)[]
).map(
  (operation): ServiceCapability => ({
    name: `scheduling.${operation}`,
    kind: ['list', 'get', 'runs'].includes(operation) ? 'query' : 'effect',
    inputSchema: JSON.parse(JSON.stringify(inputs[operation])),
    outputSchema: JSON.parse(JSON.stringify(outputs[operation])),
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
