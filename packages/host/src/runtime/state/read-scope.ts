import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type JsonValue,
  RuntimeSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
} from '@agnes/protocol/runtime'

export type StateReadWindow =
  | Readonly<{ kind: 'session' }>
  | Readonly<{ kind: 'run'; runId: string }>
  | Readonly<{ kind: 'action'; runId: string; actionId: string }>

/**
 * What the identity owner proved about one caller. The wrapper never builds or widens one.
 * A grant covers only the window of the scope the caller was issued; run and action ids come from
 * that scope, never from caller JSON.
 */
export type StateReadGrant = Readonly<{
  sessionId: string
  window: StateReadWindow
  /**
   * Binds the original authorization and the window. It is not a freshness signal: revocation,
   * generation change, a missing owner mapping and abort are rejected by `check()`, which must be
   * called on every page.
   */
  fingerprint: string
  /** The original runtime-scope context the native owner accepts; one object for this grant's life. */
  original: CallContext
  /** Epoch ms, never later than the original deadline, identity expiry or the caller's deadline. */
  deadline: number
  /** Synchronous and throwing; valid for every page, never a flag a caller can set. */
  check(): void
}>

export type StateReadBridge = Readonly<{
  grant(caller: CallContext, requestedSessionId: string | null): StateReadGrant | null
  ownedSessions(
    caller: CallContext,
    page: Readonly<{ after: string | null; limit: number }>,
  ): Readonly<{ sessionIds: readonly string[]; next: string | null }> | null
}>

export type ReadableSchema = Readonly<{
  schema: SchemaRef
  definition: keyof RuntimeWireTypes
  kind: 'run' | 'binding' | 'action' | 'attempt' | 'signal' | 'wait' | 'visibility' | 'issuance'
  relate?: (value: JsonValue) => Readonly<{ runId: string; actionId: string | null }> | null
}>

export const DEFAULT_READABLE: readonly ReadableSchema[] = Object.freeze([
  { schema: RuntimeSchemaRefs.RunRecordValue, definition: 'RunRecordValue', kind: 'run' },
  { schema: RuntimeSchemaRefs.RunBinding, definition: 'RunBinding', kind: 'binding' },
  { schema: RuntimeSchemaRefs.ActionRecordValue, definition: 'ActionRecordValue', kind: 'action' },
  { schema: RuntimeSchemaRefs.AttemptRecordValue, definition: 'AttemptRecordValue', kind: 'attempt' },
  { schema: RuntimeSchemaRefs.SignalRecordValue, definition: 'SignalRecordValue', kind: 'signal' },
  { schema: RuntimeSchemaRefs.WaitRecordValue, definition: 'WaitRecordValue', kind: 'wait' },
  {
    schema: RuntimeSchemaRefs.ActionVisibilityValue,
    definition: 'ActionVisibilityValue',
    kind: 'visibility',
  },
])
