import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ModelAdapterDeployment } from '@agnes/ai/runtime'
import { jcs } from '@agnes/protocol'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type EffectResult,
  type ExternalRequestRef,
  type ReconcileResult,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { inline } from '../trace/provider-support.js'

type RequestIdentity = NonNullable<ActionFrame['requestIdentity']>
/** The dispatched attempt as State persisted it. */
export type ModelCallIdentity = Readonly<{
  runId: string
  actionId: string
  attemptId: string
  bindingId: string
  inputDigest: string
  requestIdentity: RequestIdentity
}>
/** Synchronous and never consults a current grant: revoked authority must not hide original facts. */
export type ModelCallRegistry = Readonly<{ attempt(attemptId: string): ModelCallIdentity | undefined }>
export type ModelAttemptKey = Readonly<{ runId: string; actionId: string; attemptId: string }>
export type ModelStoredAttempt = Readonly<{
  attempt: ModelAttemptKey
  bindingId: string
  request: ExternalRequestRef
  originKey: string
  bodyDigest: string | null
  state: 'sent_unsaved' | 'saved'
  result: EffectResult | null
  resultDigest: string | null
}>
export type ModelPendingAttempt =
  | Readonly<{ kind: 'sent_unsaved'; stored: ModelStoredAttempt }>
  | Readonly<{ kind: 'corrupt'; attemptKey: string }>
export type ModelSourceStoreOptions = Readonly<{
  path: string
  calls: ModelCallRegistry
  /** Declares that every wire send of this store's deployment passes `fence` first. Fixed at file creation. */
  soleSendFence: boolean
  now?: () => Date
  /** Test seam: runs inside the save transaction after the row is written and before it commits. */
  beforeCommit?: () => void
}>
export type ModelSourceStore = Readonly<{
  deployment: Readonly<Pick<ModelAdapterDeployment, 'save' | 'lookup'>>
  /** Synchronous, durable before it returns; false means the wire send must not happen. */
  fence(frame: ActionFrame, bodyDigest: string): boolean
  /** Host-private recovery and usage seam; never handed to the adapter, a plugin or a client. */
  admin: Readonly<{
    pending(): ModelPendingAttempt[]
    read(attempt: ModelAttemptKey): ModelStoredAttempt | undefined
  }>
  close(): void
}>

export class ModelSourceStoreConflict extends Error {}
export class ModelSourceStoreCorrupt extends Error {}
export class ModelSourceStoreRefused extends Error {
  readonly detailCode: string
  constructor(detailCode: string) {
    super(detailCode)
    this.detailCode = detailCode
  }
}

const FORMAT = 1
const MAX_RESULT_BYTES = 262144
// The adapter's reconcile path encodes the whole ReconcileResult inline, and refuses more than this.
const MAX_RECONCILE_BYTES = 65536
const LIMITS = { maxDepth: 128, maxMembers: 10000 }
const SHA256 = /^[a-f0-9]{64}$/
const REASON = /^[a-z0-9_]{1,64}$/
const DDL = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS model_attempts(
    attempt_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL, action_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    binding_id TEXT NOT NULL, input_digest TEXT NOT NULL,
    request_system TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    idempotency_key TEXT, origin_key TEXT NOT NULL UNIQUE,
    body_digest TEXT, intent_at TEXT,
    result TEXT, result_digest TEXT, saved_at TEXT,
    row_digest TEXT NOT NULL
  );`

type Row = Record<string, string | number | bigint | Uint8Array | null>
const digest = (value: unknown) => canonicalJsonDigest(value as never)
const same = (a: unknown, b: unknown) => jcs(a as never) === jcs(b as never)
const attemptKeyOf = (key: ModelAttemptKey) =>
  digest({ runId: key.runId, actionId: key.actionId, attemptId: key.attemptId })
const requestRefOf = (identity: RequestIdentity): ExternalRequestRef => ({
  system: identity.system,
  requestId: identity.aghRequestId,
  requestDigest: identity.requestDigest,
  ...(identity.idempotencyKey === null ? {} : { idempotencyKey: identity.idempotencyKey }),
})
const originKeyOf = (identity: RequestIdentity) => `${identity.system}:${identity.aghRequestId}`
const refuse = (detailCode: string): never => {
  throw new ModelSourceStoreRefused(detailCode)
}

/** The only result shape the model adapter produces after a send; anything else is refused, never trimmed. */
function checkResult(
  request: ExternalRequestRef,
  key: ModelAttemptKey,
  originKey: string,
  result: EffectResult,
) {
  if (result.outcome !== 'succeeded' && result.outcome !== 'unknown_effect') refuse('model_store_outcome')
  if (result.outcome === 'succeeded' && (result.result?.kind !== 'inline' || result.error !== undefined))
    refuse('model_store_result')
  if (result.outcome === 'unknown_effect' && result.error?.code !== 'unknown_effect')
    refuse('model_store_result')
  if (result.references.length !== 0) refuse('model_store_references')
  if (result.externalRequests.length !== 1 || !same(result.externalRequests[0], request))
    refuse('model_store_request')
  const fact = result.usage[0]
  if (
    result.usage.length !== 1 ||
    !fact ||
    fact.actionId !== key.actionId ||
    fact.attemptId !== key.attemptId ||
    fact.originKey !== originKey ||
    !same(fact.externalRequest, request) ||
    fact.dimensions.kind !== 'inline'
  )
    refuse('model_store_usage')
}

function rowDigest(row: Row): string {
  return digest({
    format: FORMAT,
    key: row.attempt_key,
    run: row.run_id,
    action: row.action_id,
    attempt: row.attempt_id,
    binding: row.binding_id,
    input: row.input_digest,
    system: row.request_system,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    origin: row.origin_key,
    body: row.body_digest,
    intentAt: row.intent_at,
    result: row.result_digest,
    savedAt: row.saved_at,
  })
}

/** Re-verifies a stored row from its bytes; throws when anything differs from what save wrote. */
function decode(row: Row): ModelStoredAttempt {
  const text = (name: string) => String(row[name])
  const nullable = (name: string) => (row[name] === null ? null : text(name))
  const key: ModelAttemptKey = {
    runId: text('run_id'),
    actionId: text('action_id'),
    attemptId: text('attempt_id'),
  }
  const request: ExternalRequestRef = {
    system: text('request_system'),
    requestId: text('request_id'),
    requestDigest: text('request_digest'),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: text('idempotency_key') }),
  }
  if (
    text('attempt_key') !== attemptKeyOf(key) ||
    text('row_digest') !== rowDigest(row) ||
    text('origin_key') !== `${request.system}:${request.requestId}` ||
    (row.intent_at === null && row.result === null)
  )
    throw new ModelSourceStoreCorrupt('model source row differs from its digest')
  let result: EffectResult | null = null
  if (row.result === null) {
    if (row.result_digest !== null || row.saved_at !== null)
      throw new ModelSourceStoreCorrupt('model source row has a result digest without a result')
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(text('result'))
    } catch {
      throw new ModelSourceStoreCorrupt('model source result is not JSON')
    }
    const checked = validateRuntime('EffectResult', parsed)
    if (
      !checked.ok ||
      row.saved_at === null ||
      jcs(parsed as never) !== text('result') ||
      text('result_digest') !== digest(parsed)
    )
      throw new ModelSourceStoreCorrupt('model source result differs from its digest')
    result = parsed as EffectResult
    try {
      checkResult(request, key, text('origin_key'), result)
    } catch {
      throw new ModelSourceStoreCorrupt('model source result no longer matches its request')
    }
  }
  return {
    attempt: key,
    bindingId: text('binding_id'),
    request,
    originKey: text('origin_key'),
    bodyDigest: nullable('body_digest'),
    state: result === null ? 'sent_unsaved' : 'saved',
    result,
    resultDigest: nullable('result_digest'),
  }
}

function busyRetry<T>(run: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return run()
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5 || attempt >= 40) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

/** Host-private durable owner of the send fence, the saved EffectResult and the lookup over them. */
export function openModelSourceStore(options: ModelSourceStoreOptions): ModelSourceStore {
  const { path, calls } = options
  const clock = options.now ?? (() => new Date())
  if (!existsSync(dirname(path))) createPrivateDirectorySync(dirname(path))
  if (!existsSync(path)) {
    try {
      closeSync(createPrivateFileSync(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const db = new DatabaseSync(path)
  try {
    // Switching a fresh file to WAL can fail with SQLITE_BUSY without consulting the busy handler.
    busyRetry(() => {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (version > FORMAT) refuse('model_store_format')
      db.exec(DDL)
      if (version === 0) db.exec(`PRAGMA user_version=${FORMAT}`)
      const wanted = options.soleSendFence ? '1' : '0'
      db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('sole_send_fence', ?)").run(wanted)
      if (db.prepare("SELECT value FROM meta WHERE key='sole_send_fence'").get()?.value !== wanted)
        refuse('model_store_mode')
    })
  } catch (error) {
    db.close()
    throw error
  }

  function transaction<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original failure is the one to report.
      }
      throw error
    }
  }
  const find = (key: ModelAttemptKey) =>
    db.prepare('SELECT * FROM model_attempts WHERE attempt_key=?').get(attemptKeyOf(key)) as Row | undefined
  const registered = (attemptId: string): ModelCallIdentity | undefined => {
    try {
      return calls.attempt(attemptId)
    } catch {
      return undefined
    }
  }
  /** The write qualification: the frame must be the dispatched attempt State persisted, not a self-report. */
  function qualify(frame: ActionFrame): ModelCallIdentity {
    const identity = registered(frame.attemptId)
    if (
      !validateRuntime('ActionFrame', frame).ok ||
      frame.method !== 'invoke' ||
      frame.requestIdentity === null ||
      !identity ||
      identity.runId !== frame.runId ||
      identity.actionId !== frame.actionId ||
      identity.attemptId !== frame.attemptId ||
      identity.bindingId !== frame.bindingId ||
      identity.inputDigest !== frame.inputDigest ||
      !same(identity.requestIdentity, frame.requestIdentity)
    )
      return refuse('model_call_unregistered')
    return identity
  }

  const columns = (identity: ModelCallIdentity, bodyDigest: string | null, intentAt: string | null): Row => {
    const request = requestRefOf(identity.requestIdentity)
    const key = attemptKeyOf(identity)
    const row: Row = {
      attempt_key: key,
      run_id: identity.runId,
      action_id: identity.actionId,
      attempt_id: identity.attemptId,
      binding_id: identity.bindingId,
      input_digest: identity.inputDigest,
      request_system: request.system,
      request_id: request.requestId,
      request_digest: request.requestDigest,
      idempotency_key: request.idempotencyKey ?? null,
      origin_key: originKeyOf(identity.requestIdentity),
      body_digest: bodyDigest,
      intent_at: intentAt,
      result: null,
      result_digest: null,
      saved_at: null,
      row_digest: '',
    }
    return { ...row, row_digest: rowDigest(row) }
  }
  const insert = (row: Row) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO model_attempts(attempt_key, run_id, action_id, attempt_id, binding_id, input_digest,
          request_system, request_id, request_digest, idempotency_key, origin_key, body_digest, intent_at,
          result, result_digest, saved_at, row_digest)
         VALUES (:attempt_key, :run_id, :action_id, :attempt_id, :binding_id, :input_digest, :request_system,
          :request_id, :request_digest, :idempotency_key, :origin_key, :body_digest, :intent_at, :result,
          :result_digest, :saved_at, :row_digest)`,
      )
      .run(row).changes === 1

  function fence(frame: ActionFrame, bodyDigest: string): boolean {
    try {
      if (!SHA256.test(bodyDigest)) return false
      const identity = qualify(frame)
      return transaction(() => insert(columns(identity, bodyDigest, clock().toISOString())))
    } catch {
      return false
    }
  }

  async function save(frame: ActionFrame, result: EffectResult, bodyDigest: string | null): Promise<void> {
    const identity = qualify(frame)
    if (bodyDigest !== null && !SHA256.test(bodyDigest)) refuse('model_store_body_digest')
    const request = requestRefOf(identity.requestIdentity)
    const originKey = originKeyOf(identity.requestIdentity)
    if (!validateRuntime('EffectResult', result).ok) refuse('model_store_result')
    checkResult(request, identity, originKey, result)
    const canonical = boundedCanonicalJson(result, { maxBytes: MAX_RESULT_BYTES, ...LIMITS })
    if (!canonical.ok) return refuse('model_store_oversize')
    const resultDigest = canonicalJsonDigest(canonical.value.json)
    transaction(() => {
      const found = find(identity)
      if (found) {
        const stored = decode(found)
        if (
          stored.bindingId !== identity.bindingId ||
          !same(stored.request, request) ||
          found.input_digest !== identity.inputDigest ||
          stored.bodyDigest !== bodyDigest
        )
          throw new ModelSourceStoreConflict('model source attempt was recorded with different content')
        if (stored.state === 'saved') {
          if (stored.resultDigest === resultDigest) return
          throw new ModelSourceStoreConflict('model source result differs from the saved one')
        }
      }
      const savedAt = clock().toISOString()
      const saved: Row = {
        ...columns(identity, bodyDigest, found ? String(found.intent_at) : null),
        result: canonical.value.canonical,
        result_digest: resultDigest,
        saved_at: savedAt,
      }
      const savedDigest = rowDigest(saved)
      saved.row_digest = savedDigest
      if (found) {
        const updated = db
          .prepare(
            'UPDATE model_attempts SET result=?, result_digest=?, saved_at=?, row_digest=? WHERE attempt_key=? AND result IS NULL',
          )
          .run(canonical.value.canonical, resultDigest, savedAt, savedDigest, attemptKeyOf(identity))
        if (updated.changes !== 1) throw new ModelSourceStoreConflict('model source row changed during save')
      } else if (!insert(saved)) {
        throw new ModelSourceStoreConflict('model source request identity is already recorded')
      }
      options.beforeCommit?.()
    })
  }

  const evidence = (state: string, extra: Record<string, unknown> = {}) =>
    inline(RuntimeSchemaRefs.StandardToolOutput, {
      content: [],
      structured: { store: 'model-source', state, ...extra },
    })
  const unresolved = (reason: string, extra: Record<string, unknown> = {}): ReconcileResult => ({
    kind: 'unknown',
    evidence: evidence(reason, extra),
    reason,
  })

  const lookup: ModelAdapterDeployment['lookup'] = async (frame, _evidence, context, target) => {
    try {
      if (context.call.signal.aborted) return unresolved('model_lookup_cancelled')
      // With a target, `frame` is the reconcile action's own frame; only then does `target` name the attempt.
      const key: ModelAttemptKey | null = target
        ? { runId: target.run.runId, actionId: target.actionId, attemptId: target.attemptId }
        : frame.method === 'invoke'
          ? { runId: frame.runId, actionId: frame.actionId, attemptId: frame.attemptId }
          : null
      if (!key) return unresolved('model_attempt_mismatch')
      const identity = registered(key.attemptId)
      if (!identity) return unresolved('model_call_unregistered')
      if (
        identity.runId !== key.runId ||
        identity.actionId !== key.actionId ||
        identity.bindingId !== frame.bindingId ||
        (target === null &&
          (frame.inputDigest !== identity.inputDigest ||
            !same(frame.requestIdentity, identity.requestIdentity)))
      )
        return unresolved('model_attempt_mismatch')
      const request = requestRefOf(identity.requestIdentity)
      const row = find(key)
      if (!row) {
        const elsewhere = db
          .prepare('SELECT attempt_key FROM model_attempts WHERE origin_key=?')
          .get(originKeyOf(identity.requestIdentity))
        if (elsewhere) return unresolved('model_request_sent_elsewhere')
        return options.soleSendFence
          ? { kind: 'not_found', evidence: evidence('not_sent'), safeToRetry: false }
          : unresolved('model_not_recorded')
      }
      let stored: ModelStoredAttempt
      try {
        stored = decode(row)
      } catch {
        return unresolved('model_store_corrupt')
      }
      if (stored.bindingId !== identity.bindingId || !same(stored.request, request))
        return unresolved('model_attempt_mismatch')
      const proof = { resultDigest: stored.resultDigest, bodyDigest: stored.bodyDigest }
      if (!stored.result) return unresolved('model_sent_unsaved', proof)
      if (stored.result.outcome !== 'succeeded') {
        const detail = stored.result.error?.detailCode ?? ''
        return unresolved(REASON.test(detail) ? detail : 'model_stream_unknown', proof)
      }
      const resolved: ReconcileResult = {
        kind: 'resolved',
        evidence: evidence('saved', proof),
        result: stored.result,
      }
      if (!boundedCanonicalJson(resolved, { maxBytes: MAX_RECONCILE_BYTES, ...LIMITS }).ok)
        return unresolved('model_result_oversize', proof)
      return resolved
    } catch {
      return unresolved('model_store_unavailable')
    }
  }

  const admin = Object.freeze({
    pending(): ModelPendingAttempt[] {
      const rows = db
        .prepare('SELECT * FROM model_attempts WHERE result IS NULL ORDER BY attempt_key')
        .all() as Row[]
      return rows.map((row): ModelPendingAttempt => {
        try {
          return { kind: 'sent_unsaved', stored: decode(row) }
        } catch {
          return { kind: 'corrupt', attemptKey: String(row.attempt_key) }
        }
      })
    },
    read(key: ModelAttemptKey): ModelStoredAttempt | undefined {
      const row = find(key)
      return row ? decode(row) : undefined
    },
  })
  return Object.freeze({
    deployment: Object.freeze({ save, lookup }),
    fence,
    admin,
    close: () => db.close(),
  })
}
