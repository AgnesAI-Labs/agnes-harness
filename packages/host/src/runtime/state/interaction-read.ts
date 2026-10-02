import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type InteractionClientPendingRequest,
  type InteractionRecord,
  type InteractionResponseStatus,
  type JsonValue,
  type PageInteractionRecord,
  type RecordOwner,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { frozenJson } from '../../ext-host/frozen-json.js'
import { integrity, refuse } from './refusal.js'

type QueryScope = InteractionClientPendingRequest['scope']
export type InteractionReader = Readonly<{ binding: string; scope: QueryScope }>

/** Installed private capability, never taken from a client DTO. */
export interface RuntimeInteractionReadOwner {
  owner: RecordOwner
  cursorKey: Uint8Array
  now(): number
  /** Installed owner proves that this State session is the complete response realm, including tombstones. */
  responseRealmComplete?(context: CallContext, physicalSessionId: string): boolean
  current(context: CallContext, scope?: QueryScope): InteractionReader
}

/** Immutable membership proof is constructed and verified by the original State owner. */
export type InteractionReadCut = Readonly<{
  snapshot: string
  scope: QueryScope
  membership: JsonValue
}>
export type InteractionResponseFact = Readonly<{
  status: InteractionResponseStatus
  /** The actual State adapter checks all required destinations and their original inbox acknowledgements. */
  runtimeAdmission: 'pending' | 'acknowledged'
}>

/** All functions execute inside snapshot(), on the original State connection and immutable source. */
export interface InteractionReadPorts {
  snapshot<T>(body: () => Promise<T>): Promise<T>
  read(interactionId: string, reader: InteractionReader): Promise<InteractionRecord | undefined>
  response(responseId: string, reader: InteractionReader): Promise<InteractionResponseFact | undefined>
  /** Covers every admitted response/tombstone in this authorized realm, without an operation filter. */
  responseRealmComplete(reader: InteractionReader): Promise<boolean>
  cut(scope: QueryScope, reader: InteractionReader): Promise<InteractionReadCut>
  /** Rechecks retained source membership and returns the exact latest versions at the sealed cut. */
  recordsAt(cut: InteractionReadCut, reader: InteractionReader): Promise<readonly InteractionRecord[]>
}

type CursorBody = {
  v: 1
  authority: RecordOwner
  reader: InteractionReader
  cut: InteractionReadCut
  limit: number
  after: string
  expiresAt: number
}
const CURSOR_LIFETIME_MS = 300_000
const MAX_CURSOR_BYTES = 1_048_576
function same(left: unknown, right: unknown): boolean {
  return jcs(left) === jcs(right)
}
function immutable<T>(value: T): T {
  return frozenJson(JSON.parse(jcs(value))) as T
}
function current(
  owner: RuntimeInteractionReadOwner,
  context: CallContext,
  scope?: QueryScope,
): InteractionReader {
  if (context.signal.aborted || !(Date.parse(context.deadline) > owner.now()))
    refuse('denied', 'interaction_current', 'interaction read is no longer current')
  const reader = owner.current(context, scope)
  if (
    !reader ||
    !validateRuntime('Id', reader.binding).ok ||
    !validateRuntime('AuthorizedViewScope', reader.scope).ok
  )
    refuse('denied', 'interaction_reader', 'current interaction reader is unavailable')
  if (scope && !same(scope, reader.scope))
    refuse('denied', 'interaction_scope', 'interaction query scope is not authorized')
  return immutable(reader)
}
function unchanged(
  owner: RuntimeInteractionReadOwner,
  context: CallContext,
  reader: InteractionReader,
): void {
  if (!same(current(owner, context, reader.scope), reader))
    refuse('denied', 'interaction_reader', 'interaction reader changed during the query')
}
function record(value: InteractionRecord): InteractionRecord {
  const checked = validateRuntime('InteractionRecord', value)
  if (!checked.ok) integrity('interaction immutable record is invalid')
  return immutable(checked.value)
}
function status(value: InteractionResponseStatus): InteractionResponseStatus {
  const checked = validateRuntime('InteractionResponseStatus', value)
  if (!checked.ok) integrity('interaction immutable response is invalid')
  return immutable(checked.value)
}
function seal(owner: RuntimeInteractionReadOwner, body: CursorBody): string {
  if (owner.cursorKey.byteLength < 32)
    refuse('internal', 'interaction_cursor', 'protected cursor key is unavailable')
  const payload = Buffer.from(jcs(body)).toString('base64url')
  if (payload.length > MAX_CURSOR_BYTES)
    refuse('conflict', 'interaction_cut', 'interaction membership proof exceeds the cursor bound')
  const mac = createHmac('sha256', owner.cursorKey).update(payload).digest('base64url')
  return `${payload}.${mac}`
}
function unseal(owner: RuntimeInteractionReadOwner, cursor: string): CursorBody {
  const invalid = (): never => refuse('conflict', 'resync_required', 'interaction cursor must be refreshed')
  if (cursor.length > MAX_CURSOR_BYTES + 64 || owner.cursorKey.byteLength < 32) invalid()
  const parts = cursor.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid()
  const expected = createHmac('sha256', owner.cursorKey).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch {
    return invalid()
  }
  if (!parsed || typeof parsed !== 'object') return invalid()
  const body = parsed as CursorBody
  if (
    body.v !== 1 ||
    !same(body.authority, owner.owner) ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= owner.now() ||
    !body.cut ||
    !validateRuntime('Id', body.cut.snapshot).ok ||
    !validateRuntime('JsonValue', body.cut.membership).ok ||
    typeof body.after !== 'string'
  )
    return invalid()
  return body
}

export function createInteractionReads(owner: RuntimeInteractionReadOwner, ports: InteractionReadPorts) {
  return {
    async read(interactionId: string, context: CallContext): Promise<InteractionRecord> {
      if (!validateRuntime('Id', interactionId).ok)
        refuse('invalid_input', 'interaction_id', 'interaction identity is invalid')
      return ports.snapshot(async () => {
        const reader = current(owner, context)
        const found = await ports.read(interactionId, reader)
        if (!found) refuse('invalid_input', 'not_found', 'interaction does not exist in the authorized realm')
        const result = record(found)
        if (result.interactionId !== interactionId) integrity('interaction source identity differs')
        unchanged(owner, context, reader)
        return result
      })
    },
    async responseStatus(responseId: string, context: CallContext): Promise<InteractionResponseStatus> {
      if (!validateRuntime('Id', responseId).ok)
        refuse('invalid_input', 'response_id', 'response identity is invalid')
      return ports.snapshot(async () => {
        const reader = current(owner, context)
        const fact = await ports.response(responseId, reader)
        let result: InteractionResponseStatus
        if (!fact) {
          if (!(await ports.responseRealmComplete(reader)))
            refuse('conflict', 'interaction_unavailable', 'complete response realm cannot be proved')
          result = status({
            responseId,
            status: 'not-accepted',
            interactionId: null,
            version: null,
            result: null,
            error: null,
          })
        } else {
          if (fact.runtimeAdmission !== 'pending' && fact.runtimeAdmission !== 'acknowledged')
            integrity('interaction Runtime admission source is invalid')
          result = status(fact.status)
          if (result.responseId !== responseId || result.status === 'not-accepted')
            integrity('interaction admitted response identity differs')
          if (result.status === 'accepted' || result.status === 'applied') {
            result = status({
              ...result,
              status: fact.runtimeAdmission === 'acknowledged' ? 'applied' : 'accepted',
            })
          }
        }
        unchanged(owner, context, reader)
        return result
      })
    },
    async pending(
      request: InteractionClientPendingRequest,
      context: CallContext,
    ): Promise<PageInteractionRecord> {
      const checked = validateRuntime('InteractionClientPendingRequest', request)
      if (!checked.ok) refuse('invalid_input', 'interaction_pending', 'interaction pending query is invalid')
      const input = checked.value
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
        refuse('invalid_input', 'interaction_limit', 'interaction page limit is out of bounds')
      return ports.snapshot(async () => {
        const reader = current(owner, context, input.scope)
        const cursorKey = Buffer.from(owner.cursorKey)
        let cut: InteractionReadCut
        let after = ''
        let expiresAt = owner.now() + CURSOR_LIFETIME_MS
        if (input.cursor) {
          const body = unseal(owner, input.cursor)
          if (!same(body.reader, reader) || !same(body.cut.scope, input.scope) || body.limit !== limit)
            refuse('conflict', 'resync_required', 'interaction cursor query or reader differs')
          cut = body.cut
          after = body.after
          expiresAt = body.expiresAt
        } else {
          cut = await ports.cut(input.scope, reader)
        }
        if (!same(cut.scope, input.scope) || !validateRuntime('Id', cut.snapshot).ok)
          integrity('interaction cut belongs to another query')
        if (!validateRuntime('JsonValue', cut.membership).ok)
          integrity('interaction cut membership is invalid')
        cut = immutable(cut)
        const values = (await ports.recordsAt(cut, reader)).map(record)
        const ids = new Set<string>()
        for (const value of values) {
          if (ids.has(value.interactionId)) integrity('interaction cut repeats an identity')
          ids.add(value.interactionId)
        }
        const pending = values
          .filter(
            (value) =>
              value.status === 'pending' &&
              Buffer.compare(Buffer.from(value.interactionId), Buffer.from(after)) > 0,
          )
          .sort((a, b) => Buffer.compare(Buffer.from(a.interactionId), Buffer.from(b.interactionId)))
        const items = pending.slice(0, limit)
        const complete = pending.length <= limit
        const last = items.at(-1)
        const nextCursor = complete
          ? null
          : seal(owner, {
              v: 1,
              authority: owner.owner,
              reader,
              cut,
              limit,
              after: last?.interactionId ?? '',
              expiresAt,
            })
        unchanged(owner, context, reader)
        if (
          cursorKey.byteLength !== owner.cursorKey.byteLength ||
          !timingSafeEqual(cursorKey, owner.cursorKey)
        )
          refuse('conflict', 'resync_required', 'interaction cursor key changed during the query')
        if (expiresAt <= owner.now())
          refuse('conflict', 'resync_required', 'interaction cut expired during the query')
        const result = { items, snapshot: cut.snapshot, nextCursor, complete }
        if (!validateRuntime('PageInteractionRecord', result).ok)
          integrity('interaction page violates the public contract')
        return immutable(result)
      })
    },
  }
}

export function interactionCutIdentity(membership: JsonValue): string {
  return `interaction-cut-${canonicalJsonDigest(membership)}`
}
