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

/** What the identity owner proved about one caller. The wrapper never builds or widens one. */
export type StateReadGrant = Readonly<{
  sessionId: string
  window: StateReadWindow
  /** Equal across calls of the same authority; changes on reconnect, generation change or revoke. */
  fingerprint: string
  /** The original runtime-scope context the native owner accepts; one object for this grant's life. */
  original: CallContext
  /** Epoch ms, never later than the original deadline, identity expiry or the caller's deadline. */
  deadline: number
  /** Synchronous and throwing. It is not a flag a caller can set. */
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
  kind: 'run' | 'binding' | 'action' | 'attempt' | 'signal' | 'issuance'
  relate?: (value: JsonValue) => Readonly<{ runId: string; actionId: string | null }> | null
}>

export const DEFAULT_READABLE: readonly ReadableSchema[] = Object.freeze([
  { schema: RuntimeSchemaRefs.RunRecordValue, definition: 'RunRecordValue', kind: 'run' },
  { schema: RuntimeSchemaRefs.RunBinding, definition: 'RunBinding', kind: 'binding' },
  { schema: RuntimeSchemaRefs.ActionRecordValue, definition: 'ActionRecordValue', kind: 'action' },
  { schema: RuntimeSchemaRefs.AttemptRecordValue, definition: 'AttemptRecordValue', kind: 'attempt' },
  { schema: RuntimeSchemaRefs.SignalRecordValue, definition: 'SignalRecordValue', kind: 'signal' },
])
