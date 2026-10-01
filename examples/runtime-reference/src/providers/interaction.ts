import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  computeApprovalIntentDigest,
  RuntimeErrorDetails,
  RuntimeSchemaRefs,
  validateApprovalAnswerForRequest,
  validateApprovalIntent,
  validateInlineApprovalAnswerReference,
  validateRuntime,
} from '@agnes/protocol/runtime'

export const INTERACTION_PROVIDER = { id: 'reference.interaction', contract: 'agh.interaction' } as const

type Answered = Extract<Wire.InteractionRecord, { status: 'answered' }>
export type InteractionEvidence = Answered['resolution']['evidence']
export type InteractionOwner = Wire.InteractionRecord['owner']
export type ResponseMethod = 'respond' | 'acceptResponse' | 'respondApproval'

/** Actor and evidence come from trusted ingress; the request body can never supply them. */
export type ResponseInput = Readonly<{
  method: ResponseMethod
  request: unknown
  actorRef: Wire.Id
  evidence: InteractionEvidence
}>

/** What the waiter's inbox receives. The key names one terminal change and survives redelivery. */
export type InteractionWake = Readonly<{
  deliveryKey: string
  interactionId: Wire.Id
  owner: InteractionOwner
  version: number
  status: Wire.InteractionRecord['status']
  responseId: Wire.Id | null
}>

/** Delivery is at least once; the inbox must not wake a waiter twice for one key. */
export type WakeSink = (wake: InteractionWake) => Promise<Outcome<{ deliveryId: string }>>

export type WakeState = Readonly<{
  wake: InteractionWake
  delivery: 'pending' | 'acked' | 'dead'
  failures: number
  dueAt: Wire.Timestamp
  lastError: Wire.RuntimeError | null
  ackRef: string | null
}>

export type InteractionClock = Readonly<{ now(): Wire.Timestamp; newId(): Wire.Id }>

export type InteractionStoreOptions = Readonly<{
  clock?: InteractionClock
  /** Consecutive delivery failures before a wake is parked as dead. */
  maxFailures?: number
  /** Wakes handed to the sink per flush. */
  batch?: number
}>

type Refusal = { ok: false; error: Wire.RuntimeError }

const refuse = (detail: keyof typeof RuntimeErrorDetails, message: string): Refusal => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'reference-interaction',
  },
})

const ENTRY_SCHEMA = {
  respond: 'InteractionRespondRequest',
  acceptResponse: 'InteractionClientRespondRequest',
  respondApproval: 'ApprovalRespondRequest',
} as const

const isDue = (now: Wire.Timestamp, deadline: Wire.Timestamp) => Date.parse(now) >= Date.parse(deadline)
const retryDelay = (failures: number) => Math.min(60_000, 1000 * 2 ** (failures - 1))

function inlineRef(schema: Wire.SchemaRef, value: Wire.JsonValue) {
  return {
    kind: 'inline' as const,
    schema,
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(jcs(value)),
  }
}

function checked(record: unknown): Outcome<Wire.InteractionRecord> {
  const parsed = validateRuntime('InteractionRecord', record)
  return parsed.ok ? parsed : refuse('internal_error', 'interaction record failed its own schema')
}

function fieldAccepts(field: Wire.QuestionField, entry: Wire.JsonValue): boolean {
  const options = 'options' in field ? field.options.map((option) => option.id) : []
  switch (field.kind) {
    case 'text':
      return (
        typeof entry === 'string' &&
        entry.length <= field.maxLength &&
        (field.multiline || !/[\r\n]/.test(entry))
      )
    case 'singleChoice':
      return typeof entry === 'string' && options.includes(entry)
    case 'multiChoice':
      return (
        Array.isArray(entry) &&
        new Set(entry).size === entry.length &&
        entry.length >= field.minItems &&
        entry.length <= field.maxItems &&
        entry.every((item) => typeof item === 'string' && options.includes(item))
      )
    case 'confirm':
      return typeof entry === 'boolean'
    // ponytail: custom fields need the author schema decoder; refused until a provider wires one in.
    default:
      return false
  }
}

function questionProblem(
  question: Wire.QuestionRequest,
  answer: Extract<Wire.DataRef, { kind: 'inline' }>,
): string | undefined {
  const { value } = answer
  if (answer.digest !== canonicalJsonDigest(value) || answer.bytes !== Buffer.byteLength(jcs(value)))
    return 'answer content evidence mismatch'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'answer must be an object'
  const known = new Set(question.fields.map((field) => field.id))
  const stray = Object.keys(value).find((key) => !known.has(key))
  if (stray !== undefined) return `unknown answer field ${stray}`
  for (const field of question.fields) {
    const entry = value[field.id]
    if (entry === undefined) {
      if (field.required) return `missing required field ${field.id}`
    } else if (!fieldAccepts(field, entry)) return `invalid value for ${field.id}`
  }
  return undefined
}

/** The answer one entry method carries, normalized for storage, or the reason it cannot be stored. */
function answerFor(
  method: ResponseMethod,
  request: Wire.InteractionRequest,
  input: Record<string, unknown>,
): Outcome<Wire.DataRef> {
  if (method === 'respondApproval') {
    if (request.kind !== 'approval') return refuse('invalid_request', 'a question cannot take an approval')
    const answer =
      input.decision === 'approve'
        ? { decision: 'approve', intentDigest: input.intentDigest, grantScope: input.grantScope ?? 'once' }
        : { decision: 'deny', intentDigest: input.intentDigest }
    const valid = validateApprovalAnswerForRequest(request, answer)
    return valid.ok
      ? { ok: true, value: inlineRef(RuntimeSchemaRefs.ApprovalAnswer, valid.value) }
      : refuse('invalid_request', valid.errors[0]?.message ?? 'invalid approval answer')
  }
  const answer = input.answer as Wire.DataRef
  if (request.kind === 'approval') {
    const valid = validateInlineApprovalAnswerReference(request, answer)
    return valid.ok
      ? valid
      : refuse('invalid_request', valid.errors[0]?.message ?? 'approval needs its answer')
  }
  if (jcs(answer.schema) !== jcs(request.answerSchema))
    return refuse('invalid_request', 'answer schema does not match the question')
  if (answer.kind !== 'inline') return refuse('unsupported', 'blob answers need the schema owner decoder')
  const problem = questionProblem(request, answer)
  return problem === undefined ? { ok: true, value: answer } : refuse('invalid_request', problem)
}

/**
 * Every version of an interaction is its own row, so a compare-and-set is an insert of the next version
 * and the primary key refuses a second writer. Accepted answers point at the version they produced;
 * their status is derived from that row and a delivery flag. Wakes form an outbox keyed `id@version`.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS interaction_versions (
  interaction_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  opening_key TEXT UNIQUE,
  record TEXT NOT NULL,
  PRIMARY KEY (interaction_id, version)
);
CREATE TABLE IF NOT EXISTS accepted_answers (
  response_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wake_outbox (
  delivery_key TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'acked', 'dead')),
  failures INTEGER NOT NULL,
  due_ms INTEGER NOT NULL,
  last_error TEXT,
  ack_ref TEXT
);`

type AnswerRow = {
  response_id: string
  fingerprint: string
  interaction_id: string
  version: number
  applied: number
}

type WakeRow = {
  delivery_key: string
  interaction_id: string
  version: number
  state: WakeState['delivery']
  failures: number
  due_ms: number
  last_error: string | null
  ack_ref: string | null
}

export function openInteractionStore(path: string, options: InteractionStoreOptions = {}) {
  const clock = options.clock ?? { now: () => new Date().toISOString(), newId: () => randomUUID() }
  const maxFailures = options.maxFailures ?? 20
  const batch = options.batch ?? 100
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  // An accepted answer has been reported to a client, so commits wait for the disk.
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  if (process.platform === 'darwin') db.exec('PRAGMA checkpoint_fullfsync = ON')
  db.exec(TABLES)
  let open = true
  let held = false

  const live = () => {
    if (!open) throw new Error('interaction store is closed')
  }
  function atomically<T>(body: () => T): T {
    live()
    if (held) return body()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const row = <T>(sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).get(...params) as T | undefined

  function recordAt(interactionId: string, version?: number): Wire.InteractionRecord | undefined {
    const found =
      version === undefined
        ? row<{ record: string }>(
            'SELECT record FROM interaction_versions WHERE interaction_id = ? ORDER BY version DESC LIMIT 1',
            interactionId,
          )
        : row<{ record: string }>(
            'SELECT record FROM interaction_versions WHERE interaction_id = ? AND version = ?',
            interactionId,
            version,
          )
    if (found === undefined) return undefined
    const parsed = validateRuntime('InteractionRecord', JSON.parse(found.record))
    if (!parsed.ok) throw new Error('stored interaction record is invalid')
    return parsed.value
  }

  function append(record: Wire.InteractionRecord, now: Wire.Timestamp, wake: boolean) {
    db.prepare(
      'INSERT INTO interaction_versions (interaction_id, version, opening_key, record) VALUES (?, ?, ?, ?)',
    ).run(
      record.interactionId,
      record.version,
      record.version === 1 ? record.request.idempotencyKey : null,
      JSON.stringify(record),
    )
    if (wake)
      db.prepare(
        `INSERT INTO wake_outbox (delivery_key, interaction_id, version, state, failures, due_ms)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
      ).run(
        `${record.interactionId}@${record.version}`,
        record.interactionId,
        record.version,
        Date.parse(now),
      )
  }

  function statusOf(answer: AnswerRow): Wire.InteractionResponseStatus {
    const result = recordAt(answer.interaction_id, answer.version)
    if (result === undefined) throw new Error('accepted answer lost its interaction version')
    return {
      interactionId: answer.interaction_id,
      responseId: answer.response_id,
      status: answer.applied === 1 ? 'applied' : 'accepted',
      version: answer.version,
      result,
      error: null,
    }
  }

  function wakeOf(found: WakeRow): WakeState {
    const record = recordAt(found.interaction_id, found.version)
    if (record === undefined) throw new Error('wake lost its interaction version')
    return {
      wake: {
        deliveryKey: found.delivery_key,
        interactionId: found.interaction_id,
        owner: record.owner,
        version: found.version,
        status: record.status,
        responseId: record.status === 'answered' ? record.resolution.responseId : null,
      },
      delivery: found.state,
      failures: found.failures,
      dueAt: new Date(found.due_ms).toISOString(),
      lastError: found.last_error === null ? null : (JSON.parse(found.last_error) as Wire.RuntimeError),
      ackRef: found.ack_ref,
    }
  }

  function terminate(method: 'expire' | 'cancel', request: unknown): Outcome<Wire.InteractionRecord> {
    const parsed = validateRuntime(
      method === 'expire' ? 'InteractionExpireRequest' : 'InteractionCancelRequest',
      request,
    )
    if (!parsed.ok) return refuse('invalid_request', `${method} request does not match its schema`)
    const { interactionId, expectedVersion, reason } = parsed.value
    const status = method === 'expire' ? 'expired' : 'cancelled'
    return atomically(() => {
      const current = recordAt(interactionId)
      if (current === undefined) return refuse('not_found', 'no such interaction')
      if (
        current.status === status &&
        current.version === expectedVersion + 1 &&
        current.terminationReason === reason
      )
        return { ok: true as const, value: current }
      if (current.status !== 'pending' || current.version !== expectedVersion)
        return refuse('revision_conflict', 'interaction is no longer at the expected version')
      const now = clock.now()
      if (method === 'expire' && !isDue(now, current.request.expiresAt))
        return refuse('blocked', 'interaction is not due to expire')
      const next = checked({
        ...current,
        version: current.version + 1,
        updatedAt: now,
        status,
        terminationReason: reason,
        resolution: null,
      })
      if (next.ok) append(next.value, now, true)
      return next
    })
  }

  function settle(deliveryKey: string, result: Outcome<{ deliveryId: string }>) {
    const now = Date.parse(clock.now())
    return atomically((): WakeState['delivery'] | undefined => {
      const current = row<WakeRow>('SELECT * FROM wake_outbox WHERE delivery_key = ?', deliveryKey)
      // Settled by another flush first; the inbox already ignores the repeated key.
      if (current?.state !== 'pending') return undefined
      if (result.ok) {
        db.prepare(
          "UPDATE wake_outbox SET state = 'acked', ack_ref = ?, last_error = NULL WHERE delivery_key = ?",
        ).run(result.value.deliveryId, deliveryKey)
        db.prepare('UPDATE accepted_answers SET applied = 1 WHERE interaction_id = ? AND version = ?').run(
          current.interaction_id,
          current.version,
        )
        return 'acked'
      }
      const failures = current.failures + 1
      const state = failures >= maxFailures ? 'dead' : 'pending'
      db.prepare(
        'UPDATE wake_outbox SET state = ?, failures = ?, due_ms = ?, last_error = ? WHERE delivery_key = ?',
      ).run(state, failures, now + retryDelay(failures), JSON.stringify(result.error), deliveryKey)
      return state
    })
  }

  return {
    request(input: { request: unknown; owner: InteractionOwner }): Outcome<Wire.InteractionRecord> {
      const parsed = validateRuntime('InteractionRequest', input.request)
      if (!parsed.ok) return refuse('invalid_request', 'interaction request does not match its schema')
      const request = parsed.value
      if (request.kind === 'approval' && !validateApprovalIntent(request).ok)
        return refuse('invalid_request', 'approval intent digest does not match the question')
      if (
        request.kind === 'question' &&
        new Set(request.fields.map((f) => f.id)).size !== request.fields.length
      )
        return refuse('invalid_request', 'question field ids repeat')
      const now = clock.now()
      return atomically(() => {
        const opened = row<{ interaction_id: string }>(
          'SELECT interaction_id FROM interaction_versions WHERE opening_key = ?',
          request.idempotencyKey,
        )
        if (opened !== undefined) {
          const current = recordAt(opened.interaction_id)
          return current !== undefined &&
            jcs(current.request) === jcs(request) &&
            jcs(current.owner) === jcs(input.owner)
            ? { ok: true as const, value: current }
            : refuse('idempotency_conflict', 'idempotency key already names another interaction')
        }
        if (isDue(now, request.expiresAt))
          return refuse('invalid_request', 'interaction expires before it opens')
        const record = checked({
          interactionId: clock.newId(),
          owner: input.owner,
          request,
          version: 1,
          createdAt: now,
          updatedAt: now,
          status: 'pending',
          terminationReason: null,
          resolution: null,
        })
        if (record.ok) append(record.value, now, false)
        return record
      })
    },

    respond(input: ResponseInput): Outcome<Wire.InteractionResponseStatus> {
      const parsed = validateRuntime(ENTRY_SCHEMA[input.method], input.request)
      if (!parsed.ok) return refuse('invalid_request', 'response does not match its schema')
      const { interactionId, responseId, expectedVersion } = parsed.value
      return atomically(() => {
        const current = recordAt(interactionId)
        if (current === undefined) return refuse('not_found', 'no such interaction')
        const answer = answerFor(input.method, current.request, parsed.value as Record<string, unknown>)
        if (!answer.ok) return answer
        const fingerprint = canonicalJsonDigest({
          method: input.method,
          interactionId,
          expectedVersion,
          actorRef: input.actorRef,
          answer: answer.value,
        })
        const prior = row<AnswerRow>('SELECT * FROM accepted_answers WHERE response_id = ?', responseId)
        if (prior !== undefined)
          return prior.fingerprint === fingerprint
            ? { ok: true as const, value: statusOf(prior) }
            : refuse('idempotency_conflict', 'response id already carries another answer')
        if (current.status !== 'pending' || current.version !== expectedVersion)
          return refuse('revision_conflict', 'interaction is no longer at the expected version')
        const now = clock.now()
        if (isDue(now, current.request.expiresAt)) return refuse('blocked', 'interaction has expired')
        if (!current.request.allowedResponders.includes(input.actorRef))
          return refuse('permission_denied', 'actor may not answer this interaction')
        const answered = checked({
          ...current,
          version: current.version + 1,
          updatedAt: now,
          status: 'answered',
          terminationReason: null,
          resolution: {
            responseId,
            actorRef: input.actorRef,
            answer: answer.value,
            committedAt: now,
            evidence: input.evidence,
          },
        })
        if (!answered.ok) return answered
        const accepted: AnswerRow = {
          response_id: responseId,
          fingerprint,
          interaction_id: interactionId,
          version: answered.value.version,
          applied: 0,
        }
        append(answered.value, now, true)
        db.prepare(
          'INSERT INTO accepted_answers (response_id, fingerprint, interaction_id, version) VALUES (?, ?, ?, ?)',
        ).run(responseId, fingerprint, interactionId, accepted.version)
        return { ok: true as const, value: statusOf(accepted) }
      })
    },

    expire: (request: unknown) => terminate('expire', request),
    cancel: (request: unknown) => terminate('cancel', request),

    read(interactionId: Wire.Id): Outcome<Wire.InteractionRecord> {
      live()
      const record = recordAt(interactionId)
      return record === undefined ? refuse('not_found', 'no such interaction') : { ok: true, value: record }
    },

    /** This store is the only place an answer is accepted, so absence here is authoritative. */
    responseStatus(responseId: Wire.Id): Outcome<Wire.InteractionResponseStatus> {
      live()
      const accepted = row<AnswerRow>('SELECT * FROM accepted_answers WHERE response_id = ?', responseId)
      return {
        ok: true,
        value:
          accepted === undefined
            ? {
                responseId,
                status: 'not-accepted',
                interactionId: null,
                version: null,
                result: null,
                error: null,
              }
            : statusOf(accepted),
      }
    },

    wakes(): readonly WakeState[] {
      live()
      return (db.prepare('SELECT * FROM wake_outbox ORDER BY due_ms, delivery_key').all() as WakeRow[]).map(
        wakeOf,
      )
    },

    /** Hands due wakes to the sink. An acknowledged answer moves from accepted to applied. */
    async flush(sink: WakeSink): Promise<{ acked: number; retrying: number; dead: number }> {
      live()
      const due = (
        db
          .prepare(
            "SELECT * FROM wake_outbox WHERE state = 'pending' AND due_ms <= ? ORDER BY due_ms LIMIT ?",
          )
          .all(Date.parse(clock.now()), batch) as WakeRow[]
      ).map(wakeOf)
      const counts = { acked: 0, retrying: 0, dead: 0 }
      for (const state of due) {
        let result: Outcome<{ deliveryId: string }>
        try {
          result = await sink(state.wake)
        } catch (error) {
          result = refuse('backend_unavailable', error instanceof Error ? error.message : 'inbox unavailable')
        }
        const settled = settle(state.wake.deliveryKey, result)
        if (settled === 'acked') counts.acked++
        else if (settled === 'pending') counts.retrying++
        else if (settled === 'dead') counts.dead++
      }
      return counts
    },

    /** Returns a dead wake to delivery under its original key. */
    redrive(deliveryKey: string): Outcome<WakeState> {
      return atomically(() => {
        const current = row<WakeRow>('SELECT * FROM wake_outbox WHERE delivery_key = ?', deliveryKey)
        if (current === undefined) return refuse('not_found', 'no such wake')
        if (current.state !== 'dead') return refuse('revision_conflict', 'only a dead wake can be redriven')
        const dueMs = Date.parse(clock.now())
        db.prepare(
          "UPDATE wake_outbox SET state = 'pending', failures = 0, due_ms = ? WHERE delivery_key = ?",
        ).run(dueMs, deliveryKey)
        return {
          ok: true as const,
          value: wakeOf({ ...current, state: 'pending', failures: 0, due_ms: dueMs }),
        }
      })
    },

    /** Opens a transaction that is never committed; later writes join it. Only the crash test uses this. */
    holdUncommitted() {
      live()
      db.exec('BEGIN IMMEDIATE')
      held = true
    },

    close() {
      if (!open) return
      open = false
      db.close()
    },
  }
}

export type InteractionStore = ReturnType<typeof openInteractionStore>

const CLI_OWNER = { runId: 'cli-run', actionId: 'cli-action' }

function cliApproval(idempotencyKey: string) {
  const request = {
    kind: 'approval',
    title: 'Delete build output',
    body: 'rm -rf dist',
    actionRef: 'cli-action',
    inputDigest: 'b'.repeat(64),
    policyDecisionRef: 'cli-policy',
    scope: { kind: 'workspace', installationId: 'i1', runtimeId: 'r1', workspaceId: 'w1' },
    allowedResponders: ['alice'],
    allowedGrantScopes: ['once'],
    expiresAt: '2099-01-01T00:00:00Z',
    idempotencyKey,
    risk: 'destructive',
    intentDigest: '0'.repeat(64),
  }
  const digest = computeApprovalIntentDigest(request)
  if (!digest.ok) throw new Error('cli approval is invalid')
  return { ...request, intentDigest: digest.value }
}

function cliApprove(interactionId: string, intentDigest: string, responseId: string): ResponseInput {
  return {
    method: 'respondApproval',
    actorRef: 'alice',
    evidence: {
      kind: 'human',
      authenticationRef: inlineRef(
        { typeId: 'reference.identity/cli@1', revision: 1, digest: 'a'.repeat(64) },
        {
          session: 'cli',
        },
      ),
    },
    request: {
      interactionId,
      responseId,
      expectedVersion: 1,
      decision: 'approve',
      intentDigest,
    },
  }
}

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

function argument(argv: readonly string[], index: number): string {
  const value = argv[index]
  if (value === undefined) throw new Error('interaction provider arguments are missing')
  return value
}

const idle = () => setInterval(() => undefined, 1000)

function runCommand(argv: readonly string[]): void {
  const command = argument(argv, 0)
  const store = openInteractionStore(argument(argv, 1))
  if (command === 'hold') {
    // Answers A and commits it, opens B, then answers B inside a transaction that never commits.
    const askA = cliApproval('kill-a')
    const askB = cliApproval('kill-b')
    const a = must(store.request({ request: askA, owner: CLI_OWNER }))
    must(store.respond(cliApprove(a.interactionId, askA.intentDigest, 'resp-a')))
    const b = must(store.request({ request: askB, owner: CLI_OWNER }))
    store.holdUncommitted()
    must(store.respond(cliApprove(b.interactionId, askB.intentDigest, 'resp-b')))
    process.stdout.write(`READY ${a.interactionId} ${b.interactionId}\n`)
    idle()
    return
  }
  if (command === 'deliver') {
    // Hands every due wake out on stdout and never records the acknowledgement.
    void store.flush(async (wake) => {
      process.stdout.write(`DELIVERED ${wake.deliveryKey}\n`)
      return new Promise(() => undefined)
    })
    idle()
    return
  }
  if (command === 'read') {
    const state = (id: string) => {
      const found = store.read(id)
      return found.ok ? `${found.value.status}@${found.value.version}` : found.error.detailCode
    }
    const summary = {
      a: state(argument(argv, 2)),
      b: state(argument(argv, 3)),
      responses: ['resp-a', 'resp-b'].map((id) => must(store.responseStatus(id)).status),
      wakes: store.wakes().map((item) => `${item.wake.deliveryKey} ${item.delivery}`),
    }
    store.close()
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    return
  }
  store.close()
  throw new Error(`unknown interaction command ${command}`)
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  try {
    runCommand(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'interaction provider failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
