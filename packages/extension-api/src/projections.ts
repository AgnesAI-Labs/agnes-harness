import type { EventEnvelope, JsonValue, ProjectionReadResult as WireResult } from '@agnes/protocol'
import type { JsonSchema } from './common.js'

export type { ProjectionCapability } from '@agnes/protocol'
export type ProjectionEvent = Readonly<EventEnvelope>
export interface ProjectionDef<S extends JsonValue = JsonValue> {
  name: string
  stateVersion: number
  stateSchema: JsonSchema
  init(): S
  apply(state: Readonly<S>, event: ProjectionEvent): S
  view?(state: Readonly<S>): JsonValue
}
export type ProjectionReadResult<T extends JsonValue = JsonValue> =
  | (Omit<Extract<WireResult, { status: 'available' }>, 'value'> & { value: T })
  | Extract<WireResult, { status: 'unavailable' }>
export interface ProjectionReader {
  readOwn<T extends JsonValue = JsonValue>(name: string): Promise<ProjectionReadResult<T>>
}

/** Core callbacks have no extension authority. Host injects its owner-bound reader at invocation. */
export const unavailableProjections: ProjectionReader = Object.freeze({
  async readOwn(name: string) {
    return {
      status: 'unavailable' as const,
      name,
      error: { code: 'E_PROJECTION_STATE' as const, safeMessage: 'projection unavailable' },
    }
  },
})
