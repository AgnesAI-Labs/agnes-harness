import { createHash } from 'node:crypto'
import { commandBinding } from '@agnes/daemon-rpc/local/command-binding'
import type { ManagedInputResult, ManagedInputTarget } from '@agnes/extension-api'
import { type Actor, type JsonValue, rpcError } from '@agnes/protocol'
import { inputProgress, projectInput, sessionLane } from './managed-input-submit.js'
import {
  MANAGED_INPUT_TEXT_LIMIT,
  type ManagedInputChange,
  type ManagedInputRow,
  type ManagedSessionInputs,
  type NewManagedInput,
} from './managed-session-inputs.js'
import type { ManagedSessionRecord } from './managed-session-records.js'
import type { ManagedSessionCaller, ManagedSessionPorts } from './managed-sessions.js'

export interface ManagedInputSource {
  readonly instanceId: string
  readonly pairingId: string
  readonly eventId: string
  readonly messageId: string
  readonly kind: 'message' | 'action'
  readonly actionId?: string
  readonly at: string
}

/** What the Host resolved for an `ownerMessage`: only in the request's `resolution` field beside `args`, never from plugin arguments. */
export type HostInputResolution =
  | {
      readonly kind: 'receipt'
      readonly receiptId: string
      readonly text: string
      readonly contentDigest: string
      readonly source: ManagedInputSource
    }
  | {
      readonly kind: 'unresolved'
      readonly receiptId: string
      readonly reason: 'receiptUnknown' | 'pairingChanged'
    }

export const RECOVERY_CONTINUATION_TEXT =
  'Continue the interrupted turn without treating this recovery as a new owner decision.'

export interface AdmitContext {
  readonly caller: ManagedSessionCaller
  readonly owner: string
  readonly record: ManagedSessionRecord
}

export interface ManagedInputReview {
  input: ManagedInputRow
  binding: { taskId: string; taskGeneration: number; startKey: string }
}

export interface OwnerInputEngine {
  admit(
    ctx: AdmitContext,
    input: unknown,
    resolution: HostInputResolution | undefined,
  ): Promise<ManagedInputResult>
  result(ctx: AdmitContext, input: unknown): Promise<ManagedInputResult>
  /** `result` also takes back a queued input whose checks now fail; an idle report never reads the inbox. */
  advance(sessionId: string, mode?: 'idle' | 'result'): Promise<void>
  sweep(): Promise<void>
  /** Shutdown started: `advance` and `sweep` do nothing from now on, and a sweep under way stops at its next session. */
  close(): void
  withdraw(owner: string, workspace?: string): Promise<void>
  review(sessionId: string, key: string): ManagedInputReview | undefined
  decide(
    sessionId: string,
    key: string,
    decision: 'deliver' | 'retain' | 'discard',
    expectVersion: number,
  ): Promise<ManagedInputResult>
}

export interface OwnerInputEngineDeps {
  ports: ManagedSessionPorts
  inputs: ManagedSessionInputs
  /** The lane `send` uses, `session\0<id>`, so an input and a send never interleave. */
  serial: <T>(key: string, work: () => Promise<T>) => Promise<T>
  /**
   * The start gates and the running gate: false when one refuses. Rejects when a gate cannot be read; an
   * admission then fails with its key left `queued`, and held inputs stay as they are until a later pass.
   */
  gatesPass(record: ManagedSessionRecord): Promise<boolean>
  /** The identity a submitted input carries: `managedSessionActor`. */
  actor(actorOwner: string, record: ManagedSessionRecord): Actor
  /** Whether the owner's package is installed and enabled. A disabled one keeps its inputs held. Absent: always. */
  enabled?(owner: string): Promise<boolean>
  /** Test fixtures only: throw to stand in for a crash between two writes. */
  faults?: { afterReserve?(): void; afterSubmit?(): void }
}

type AdmissionInput =
  | { kind: 'ownerMessage'; receiptId: string }
  | { kind: 'recoveryContinuation'; turnEndSeq: number }
  | { kind: 'legacyOwnerMessage'; text: string; originalInbox: string | null }
type Admission = { key: string; target: ManagedInputTarget; input: AdmissionInput }

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const refuse = (reason: string) => rpcError('CAPABILITY_DENIED', { reason })
const invalid = () => rpcError('INVALID_PARAMS')
const name = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const storable = (value: unknown): value is string =>
  name(value, MANAGED_INPUT_TEXT_LIMIT) && Buffer.byteLength(value, 'utf8') <= MANAGED_INPUT_TEXT_LIMIT
/** Turn ends a continuation may follow: the turn was cancelled or failed, never completed. */
const RECOVERABLE = new Set(['aborted', 'interrupted', 'error'])

/** Only the fields the contract names; anything else, an `ownerMessage` text included, is dropped. */
function parseAdmission(value: unknown): Admission {
  const request = value as {
    key?: unknown
    target?: Record<string, unknown>
    input?: Record<string, unknown>
  }
  const target = request?.target
  const input = request?.input
  if (
    !name(request?.key, 256) ||
    !target ||
    !name(target.taskId, 256) ||
    !name(target.startKey, 256) ||
    !Number.isSafeInteger(target.taskGeneration) ||
    (target.taskGeneration as number) < 0 ||
    !input
  )
    throw invalid()
  const parsed = {
    key: request.key,
    target: {
      taskId: target.taskId,
      taskGeneration: target.taskGeneration as number,
      startKey: target.startKey,
    },
  }
  if (input.kind === 'ownerMessage' && name(input.receiptId, 256))
    return { ...parsed, input: { kind: 'ownerMessage', receiptId: input.receiptId } }
  if (
    input.kind === 'recoveryContinuation' &&
    Number.isSafeInteger(input.turnEndSeq) &&
    (input.turnEndSeq as number) > 0
  )
    return { ...parsed, input: { kind: 'recoveryContinuation', turnEndSeq: input.turnEndSeq as number } }
  if (
    input.kind === 'legacyOwnerMessage' &&
    storable(input.text) &&
    (input.originalInbox === null || name(input.originalInbox, 4096))
  )
    return {
      ...parsed,
      input: { kind: 'legacyOwnerMessage', text: input.text, originalInbox: input.originalInbox },
    }
  throw invalid()
}

/**
 * The text an input carries and where it came from. An `ownerMessage` takes its text only from a
 * Host resolution of the same receipt; anything else stores nothing that could run.
 */
function prepare(request: Admission, resolution: HostInputResolution | undefined) {
  const input = request.input
  if (input.kind === 'ownerMessage') {
    const same = resolution?.receiptId === input.receiptId
    if (same && resolution?.kind === 'receipt' && storable(resolution.text))
      return {
        receiptId: input.receiptId,
        text: resolution.text,
        contentDigest: resolution.contentDigest,
        source: resolution.source as unknown as JsonValue,
      }
    return {
      receiptId: null,
      text: null,
      contentDigest: null,
      source: { receiptId: input.receiptId },
      unresolved: same && resolution?.kind === 'unresolved' ? resolution.reason : ('receiptUnknown' as const),
    }
  }
  const text = input.kind === 'legacyOwnerMessage' ? input.text : RECOVERY_CONTINUATION_TEXT
  const source =
    input.kind === 'legacyOwnerMessage'
      ? { originalInbox: input.originalInbox }
      : { turnEndSeq: input.turnEndSeq }
  return { receiptId: null, text, contentDigest: digest(text), source }
}

export function createOwnerInputEngine(deps: OwnerInputEngineDeps): OwnerInputEngine {
  const { ports, inputs } = deps
  const progress = inputProgress(deps)

  /**
   * A bound session must match. A session opened before bindings existed is bound here, once, by its
   * own manager naming its own start key; from then on it is like any other.
   */
  const bindTarget = (record: ManagedSessionRecord, owner: string, target: ManagedInputTarget) => {
    if (target.startKey !== record.startKey || record.owner !== owner)
      throw refuse('OWNER_INPUT_TARGET_MISMATCH')
    const late = { sessionId: record.sessionId, taskId: target.taskId, taskGeneration: target.taskGeneration }
    if (!ports.records.binding(record.sessionId)) ports.records.bindLate({ ...late, inputDigest: null })
    const binding = ports.records.binding(record.sessionId)
    if (binding?.taskId !== target.taskId || binding.taskGeneration !== target.taskGeneration)
      throw refuse('OWNER_INPUT_TARGET_MISMATCH')
  }

  const reserve = (
    ctx: AdmitContext,
    request: Admission,
    prepared: ReturnType<typeof prepare>,
    bindingDigest: string,
  ) => {
    const value: NewManagedInput = {
      owner: ctx.owner,
      sessionId: ctx.record.sessionId,
      key: request.key,
      bindingDigest,
      actorOwner: ctx.caller.owner,
      receiptId: prepared.receiptId,
      kind: request.input.kind,
      ...request.target,
      contentDigest: prepared.contentDigest,
      text: prepared.text,
      source: prepared.source,
      state: 'queued',
      reason: 'eligible',
      itemCommandId: null,
      submittedSeq: null,
      consumedTurn: null,
      consumedSeq: null,
    }
    // One receipt, one admission: a second key naming it keeps nothing that could run.
    if (inputs.reserve(value) === 'receiptTaken')
      inputs.reserve({
        ...value,
        receiptId: null,
        text: null,
        contentDigest: null,
        state: 'needsOwner',
        reason: 'receiptUnknown',
      })
  }

  const recoveryVerified = async (sessionId: string, turnEndSeq: number) => {
    const end = await ports.sessions.lastTurnEnd(sessionId)
    return end !== undefined && end.seq === turnEndSeq && RECOVERABLE.has(end.reason) && !end.laterStart
  }

  /** From `queued` to where the input belongs: the gates first, then what its kind needs, then the session. */
  const complete = async (
    row: ManagedInputRow,
    record: ManagedSessionRecord,
    request: Admission,
    prepared: ReturnType<typeof prepare>,
  ) => {
    const sessionId = record.sessionId
    const input = request.input
    let next: ManagedInputChange
    if (!(await deps.gatesPass(record))) next = { state: 'needsOwner', reason: 'grantRevoked' }
    else if (input.kind === 'ownerMessage' && row.text === null)
      next = {
        state: 'needsOwner',
        reason: 'unresolved' in prepared ? prepared.unresolved : 'receiptUnknown',
      }
    else if (input.kind === 'legacyOwnerMessage')
      next = { state: 'recoveryUnknown', reason: 'legacySourceUnknown' }
    else if (input.kind === 'recoveryContinuation' && !(await recoveryVerified(sessionId, input.turnEndSeq)))
      next = { state: 'recoveryUnknown', reason: 'recoveryUnverified' }
    else if (await progress.questionOpen(sessionId))
      next = { state: 'waitingQuestion', reason: 'questionOpen' }
    else next = { state: 'enqueued', reason: (await progress.busy(sessionId)) ? 'busy' : 'eligible' }
    progress.move(row, next)
  }

  const admit = async (ctx: AdmitContext, raw: unknown, resolution: HostInputResolution | undefined) => {
    const request = parseAdmission(raw)
    const sessionId = ctx.record.sessionId
    return deps.serial(sessionLane(sessionId), async () => {
      const record = ports.records.get(sessionId) ?? ctx.record
      // The daemon's archive state counts, so an owner archiving the session in the Web refuses too.
      if (record.archived || ports.sessions.archived(sessionId)) throw refuse('SESSION_ARCHIVED')
      const bindingDigest = commandBinding('managedInput', sessionId, request.target.taskGeneration, {
        owner: ctx.owner,
        service: ctx.caller.service,
        ...request.target,
        key: request.key,
        input: request.input,
      }).digest
      const prepared = prepare(request, resolution)
      let row = inputs.get(ctx.owner, sessionId, request.key)
      if (row && row.bindingDigest !== bindingDigest) throw refuse('OWNER_INPUT_KEY_REUSED')
      if (!row) {
        bindTarget(record, ctx.owner, request.target)
        reserve(ctx, request, prepared, bindingDigest)
        deps.faults?.afterReserve?.()
        row = inputs.get(ctx.owner, sessionId, request.key) as ManagedInputRow
      }
      if (row.state === 'queued') await complete(row, record, request, prepared)
      // The input is recorded; a failed submit is retried by the sweep, so the caller still gets it.
      await progress.advanceNow(sessionId, 'result').catch(() => undefined)
      return projectInput(inputs.get(ctx.owner, sessionId, request.key) ?? row)
    })
  }

  const result = async (ctx: AdmitContext, raw: unknown): Promise<ManagedInputResult> => {
    const key = (raw as { key?: unknown } | null)?.key
    if (!name(key, 256)) throw invalid()
    const sessionId = ctx.record.sessionId
    return deps.serial(sessionLane(sessionId), async () => {
      const row = inputs.get(ctx.owner, sessionId, key)
      if (row) {
        await progress.advanceNow(sessionId, 'result').catch(() => undefined)
        return projectInput(inputs.get(ctx.owner, sessionId, key) ?? row)
      }
      // The sends ledger is never pruned by time: a key in neither table was never sent or admitted.
      const sent = ports.records.sendState(ctx.owner, sessionId, key)
      if (sent === undefined) return { state: 'absent', historyCoverage: 'complete' }
      const actor = deps.actor(ctx.caller.owner, ctx.record)
      const found = await ports.sessions.findUserMessage(
        sessionId,
        `${actor.id}:send:${digest(key).slice(0, 32)}`,
        1,
      )
      return {
        state: 'legacySend',
        delivery: found ? 'consumed' : sent === 'pending' ? 'pending' : 'unknown',
      }
    })
  }

  let closed = false
  return {
    admit,
    result,
    async advance(sessionId, mode = 'idle') {
      if (closed) return
      // Every session reports idle; one without held or submitted inputs costs two indexed reads.
      if (inputs.held(sessionId).length === 0 && inputs.inFlight(sessionId).length === 0) return
      await deps.serial(sessionLane(sessionId), () => progress.advanceNow(sessionId, mode))
    },
    close() {
      closed = true
    },
    async sweep() {
      for (const sessionId of inputs.sessionsWithWork())
        if (!closed)
          await deps
            .serial(sessionLane(sessionId), () => progress.advanceNow(sessionId, 'sweep'))
            .catch(() => undefined)
    },
    async withdraw(owner, workspace) {
      let failure: unknown
      for (const row of inputs.byOwner(owner)) {
        if (workspace !== undefined && ports.records.get(row.sessionId)?.workspace !== workspace) continue
        await deps
          .serial(sessionLane(row.sessionId), () => progress.withdrawNow(row.owner, row.sessionId, row.key))
          .catch((error: unknown) => {
            failure ??= error
          })
      }
      if (failure !== undefined) throw failure
    },
    review(sessionId, key) {
      const record = ports.records.get(sessionId)
      const row = record && inputs.get(record.owner, sessionId, key)
      return row
        ? {
            input: row,
            binding: { taskId: row.taskId, taskGeneration: row.taskGeneration, startKey: row.startKey },
          }
        : undefined
    },
    async decide(sessionId, key, decision, expectVersion) {
      if (!Number.isSafeInteger(expectVersion)) throw invalid()
      const record = ports.records.get(sessionId)
      if (!record) throw rpcError('SEMANTIC_REJECTED', { code: 'OWNER_INPUT_UNKNOWN' })
      return deps.serial(sessionLane(sessionId), () =>
        progress.decideNow(record, key, decision, expectVersion),
      )
    },
  }
}
