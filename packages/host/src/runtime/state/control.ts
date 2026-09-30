import type {
  AckOutboxRequest,
  AckOutboxResult,
  ActionResultView,
  ActionVisibilityValue,
  AdmitInvocationResult,
  AdmitQueryResult,
  AdvanceRunRequest,
  BindingRef,
  ClaimOutboxRequest,
  ClaimOutboxResult,
  CloseInvocationRequest,
  CloseInvocationResult,
  CommitControlRequest,
  CommitGuard,
  DataRef,
  DispatchAdmissionProbe,
  DispatchAdmissionRequest,
  DispatchAdmissionResult,
  ExternalRequestRef,
  FailOutboxRequest,
  FailOutboxResult,
  InvocationAdmission,
  OutboxClaim,
  OutboxRecord,
  PreparedAction,
  ProbeActionResultRequest,
  QueryAdmission,
  QueryUsageFlush,
  ReadGuard,
  Receipt,
  ReceiptIntakeRequest,
  ReceiptIntakeResult,
  RuntimeError,
  SchemaRef,
  Signal,
  StateAuthorityRef,
  StateCommitReceipt,
  UsageFact,
} from '@agnes/extension-api/runtime'
import { canonicalJson } from './canonical-json.js'
import {
  ACTION_SCHEMA,
  ATTEMPT_SCHEMA,
  actionRecordId,
  attemptRecordId,
  type CommitSideEntry,
  DISPATCH_ADMISSION_SCHEMA,
  digestOf,
  dispatchRecordId,
  grantRecordId,
  INVOCATION_SCHEMA,
  type IntegrityState,
  invocationRecordId,
  MIN_READER,
  OUTBOX_SCHEMA,
  outboxRecordId,
  PREPARE_QUOTA_SCHEMA,
  prepareRecordId,
  QUERY_GRANT_SCHEMA,
  QUOTA_MIRROR_SCHEMA,
  quotaRecordId,
  RECEIPT_SCHEMA,
  REFERENCE_SCHEMA,
  type RecordOwner,
  RUN_QUOTA_SCHEMA,
  RUN_RECORD_SCHEMA,
  type RunRecordValue,
  type RunTaintValue,
  receiptRecordId,
  referenceRecordId,
  runQuotaRecordId,
  runRecordId,
  type SessionIdentityValue,
  SIGNAL_SCHEMA,
  type StoredRecord,
  sameJson,
  signalRecordId,
  stableId,
  taintRecordId,
  USAGE_MIRROR_SCHEMA,
  usageMirrorRecordId,
  VISIBILITY_SCHEMA,
  visibilityRecordId,
} from './records.js'
import { integrity, refuse } from './refusal.js'

const MAX_QUERIES_PER_INVOCATION = 128
const MAX_QUERIES_PER_RUN = 65_536
const MAX_INVOCATION_STARTS = 20_000
const MAX_FAILED_INVOCATIONS = 32
const MAX_TRANSITIONS = 10_000
const MAX_NO_PROGRESS = 64
const MAX_ACTIONS = 64
const MAX_CONTINUATION_BYTES = 256 * 1024
const MAX_PARALLEL_ACTIONS = 16
const LIMIT_POLICY = 'default-limits'

const CONVERSATION_CONTRIBUTION = 'conversation contribution is not implemented'
const OTHER_TRANSITION = 'wait, complete, and fail transitions are not implemented'
const INLINE_PURE_RESULT = 'inline pure result handling is not implemented'
const STAGED_RESULT = 'staged result handling is not implemented'
const BUDGET_RESERVATION = 'bounded-units and cost-hard budget reservation is not implemented'
const LIVE_AGENT_QUOTA = 'live-agent quota is not implemented'
const HOOK_RESULTS = 'hook results and approval taint acknowledgement are not implemented'
const CONTROL_COMMAND = 'control command is not implemented'
const RESULT_TYPE = 'agh.runtime/action-result@1'
const STREAM_END_TYPE = 'agh.runtime/stream-end@1'
const COMPLETED_SIGNAL_TYPE = 'agh.runtime/action-completed@1'
const MAX_OUTBOX_CLAIM = 10_000
const OUTBOX_DEAD_AFTER = 20
const OUTBOX_BACKOFF_CAP_MS = 60_000

export type SqlArg = string | number | bigint | Uint8Array | null

export type SessionView = {
  lastSeq: number
  formatSeq: number
  headDigest: string
  latestCommitId: string
  workspaceId: string
  formatVersion: number
  minReader: number
  parent: SessionIdentityValue['parent']
  chain: IntegrityState
}

export type StoredHead = {
  record_id: string
  schema_json: string
  min_reader: number
  record_revision: number
  last_commit_id: string
  owner_json: string
  value_json: string
  body_digest: string
}

export type WriteCommitInput = {
  sessionId: string
  verified: SessionView
  commitId: string
  at: string
  fingerprint: string
  runId: string
  actionId: string | null
  writerEpoch: number
  runRevision: number
  actionIds: { key: string; actionId: string }[]
  creates: StoredRecord[]
  updates: { record: StoredRecord; previousRevision: number }[]
  sides: CommitSideEntry[]
}

export type Committed<T> = { result: T; sessionId: string; verified?: SessionView }

export interface ControlPorts {
  now(): number
  authority: StateAuthorityRef
  ulid(): string
  get<T>(sql: string, ...args: SqlArg[]): T | undefined
  all<T>(sql: string, ...args: SqlArg[]): T[]
  run(sql: string, ...args: SqlArg[]): void
  requireSession(sessionId: string): Promise<SessionView>
  replayRequest<T>(method: string, requestId: string, fingerprint: string): T | undefined
  rememberRequest(method: string, requestId: string, fingerprint: string, result: unknown): void
  loadHead(recordId: string): StoredHead | undefined
  writeCommit(input: WriteCommitInput): { receipt: StateCommitReceipt; verified: SessionView }
  assertReceipt(sessionId: string, receipt: StateCommitReceipt, fingerprint: string): void
  noteWrite(): void
  openQueryMeter(grantId: string, capacity: number): void
  queryMeter(grantId: string): { capacity: number; observed: number } | undefined
  lookupQueryTicket(
    grantId: string,
    requestId: string,
  ): { fingerprint: string; ticketId: string; remainingQueries: number } | undefined
  rememberQueryTicket(
    grantId: string,
    requestId: string,
    ticket: { fingerprint: string; ticketId: string; remainingQueries: number },
  ): void
}

type LeaseRow = {
  writer_id: string | null
  writer_epoch: number | null
  lease_until: number | null
  authority_epoch: number
}

type TaintSnapshot = { recordRevision: number; sourceSeq: number; clearedThroughSeq: number }

type OwnerRef = { kind: 'run' | 'action' | 'job' | 'reconciliation'; id: string }

type RunQuotaValue = {
  runId: string
  limitPolicyRef: string
  totalTransitions: number
  noProgressTransitions: number
  lastProgressRef: string | null
  submittedActions: number
  totalQueries: number
  reservedQueries: number
  invocationStarts: number
  failedInvocations: number
  activeQuotaReservationRefs: string[]
}

type InvocationValue = {
  invocationId: string
  prepareId: string
  runId: string
  targetActionId: string | null
  baseRevision: number
  bindingId: string
  writerEpoch: number
  state: 'active' | 'draining' | 'prepared' | 'committed' | 'closed' | 'faulted'
  queryGrantId: string
  queryCount: number
  readGuards: ReadGuard[]
  domainReads: CloseInvocationRequest['domainReads']
  startedAt: string
  deadline: string
  closedAt: string | null
  inflightIds: string[]
}

type PrepareValue = {
  prepareId: string
  runId: string
  targetActionId: string | null
  baseRevision: number
  totalQueries: number
  reservedQueries: number
  closed: boolean
}

type GrantValue = {
  grantId: string
  invocationId: string
  prepareId: string
  runId: string
  writerEpoch: number
  capacity: number
  flushedCount: number
  state: 'active' | 'settled'
  settledCount: number | null
}

type ActionValue = {
  actionId: string
  runId: string
  parentActionId: string | null
  key: string
  intent: PreparedAction
  intentFingerprint: string
  state: string
  currentAttemptId: string | null
  providerStateId: string | null
  firstReceiptId: string | null
  resolvedReceiptId: string | null
  resolutionId: string | null
  ownerRef: OwnerRef
  createdByCommitId: string
  resultHookPlan: null
  taintSnapshot: TaintSnapshot
  authorizationTaintSnapshot: TaintSnapshot | null
}

type AttemptValue = {
  attemptId: string
  actionId: string
  number: number
  kind: 'leaf' | 'composite' | 'control'
  bindingId: string
  inputDigest: string
  state: 'allocated' | 'dispatching' | 'running' | 'unknown' | 'settled'
  requestIdentity: DispatchAdmissionRequest['requestIdentity'] | null
  externalRequests: ExternalRequestRef[]
  authorizationRef: string | null
  budgetReservationRefs: string[]
  streamIds: string[]
  startedAt: string | null
  executeDeadline: string | null
  finishedAt: string | null
  receiptIds: string[]
  writerEpoch: number
}

type DispatchValue = {
  admissionId: string
  requestFingerprint: string
  result: DispatchAdmissionResult
}

type Remembered<T> = { result: T; receipt: StateCommitReceipt }

type RememberedDispatch = {
  request: DispatchAdmissionRequest
  decisionRef: DispatchAdmissionRequest['decisionRef']
  result: DispatchAdmissionResult
  receipt: StateCommitReceipt
}

type RejectReason = 'quota' | 'expired' | 'cancelled'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    integrity('record body cannot be decoded')
  }
}

function storedValue<T>(head: StoredHead): T {
  return parseJson(head.value_json) as T
}

function ownerOf(head: StoredHead): RecordOwner {
  return parseJson(head.owner_json) as RecordOwner
}

function requireHead(ports: ControlPorts, recordId: string, detail: string, message: string): StoredHead {
  const head = ports.loadHead(recordId)
  if (!head) refuse('invalid_input', detail, message)
  return head
}

function at(ports: ControlPorts): string {
  return new Date(ports.now()).toISOString()
}

function record(
  recordId: string,
  schema: SchemaRef,
  revision: number,
  owner: RecordOwner,
  value: unknown,
): StoredRecord {
  return { recordId, schema, minReader: MIN_READER, recordRevision: revision, owner, value }
}

function updated(head: StoredHead, schema: SchemaRef, owner: RecordOwner, value: unknown) {
  return {
    record: record(head.record_id, schema, head.record_revision + 1, owner, value),
    previousRevision: head.record_revision,
  }
}

function loadLease(ports: ControlPorts, sessionId: string): LeaseRow {
  return (
    ports.get<LeaseRow>(
      `SELECT writer_id, writer_epoch, lease_until, authority_epoch
       FROM runtime_leases WHERE scope_id = ?`,
      sessionId,
    ) ?? {
      writer_id: null,
      writer_epoch: null,
      lease_until: null,
      authority_epoch: ports.authority.authorityEpoch,
    }
  )
}

function leaseLive(lease: LeaseRow, now: number, writerEpoch: number, authorityEpoch: number): boolean {
  return (
    lease.writer_id !== null &&
    lease.writer_epoch === writerEpoch &&
    lease.authority_epoch === authorityEpoch &&
    lease.lease_until !== null &&
    lease.lease_until > now
  )
}

function assertLiveEpoch(ports: ControlPorts, sessionId: string, writerEpoch: number): void {
  const lease = loadLease(ports, sessionId)
  if (!leaseLive(lease, ports.now(), writerEpoch, ports.authority.authorityEpoch))
    refuse('conflict', 'writer_lease', 'writer lease is not live')
}

function assertWriter(ports: ControlPorts, sessionId: string, writerId: string, writerEpoch: number): void {
  const lease = loadLease(ports, sessionId)
  if (
    !leaseLive(lease, ports.now(), writerEpoch, ports.authority.authorityEpoch) ||
    lease.writer_id !== writerId
  )
    refuse('conflict', 'writer_lease', 'writer lease is not live')
}

function assertReadGuards(ports: ControlPorts, guards: readonly ReadGuard[]): void {
  for (const guard of guards) {
    const head = ports.loadHead(guard.recordId)
    const matches =
      guard.expectedRecordRevision === null
        ? head === undefined
        : head !== undefined && head.record_revision === guard.expectedRecordRevision
    if (!matches) refuse('conflict', 'read_guard', 'read guard does not match the current record')
  }
}

function loadRun(ports: ControlPorts, runId: string) {
  const head = requireHead(ports, runRecordId(runId), 'run_absent', 'run does not exist')
  return { head, value: storedValue<RunRecordValue>(head), owner: ownerOf(head) }
}

function taintOf(ports: ControlPorts, runId: string): TaintSnapshot {
  const head = requireHead(ports, taintRecordId(runId), 'taint_absent', 'run taint record is missing')
  const value = storedValue<RunTaintValue>(head)
  return {
    recordRevision: head.record_revision,
    sourceSeq: value.sourceSeq,
    clearedThroughSeq: value.clearedThroughSeq,
  }
}

function actionInputDigest(action: ActionValue): string {
  const intent = action.intent as { input?: unknown }
  if (intent.input === undefined) refuse('invalid_input', 'action_input', 'action input is missing')
  return digestOf(intent.input)
}

function actionFingerprint(action: PreparedAction): string {
  if (!('obligation' in action) || action.obligation !== 'mandatory')
    refuse('invalid_input', 'obligation', 'only a mandatory action can be submitted')
  const { intentFingerprint, ...body } = action
  if (digestOf(body) !== intentFingerprint)
    refuse('conflict', 'intent_fingerprint', 'action intent fingerprint does not match its body')
  return intentFingerprint
}

function replayWrapped<T>(
  ports: ControlPorts,
  sessionId: string,
  method: string,
  requestId: string,
  fingerprint: string,
): T | undefined {
  const stored = ports.replayRequest<Remembered<T>>(method, requestId, fingerprint)
  if (!stored) return undefined
  ports.assertReceipt(sessionId, stored.receipt, fingerprint)
  return stored.result
}

function rememberWrapped<T>(
  ports: ControlPorts,
  input: WriteCommitInput,
  method: string,
  requestId: string,
  fingerprint: string,
  result: T,
): Committed<T> {
  const written = ports.writeCommit(input)
  ports.rememberRequest(method, requestId, fingerprint, { result, receipt: written.receipt })
  return { result, sessionId: input.sessionId, verified: written.verified }
}

function blankInput(
  sessionId: string,
  verified: SessionView,
  commitId: string,
  stamp: string,
  fingerprint: string,
  runId: string,
  writerEpoch: number,
  runRevision: number,
): WriteCommitInput {
  return {
    sessionId,
    verified,
    commitId,
    at: stamp,
    fingerprint,
    runId,
    actionId: null,
    writerEpoch,
    runRevision,
    actionIds: [],
    creates: [],
    updates: [],
    sides: [],
  }
}

function loadQuota(ports: ControlPorts, runId: string): { head?: StoredHead; value?: RunQuotaValue } {
  const head = ports.loadHead(runQuotaRecordId(runId))
  return head ? { head, value: storedValue<RunQuotaValue>(head) } : {}
}

type SignalRecordValue = {
  signal: Signal
  targetRevisionAtCreation: number
  consumedByCommitId: string | null
  sourceReceiptId: string
}

type StoredReceiptValue = {
  receipt: Receipt
  evidenceRefs: readonly DataRef[]
  acceptedBy: string
  acceptedAt: string
  intakeId?: string | null
  contentFingerprint?: string | null
}

type StoredOutbox = OutboxRecord & { sessionId: string; sourceReceiptId: string }

type DeliveryRow = {
  event_id: string
  session_id: string
  destination: string
  claim_epoch: number
  active_owner: string | null
  active_epoch: number | null
  active_until: number | null
  acked_epoch: number | null
  attempts: number
  next_attempt_at: number
  delivery: OutboxRecord['delivery']
  ack_ref: string | null
  error_json: string | null
  last_owner: string | null
}

type RecordUpdate = { record: StoredRecord; previousRevision: number }

type QueryDelta = {
  grantHead: StoredHead
  prepareHead: StoredHead
  grant: GrantValue
  prepare: PrepareValue
  delta: number
}

const inlineSchemaDocument = { $id: 'agh.runtime/json-value@1', type: 'object' }
const inlineSchema: SchemaRef = {
  typeId: 'agh.runtime/json-value@1',
  revision: 1,
  digest: digestOf(inlineSchemaDocument),
}

function dataRef(value: unknown): DataRef {
  return {
    kind: 'inline',
    schema: inlineSchema,
    value: value as Extract<DataRef, { kind: 'inline' }>['value'],
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonicalJson(value)),
  }
}

function intakeFingerprint(request: ReceiptIntakeRequest): string {
  return digestOf({
    receipt: request.receipt,
    usage: request.usage,
    evidence: request.evidence,
    queryUsage: request.queryUsage,
    resultHandling: request.resultHandling,
  })
}

function assertNoHookHandling(kind: ReceiptIntakeRequest['resultHandling']['kind']): void {
  if (kind === 'inline-pure') refuse('internal', 'unsupported', INLINE_PURE_RESULT)
  if (kind === 'staged') refuse('internal', 'unsupported', STAGED_RESULT)
  if (kind !== 'no-hook') refuse('invalid_input', 'result_handling', 'result handling is not supported')
}

function resultView(receipt: Receipt): ActionResultView {
  const view: ActionResultView = {
    receiptId: receipt.receiptId,
    actionId: receipt.actionId,
    attemptId: receipt.attemptId,
    bindingId: receipt.bindingId,
    inputDigest: receipt.inputDigest,
    outcome: receipt.outcome,
    externalRequests: [...receipt.externalRequests],
    usageRefs: [...receipt.usageRefs],
    references: [...receipt.references],
    provenance: receipt.provenance,
    completedAt: receipt.completedAt,
    visibility: 'ready',
    viewId: stableId('view', `${receipt.receiptId}\0`),
    sourceReceiptId: receipt.receiptId,
    hookResultSetRef: null,
  }
  if (receipt.result !== undefined) view.result = receipt.result
  if (receipt.error !== undefined) view.error = receipt.error
  return view
}

function nextSignalSeq(ports: ControlPorts, runId: string, targetActionId: string | null): number {
  let max = 0
  const rows = ports.all<{ value_json: string }>(
    `SELECT value_json FROM runtime_records WHERE record_id LIKE 'signal:%'`,
  )
  for (const row of rows) {
    const value = parseJson(row.value_json) as {
      signal?: { runId?: string; targetActionId?: string | null; seq?: number }
    }
    if (value.signal?.runId !== runId || (value.signal.targetActionId ?? null) !== targetActionId) continue
    if (typeof value.signal.seq === 'number' && value.signal.seq > max) max = value.signal.seq
  }
  return max + 1
}

function insertOutboxDelivery(
  ports: ControlPorts,
  sessionId: string,
  eventId: string,
  destination: string,
  nextAttemptAt: number,
): void {
  ports.run(
    `INSERT INTO runtime_outbox_delivery (
       event_id, session_id, destination, claim_epoch, active_owner, active_epoch, active_until,
       acked_epoch, attempts, next_attempt_at, delivery, ack_ref, error_json, last_owner
     ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, 0, ?, 'pending', NULL, NULL, NULL)`,
    eventId,
    sessionId,
    destination,
    nextAttemptAt,
  )
}

function outboxValue(
  ports: ControlPorts,
  sessionId: string,
  commitId: string,
  receiptId: string,
  eventId: string,
  destination: string,
  typeId: string,
  payloadValue: unknown,
  stamp: string,
): StoredOutbox {
  return {
    eventId,
    sourceAuthorityId: ports.authority.authorityId,
    sourceCommitId: commitId,
    destination,
    typeId,
    payload: dataRef(payloadValue),
    fingerprint: digestOf(payloadValue),
    delivery: 'pending',
    attempts: 0,
    nextAttemptAt: stamp,
    claim: null,
    ackRef: null,
    sessionId,
    sourceReceiptId: receiptId,
  }
}

function releaseHeldMirrors(
  ports: ControlPorts,
  runId: string,
  actionId: string,
  stamp: string,
): RecordUpdate[] {
  const actionKey = actionRecordId(actionId)
  const rows = ports.all<{ record_id: string }>(
    `SELECT record_id FROM runtime_records WHERE record_id LIKE 'quota:%'`,
  )
  const updates: RecordUpdate[] = []
  const released: string[] = []
  for (const row of rows) {
    const head = ports.loadHead(row.record_id)
    if (!head) continue
    const value = storedValue<Record<string, unknown>>(head)
    const source = value.source
    const sourceId =
      source !== null && typeof source === 'object' && !Array.isArray(source)
        ? (source as { recordId?: unknown }).recordId
        : undefined
    if (value.kind !== 'parallel-action' || value.status !== 'held' || sourceId !== actionKey) continue
    if (typeof value.reservationId === 'string') released.push(value.reservationId)
    updates.push(
      updated(head, QUOTA_MIRROR_SCHEMA, ownerOf(head), { ...value, status: 'released', releasedAt: stamp }),
    )
  }
  if (released.length === 0) return updates
  const quotaHead = requireHead(ports, runQuotaRecordId(runId), 'quota_absent', 'run quota record is missing')
  const quota = storedValue<RunQuotaValue>(quotaHead)
  const dropping = new Set(released)
  updates.push(
    updated(quotaHead, RUN_QUOTA_SCHEMA, ownerOf(quotaHead), {
      ...quota,
      activeQuotaReservationRefs: quota.activeQuotaReservationRefs.filter((id) => !dropping.has(id)),
    }),
  )
  return updates
}

function publishNoHook(
  ports: ControlPorts,
  input: {
    commitId: string
    stamp: string
    sessionId: string
    owner: RecordOwner
    run: RunRecordValue
    action: ActionValue
    attempt: AttemptValue
    receipt: Receipt
    usage: readonly UsageFact[]
    evidence: readonly DataRef[]
    acceptedBy: string
    intakeId: string | null
    contentFingerprint: string | null
    actionHead?: StoredHead
    attemptHead?: StoredHead
    includeReceipt: boolean
  },
): { creates: StoredRecord[]; updates: RecordUpdate[]; sides: CommitSideEntry[] } {
  const creates: StoredRecord[] = []
  const updates: RecordUpdate[] = []
  const sides: CommitSideEntry[] = []
  const { commitId, stamp, owner, receipt } = input
  if (input.includeReceipt) {
    creates.push(
      record(receiptRecordId(receipt.receiptId), RECEIPT_SCHEMA, 1, owner, {
        receipt,
        evidenceRefs: input.evidence,
        acceptedBy: input.acceptedBy,
        acceptedAt: stamp,
        intakeId: input.intakeId,
        contentFingerprint: input.contentFingerprint,
      } satisfies StoredReceiptValue),
    )
    sides.push({ commitId, kind: 'receipt-created', receiptId: receipt.receiptId })
  }
  if (input.actionHead) {
    updates.push(
      updated(input.actionHead, ACTION_SCHEMA, ownerOf(input.actionHead), {
        ...input.action,
        state: 'settled',
        firstReceiptId: input.action.firstReceiptId ?? receipt.receiptId,
        resolvedReceiptId: receipt.receiptId,
      }),
    )
  }
  if (input.attemptHead) {
    updates.push(
      updated(input.attemptHead, ATTEMPT_SCHEMA, ownerOf(input.attemptHead), {
        ...input.attempt,
        state: 'settled',
        finishedAt: stamp,
        receiptIds: input.attempt.receiptIds.includes(receipt.receiptId)
          ? input.attempt.receiptIds
          : [...input.attempt.receiptIds, receipt.receiptId],
      }),
    )
  }
  updates.push(...releaseHeldMirrors(ports, input.run.runId, input.action.actionId, stamp))
  const seenOrigins = new Set<string>()
  for (const fact of input.usage) {
    const identity = `${ports.authority.authorityId}\0${fact.originKey}`
    if (seenOrigins.has(identity)) continue
    seenOrigins.add(identity)
    const usageId = stableId('use', identity)
    if (ports.loadHead(usageMirrorRecordId(usageId))) continue
    creates.push(
      record(usageMirrorRecordId(usageId), USAGE_MIRROR_SCHEMA, 1, owner, {
        usageId,
        sourceAuthorityId: ports.authority.authorityId,
        originKey: fact.originKey,
        usage: fact,
        status: 'recorded',
      }),
    )
    sides.push({
      commitId,
      kind: 'usage-origin',
      sourceAuthorityId: ports.authority.authorityId,
      originKey: fact.originKey,
    })
  }
  for (const pin of receipt.references) {
    const referenceId = stableId('ref', `${receipt.receiptId}\0${pin.pinId}`)
    creates.push(
      record(referenceRecordId(referenceId), REFERENCE_SCHEMA, 1, owner, {
        referenceId,
        status: 'confirmed',
        target: pin,
      }),
    )
  }
  const targetActionId = input.action.parentActionId
  const signalKey =
    targetActionId === null
      ? `${ports.authority.authorityId}\0${receipt.receiptId}\0run`
      : `${ports.authority.authorityId}\0${receipt.receiptId}\0${targetActionId}`
  const signalId = stableId('sig', signalKey)
  const source: BindingRef = receipt.provenance.producer
  const signal: Signal = {
    signalId,
    runId: input.run.runId,
    targetActionId,
    seq: nextSignalSeq(ports, input.run.runId, targetActionId),
    typeId: COMPLETED_SIGNAL_TYPE,
    schema: inlineSchema,
    source,
    payload: dataRef({ receiptId: receipt.receiptId, outcome: receipt.outcome }),
    createdAt: stamp,
    causation: { actionId: input.action.actionId, attemptId: input.attempt.attemptId },
  }
  creates.push(
    record(signalRecordId(signalId), SIGNAL_SCHEMA, 1, owner, {
      signal,
      targetRevisionAtCreation: input.run.revision,
      consumedByCommitId: null,
      sourceReceiptId: receipt.receiptId,
    } satisfies SignalRecordValue),
  )
  const view = resultView(receipt)
  creates.push(
    record(visibilityRecordId(receipt.receiptId), VISIBILITY_SCHEMA, 1, owner, {
      actionId: input.action.actionId,
      sourceReceiptId: receipt.receiptId,
      revision: 1,
      state: 'ready',
      stageActionId: null,
      registrationDigest: null,
      result: view,
      uiResult: null,
      publishedByCommitId: commitId,
    } satisfies ActionVisibilityValue),
  )
  const destination = stableId('obxdst', ports.authority.authorityId)
  const nowMs = Date.parse(stamp)
  const pushOutbox = (eventId: string, typeId: string, payloadValue: unknown) => {
    creates.push(
      record(
        outboxRecordId(eventId),
        OUTBOX_SCHEMA,
        1,
        owner,
        outboxValue(
          ports,
          input.sessionId,
          commitId,
          receipt.receiptId,
          eventId,
          destination,
          typeId,
          payloadValue,
          stamp,
        ),
      ),
    )
    sides.push({ commitId, kind: 'outbox-created', eventId })
    insertOutboxDelivery(ports, input.sessionId, eventId, destination, nowMs)
  }
  pushOutbox(stableId('obx', `${commitId}\0result\0${receipt.receiptId}`), RESULT_TYPE, {
    receiptId: receipt.receiptId,
    actionId: receipt.actionId,
    attemptId: receipt.attemptId,
    outcome: receipt.outcome,
    viewId: view.viewId,
  })
  for (const streamId of input.attempt.streamIds) {
    pushOutbox(
      stableId('obx', `${commitId}\0stream-end\0${receipt.receiptId}\0${streamId}`),
      STREAM_END_TYPE,
      {
        streamId,
        receiptId: receipt.receiptId,
        status: receipt.outcome,
      },
    )
  }
  return { creates, updates, sides }
}

function planQueryFlush(
  ports: ControlPorts,
  invocation: InvocationValue,
  usage: QueryUsageFlush,
): QueryDelta | undefined {
  if (usage.invocationId !== invocation.invocationId || usage.grantId !== invocation.queryGrantId)
    refuse('invalid_input', 'grant_absent', 'query grant does not match the invocation')
  if (usage.writerEpoch !== invocation.writerEpoch)
    refuse('conflict', 'writer_lease', 'query usage writer epoch does not match')
  const grantHead = requireHead(
    ports,
    grantRecordId(invocation.queryGrantId),
    'grant_absent',
    'query grant does not match the invocation',
  )
  const grant = storedValue<GrantValue>(grantHead)
  if (grant.state === 'settled') {
    if (usage.cumulativeCount !== grant.settledCount)
      refuse('conflict', 'query_count', 'query count does not match the settled grant')
    return undefined
  }
  const meter = ports.queryMeter(grant.grantId)
  if (!meter) refuse('conflict', 'query_owner', 'query meter is not available for this grant')
  if (usage.cumulativeCount !== meter.observed)
    refuse('invalid_input', 'query_count', 'query count does not match the query meter')
  if (usage.cumulativeCount < grant.flushedCount || usage.cumulativeCount > grant.capacity)
    refuse('conflict', 'query_count', 'query count is outside the grant')
  const delta = usage.cumulativeCount - grant.flushedCount
  if (delta === 0) return undefined
  const prepareHead = requireHead(
    ports,
    prepareRecordId(invocation.prepareId),
    'prepare_absent',
    'prepare quota record is missing',
  )
  const prepare = storedValue<PrepareValue>(prepareHead)
  return {
    grantHead,
    prepareHead,
    grant: { ...grant, flushedCount: usage.cumulativeCount },
    prepare: {
      ...prepare,
      totalQueries: prepare.totalQueries + delta,
      reservedQueries: prepare.reservedQueries - delta,
    },
    delta,
  }
}

function applyQueryDelta(quota: RunQuotaValue, delta: number): RunQuotaValue {
  return {
    ...quota,
    totalQueries: quota.totalQueries + delta,
    reservedQueries: quota.reservedQueries - delta,
  }
}

function consumeSignals(
  ports: ControlPorts,
  runId: string,
  signalIds: readonly string[],
  commitId: string,
): { updates: RecordUpdate[]; sides: CommitSideEntry[] } {
  const updates: RecordUpdate[] = []
  const sides: CommitSideEntry[] = []
  for (const signalId of signalIds) {
    const head = ports.loadHead(signalRecordId(signalId))
    if (!head) refuse('conflict', 'signal_absent', 'signal does not exist')
    const value = storedValue<SignalRecordValue>(head)
    if (value.signal.runId !== runId) refuse('conflict', 'signal_absent', 'signal does not exist')
    if (value.consumedByCommitId !== null)
      refuse('conflict', 'signal_consumed', 'signal was already consumed')
    updates.push(
      updated(head, SIGNAL_SCHEMA, ownerOf(head), {
        ...value,
        consumedByCommitId: commitId,
      } satisfies SignalRecordValue),
    )
    sides.push({ commitId, kind: 'signal-consumed', signalId })
  }
  return { updates, sides }
}

function claimIsCurrent(
  row: DeliveryRow,
  claim: OutboxClaim,
  now: number,
  requireUnexpired: boolean,
): boolean {
  if (row.delivery !== 'claimed' || row.event_id !== claim.eventId) return false
  if (row.active_owner !== claim.ownerId || row.active_epoch !== claim.epoch || row.active_until === null)
    return false
  if (new Date(row.active_until).toISOString() !== claim.until) return false
  if (requireUnexpired && row.active_until <= now) return false
  return true
}

function assembleOutbox(stored: StoredOutbox, row: DeliveryRow): OutboxRecord {
  const claim =
    row.delivery === 'claimed' &&
    row.active_owner !== null &&
    row.active_epoch !== null &&
    row.active_until !== null
      ? {
          ownerId: row.active_owner,
          epoch: row.active_epoch,
          until: new Date(row.active_until).toISOString(),
        }
      : null
  return {
    eventId: stored.eventId,
    sourceAuthorityId: stored.sourceAuthorityId,
    sourceCommitId: stored.sourceCommitId,
    destination: stored.destination,
    typeId: stored.typeId,
    payload: stored.payload,
    fingerprint: stored.fingerprint,
    delivery: row.delivery,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    claim,
    ackRef: row.ack_ref,
  }
}

const DELIVERY_COLUMNS = `event_id, session_id, destination, claim_epoch, active_owner, active_epoch, active_until,
  acked_epoch, attempts, next_attempt_at, delivery, ack_ref, error_json, last_owner`

function loadDelivery(ports: ControlPorts, eventId: string): DeliveryRow | undefined {
  return ports.get<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM runtime_outbox_delivery WHERE event_id = ?`,
    eventId,
  )
}

function anySessionId(ports: ControlPorts): string {
  const row = ports.get<{ session_id: string }>('SELECT session_id FROM runtime_session_meta LIMIT 1')
  if (!row) refuse('invalid_input', 'session_absent', 'session does not exist')
  return row.session_id
}

export async function admitInvocationTx(
  ports: ControlPorts,
  request: InvocationAdmission,
): Promise<Committed<AdmitInvocationResult>> {
  const loaded = loadRun(ports, request.runId)
  const verified = await ports.requireSession(loaded.value.sessionId)
  const fingerprint = digestOf(request)
  const replayed = replayWrapped<AdmitInvocationResult>(
    ports,
    loaded.value.sessionId,
    'admitInvocation',
    request.requestId,
    fingerprint,
  )
  if (replayed) return { result: replayed, sessionId: loaded.value.sessionId }
  assertLiveEpoch(ports, loaded.value.sessionId, request.writerEpoch)
  if (request.bindingId !== loaded.value.bindingId)
    refuse('conflict', 'binding', 'binding does not match the run')
  if (request.baseRevision !== loaded.value.revision)
    refuse('conflict', 'revision', 'invocation base revision does not match the run')
  if (ports.loadHead(invocationRecordId(request.invocationId)))
    refuse('conflict', 'invocation_exists', 'invocation already exists')
  const active = ports.all<{ value_json: string }>(
    `SELECT value_json FROM runtime_records WHERE record_id LIKE 'invocation:%'`,
  )
  for (const row of active) {
    const value = parseJson(row.value_json) as { runId?: string; state?: string }
    if (value.runId === request.runId && value.state === 'active')
      refuse('conflict', 'invocation_state', 'an invocation is already active')
  }
  const existing = loadQuota(ports, request.runId)
  const totalQueries = existing.value?.totalQueries ?? 0
  const reservedQueries = existing.value?.reservedQueries ?? 0
  const starts = (existing.value?.invocationStarts ?? 0) + 1
  if (starts > MAX_INVOCATION_STARTS) refuse('conflict', 'quota', 'invocation start quota is exhausted')
  const room = MAX_QUERIES_PER_RUN - totalQueries - reservedQueries
  if (room < 0) refuse('conflict', 'quota', 'query quota is exhausted')
  const capacity = Math.min(request.queryAllowance, MAX_QUERIES_PER_INVOCATION, room)
  if (request.queryAllowance > 0 && capacity === 0) refuse('conflict', 'quota', 'query quota is exhausted')
  const prepareId = stableId('prep', `${request.runId}\0${request.invocationId}`)
  const grantId = stableId('qg', request.invocationId)
  const stamp = at(ports)
  const quota: RunQuotaValue = existing.value
    ? {
        ...existing.value,
        reservedQueries: existing.value.reservedQueries + capacity,
        invocationStarts: starts,
      }
    : {
        runId: request.runId,
        limitPolicyRef: LIMIT_POLICY,
        totalTransitions: 0,
        noProgressTransitions: 0,
        lastProgressRef: null,
        submittedActions: 0,
        totalQueries: 0,
        reservedQueries: capacity,
        invocationStarts: 1,
        failedInvocations: 0,
        activeQuotaReservationRefs: [],
      }
  const invocation: InvocationValue = {
    invocationId: request.invocationId,
    prepareId,
    runId: request.runId,
    targetActionId: request.targetActionId,
    baseRevision: request.baseRevision,
    bindingId: request.bindingId,
    writerEpoch: request.writerEpoch,
    state: 'active',
    queryGrantId: grantId,
    queryCount: 0,
    readGuards: [],
    domainReads: [],
    startedAt: stamp,
    deadline: request.deadline,
    closedAt: null,
    inflightIds: [],
  }
  const prepare: PrepareValue = {
    prepareId,
    runId: request.runId,
    targetActionId: request.targetActionId,
    baseRevision: request.baseRevision,
    totalQueries: 0,
    reservedQueries: capacity,
    closed: false,
  }
  const grant: GrantValue = {
    grantId,
    invocationId: request.invocationId,
    prepareId,
    runId: request.runId,
    writerEpoch: request.writerEpoch,
    capacity,
    flushedCount: 0,
    state: 'active',
    settledCount: null,
  }
  const result: AdmitInvocationResult = {
    prepareId,
    invocationId: request.invocationId,
    queryGrantId: grantId,
    grantedQueries: capacity,
    remainingQueries: MAX_QUERIES_PER_RUN - quota.totalQueries - quota.reservedQueries,
  }
  const creates = [
    record(invocationRecordId(request.invocationId), INVOCATION_SCHEMA, 1, loaded.owner, invocation),
    record(prepareRecordId(prepareId), PREPARE_QUOTA_SCHEMA, 1, loaded.owner, prepare),
    record(grantRecordId(grantId), QUERY_GRANT_SCHEMA, 1, loaded.owner, grant),
  ]
  const updates = []
  if (existing.head) updates.push(updated(existing.head, RUN_QUOTA_SCHEMA, ownerOf(existing.head), quota))
  else creates.push(record(runQuotaRecordId(request.runId), RUN_QUOTA_SCHEMA, 1, loaded.owner, quota))
  ports.openQueryMeter(grantId, capacity)
  return rememberWrapped(
    ports,
    {
      ...blankInput(
        loaded.value.sessionId,
        verified,
        ports.ulid(),
        stamp,
        fingerprint,
        request.runId,
        request.writerEpoch,
        loaded.value.revision,
      ),
      creates,
      updates,
    },
    'admitInvocation',
    request.requestId,
    fingerprint,
    result,
  )
}

export async function closeInvocationTx(
  ports: ControlPorts,
  request: CloseInvocationRequest,
): Promise<Committed<CloseInvocationResult>> {
  const invocationHead = ports.loadHead(invocationRecordId(request.invocationId))
  if (!invocationHead) refuse('invalid_input', 'invocation_absent', 'invocation does not exist')
  const invocation = storedValue<InvocationValue>(invocationHead)
  const loaded = loadRun(ports, invocation.runId)
  const verified = await ports.requireSession(loaded.value.sessionId)
  const fingerprint = digestOf(request)
  const replayed = replayWrapped<CloseInvocationResult>(
    ports,
    loaded.value.sessionId,
    'closeInvocation',
    request.requestId,
    fingerprint,
  )
  if (replayed) return { result: replayed, sessionId: loaded.value.sessionId }
  assertLiveEpoch(ports, loaded.value.sessionId, invocation.writerEpoch)
  if (invocation.state !== 'active') refuse('conflict', 'invocation_state', 'invocation is not active')
  assertReadGuards(ports, request.readGuards)
  const prepareHead = requireHead(
    ports,
    prepareRecordId(invocation.prepareId),
    'prepare_absent',
    'prepare quota record is missing',
  )
  const grantHead = requireHead(
    ports,
    grantRecordId(invocation.queryGrantId),
    'grant_absent',
    'query grant record is missing',
  )
  const quotaHead = requireHead(
    ports,
    runQuotaRecordId(invocation.runId),
    'quota_absent',
    'run quota record is missing',
  )
  const prepare = storedValue<PrepareValue>(prepareHead)
  const grant = storedValue<GrantValue>(grantHead)
  const quota = storedValue<RunQuotaValue>(quotaHead)
  const meter = ports.queryMeter(grant.grantId)
  const worst = meter === undefined || request.unresolvedInflightIds.length > 0 || request.state === 'faulted'
  if (meter && request.observedQueryCount !== meter.observed)
    refuse('invalid_input', 'query_count', 'observed query count does not match the query meter')
  const settledCount = worst ? grant.capacity : request.observedQueryCount
  if (settledCount < grant.flushedCount || settledCount > grant.capacity)
    refuse('conflict', 'query_count', 'observed query count is outside the grant')
  const delta = settledCount - grant.flushedCount
  const unused = worst ? 0 : grant.capacity - settledCount
  const resulting = worst ? 'faulted' : request.state
  const failed = quota.failedInvocations + (resulting === 'faulted' ? 1 : 0)
  if (failed > MAX_FAILED_INVOCATIONS) refuse('conflict', 'quota', 'failed invocation quota is exhausted')
  if (quota.reservedQueries < delta + unused) integrity('query reservation is larger than the run reserve')
  const stamp = at(ports)
  const result: CloseInvocationResult = { invocationId: request.invocationId, state: resulting }
  return rememberWrapped(
    ports,
    {
      ...blankInput(
        loaded.value.sessionId,
        verified,
        ports.ulid(),
        stamp,
        fingerprint,
        invocation.runId,
        invocation.writerEpoch,
        loaded.value.revision,
      ),
      updates: [
        updated(invocationHead, INVOCATION_SCHEMA, ownerOf(invocationHead), {
          ...invocation,
          state: resulting,
          queryCount: settledCount,
          readGuards: request.readGuards,
          domainReads: request.domainReads,
          closedAt: stamp,
          inflightIds: request.unresolvedInflightIds,
        }),
        updated(prepareHead, PREPARE_QUOTA_SCHEMA, ownerOf(prepareHead), {
          ...prepare,
          totalQueries: prepare.totalQueries + delta,
          reservedQueries: prepare.reservedQueries - delta - unused,
        }),
        updated(grantHead, QUERY_GRANT_SCHEMA, ownerOf(grantHead), {
          ...grant,
          flushedCount: settledCount,
          state: 'settled',
          settledCount,
        }),
        updated(quotaHead, RUN_QUOTA_SCHEMA, ownerOf(quotaHead), {
          ...quota,
          totalQueries: quota.totalQueries + delta,
          reservedQueries: quota.reservedQueries - delta - unused,
          failedInvocations: failed,
        }),
      ],
    },
    'closeInvocation',
    request.requestId,
    fingerprint,
    result,
  )
}

function assertTransition(request: AdvanceRunRequest): void {
  const transition = request.transition
  const seenSignals = new Set<string>()
  for (const signalId of transition.consumeSignals) {
    if (seenSignals.has(signalId))
      refuse('invalid_input', 'signal_duplicate', 'signal is listed more than once')
    seenSignals.add(signalId)
  }
  if (transition.conversation !== undefined && transition.conversation.length > 0)
    refuse('internal', 'unsupported', CONVERSATION_CONTRIBUTION)
  if (transition.next.kind !== 'continue') refuse('internal', 'unsupported', OTHER_TRANSITION)
  if (transition.actions.length > MAX_ACTIONS)
    refuse('invalid_input', 'action_count', 'a transition has too many actions')
  if (Buffer.byteLength(canonicalJson(transition.continuation)) > MAX_CONTINUATION_BYTES)
    refuse('invalid_input', 'continuation', 'continuation is too large')
}

function assertGuard(ports: ControlPorts, guard: CommitGuard, mode: 'advance' | 'follow') {
  if (!sameJson(guard.authority, ports.authority))
    refuse('conflict', 'authority', 'authority does not match this store')
  assertWriter(ports, guard.sessionId, guard.writerId, guard.writerEpoch)
  const loaded = loadRun(ports, guard.runId)
  if (loaded.value.sessionId !== guard.sessionId) refuse('conflict', 'session', 'run session does not match')
  if (loaded.value.bindingId !== guard.bindingId)
    refuse('conflict', 'binding', 'binding does not match the run')
  if (loaded.value.revision !== guard.expectedRunRevision)
    refuse('conflict', 'revision', 'run revision does not match')
  const invocationHead = requireHead(
    ports,
    invocationRecordId(guard.invocationId),
    'invocation_absent',
    'invocation does not exist',
  )
  const invocation = storedValue<InvocationValue>(invocationHead)
  const ready =
    mode === 'advance'
      ? invocation.state === 'prepared'
      : invocation.state === 'prepared' || invocation.state === 'committed'
  if (
    !ready ||
    invocation.runId !== guard.runId ||
    invocation.bindingId !== guard.bindingId ||
    invocation.writerEpoch !== guard.writerEpoch
  )
    refuse('conflict', 'invocation_state', 'invocation is not ready for this commit')
  if (mode === 'advance' && !sameJson(guard.readGuards, invocation.readGuards))
    refuse('conflict', 'read_guard', 'read guard does not match the invocation')
  assertReadGuards(ports, guard.readGuards)
  return { ...loaded, invocationHead, invocation }
}

export async function advanceRunTx(
  ports: ControlPorts,
  request: AdvanceRunRequest,
): Promise<Committed<StateCommitReceipt>> {
  const verified = await ports.requireSession(request.guard.sessionId)
  const fingerprint = digestOf({ guard: request.guard, transition: request.transition })
  const stored = ports.replayRequest<StateCommitReceipt>('advanceRun', request.commitId, fingerprint)
  if (stored) {
    ports.assertReceipt(request.guard.sessionId, stored, fingerprint)
    return { result: stored, sessionId: request.guard.sessionId }
  }
  assertTransition(request)
  const guarded = assertGuard(ports, request.guard, 'advance')
  const flushed = request.guard.queryUsage
    ? planQueryFlush(ports, guarded.invocation, request.guard.queryUsage)
    : undefined
  const consumed = consumeSignals(
    ports,
    request.guard.runId,
    request.transition.consumeSignals,
    request.commitId,
  )
  if (request.transition.expectedRevision !== guarded.value.revision)
    refuse('conflict', 'revision', 'run revision does not match')
  const planned: { key: string; actionId: string; create?: StoredRecord }[] = []
  let created = 0
  for (const action of request.transition.actions) {
    const fingerprintOfAction = actionFingerprint(action)
    const actionId = stableId('act', `${request.guard.runId}\0${action.key}`)
    const existing = ports.loadHead(actionRecordId(actionId))
    if (existing) {
      const value = storedValue<ActionValue>(existing)
      if (value.intentFingerprint !== fingerprintOfAction)
        refuse('conflict', 'intent_fingerprint', 'action intent fingerprint does not match')
      planned.push({ key: action.key, actionId })
      continue
    }
    created += 1
    const snapshot = taintOf(ports, request.guard.runId)
    const value: ActionValue = {
      actionId,
      runId: request.guard.runId,
      parentActionId: null,
      key: action.key,
      intent: action,
      intentFingerprint: fingerprintOfAction,
      state: 'prepared',
      currentAttemptId: null,
      providerStateId: null,
      firstReceiptId: null,
      resolvedReceiptId: null,
      resolutionId: null,
      ownerRef: { kind: 'run', id: request.guard.runId },
      createdByCommitId: request.commitId,
      resultHookPlan: null,
      taintSnapshot: snapshot,
      authorizationTaintSnapshot: null,
    }
    planned.push({
      key: action.key,
      actionId,
      create: record(actionRecordId(actionId), ACTION_SCHEMA, 1, guarded.owner, value),
    })
  }
  const quotaHead = requireHead(
    ports,
    runQuotaRecordId(request.guard.runId),
    'quota_absent',
    'run quota record is missing',
  )
  const quota = storedValue<RunQuotaValue>(quotaHead)
  const progressed = created > 0 || request.transition.consumeSignals.length > 0
  const noProgress = progressed ? 0 : quota.noProgressTransitions + 1
  if (noProgress > MAX_NO_PROGRESS || quota.totalTransitions + 1 > MAX_TRANSITIONS)
    refuse('conflict', 'quota', 'run transition quota is exhausted')
  const prepareHead = requireHead(
    ports,
    prepareRecordId(guarded.invocation.prepareId),
    'prepare_absent',
    'prepare quota record is missing',
  )
  const prepare = storedValue<PrepareValue>(prepareHead)
  const lastCreated = planned.filter((item) => item.create).at(-1)
  const actionIds = planned.map((item) => ({ key: item.key, actionId: item.actionId }))
  const quotaNext = {
    ...quota,
    totalTransitions: quota.totalTransitions + 1,
    noProgressTransitions: noProgress,
    submittedActions: quota.submittedActions + created,
    lastProgressRef: lastCreated?.actionId ?? quota.lastProgressRef,
  }
  const stamp = at(ports)
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      request.commitId,
      stamp,
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      guarded.value.revision + 1,
    ),
    actionId: actionIds.length === 1 ? (actionIds[0]?.actionId ?? null) : null,
    actionIds,
    creates: planned.flatMap((item) => (item.create ? [item.create] : [])),
    updates: [
      updated(guarded.head, RUN_RECORD_SCHEMA, guarded.owner, {
        ...guarded.value,
        continuation: request.transition.continuation,
        revision: guarded.value.revision + 1,
        writerEpoch: request.guard.writerEpoch,
      }),
      updated(guarded.invocationHead, INVOCATION_SCHEMA, ownerOf(guarded.invocationHead), {
        ...guarded.invocation,
        state: 'committed',
      }),
      updated(
        flushed ? flushed.prepareHead : prepareHead,
        PREPARE_QUOTA_SCHEMA,
        ownerOf(flushed ? flushed.prepareHead : prepareHead),
        flushed ? { ...flushed.prepare, closed: true } : { ...prepare, closed: true },
      ),
      updated(
        quotaHead,
        RUN_QUOTA_SCHEMA,
        ownerOf(quotaHead),
        flushed ? applyQueryDelta(quotaNext, flushed.delta) : quotaNext,
      ),
      ...(flushed
        ? [updated(flushed.grantHead, QUERY_GRANT_SCHEMA, ownerOf(flushed.grantHead), flushed.grant)]
        : []),
      ...consumed.updates,
    ],
    sides: [
      ...planned.flatMap((item) =>
        item.create
          ? [{ commitId: request.commitId, kind: 'action-created' as const, actionId: item.actionId }]
          : [],
      ),
      ...consumed.sides,
    ],
  })
  ports.rememberRequest('advanceRun', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}

function assertDispatchShape(request: DispatchAdmissionRequest): void {
  if (request.budget.reservation !== null) refuse('internal', 'unsupported', BUDGET_RESERVATION)
  if (request.budget.quota.some((item) => item.name === 'live-agent'))
    refuse('internal', 'unsupported', LIVE_AGENT_QUOTA)
  if ((request.hookResults?.length ?? 0) > 0 || request.approvalTaintAck != null)
    refuse('internal', 'unsupported', HOOK_RESULTS)
}

function parallelAmount(request: DispatchAdmissionRequest): number {
  let requested = 0
  for (const item of request.budget.quota) {
    if (item.name !== 'parallel-action') continue
    if (!Number.isSafeInteger(item.amount) || item.amount <= 0)
      refuse('invalid_input', 'quota_amount', 'parallel action quota amount must be positive')
    requested += item.amount
  }
  return requested
}

function heldParallel(ports: ControlPorts, runId: string): number {
  const rows = ports.all<{ value_json: string }>(
    `SELECT value_json FROM runtime_records WHERE record_id LIKE 'quota:%'`,
  )
  let held = 0
  for (const row of rows) {
    const value = parseJson(row.value_json) as {
      kind?: string
      status?: string
      quantity?: number
      scopeIds?: string[]
    }
    if (value.kind !== 'parallel-action' || value.status !== 'held' || !value.scopeIds?.includes(runId))
      continue
    held += value.quantity ?? 0
  }
  return held
}

function loadPinnedDomain(ports: ControlPorts, sessionId: string): unknown | undefined {
  const row = ports.get<{ domain_json: string }>(
    'SELECT domain_json FROM runtime_dispatch_domains WHERE session_id = ?',
    sessionId,
  )
  return row ? parseJson(row.domain_json) : undefined
}

function assertDomain(
  ports: ControlPorts,
  request: DispatchAdmissionRequest,
  bindingId: string,
  pinned: unknown | undefined,
): void {
  const domain = request.atomicDomain
  if (!sameJson(domain.stateAuthority, ports.authority) || !sameJson(domain.budgetAuthority, ports.authority))
    refuse('conflict', 'authority', 'authority does not match this store')
  if (
    domain.stateBinding.bindingId !== bindingId ||
    domain.budgetBinding.bindingId !== bindingId ||
    (pinned !== undefined && !sameJson(pinned, domain))
  )
    refuse('conflict', 'domain', 'dispatch domain does not match the pinned domain')
}

function pinDomain(ports: ControlPorts, sessionId: string, domain: unknown): void {
  ports.run(
    'INSERT INTO runtime_dispatch_domains (session_id, domain_json) VALUES (?, ?)',
    sessionId,
    canonicalJson(domain),
  )
}

function rejectionError(
  ports: ControlPorts,
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
): RuntimeError {
  return {
    code,
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: ports.ulid(),
  }
}

type DispatchDecision =
  | { kind: 'admit' }
  | { kind: 'reject'; reason: RejectReason; outcome: 'failed' | 'cancelled'; error: RuntimeError }

function decideDispatch(
  ports: ControlPorts,
  request: DispatchAdmissionRequest,
  run: RunRecordValue,
  requested: number,
): DispatchDecision {
  if (Date.parse(request.deadline) <= ports.now()) {
    return {
      kind: 'reject',
      reason: 'expired',
      outcome: 'failed',
      error: rejectionError(ports, 'timeout', 'expired', 'dispatch deadline has passed'),
    }
  }
  if (run.cancellation != null) {
    return {
      kind: 'reject',
      reason: 'cancelled',
      outcome: 'cancelled',
      error: rejectionError(ports, 'cancelled', 'cancelled', 'run is cancelled'),
    }
  }
  if (requested > 0 && heldParallel(ports, request.guard.runId) + requested > MAX_PARALLEL_ACTIONS) {
    return {
      kind: 'reject',
      reason: 'quota',
      outcome: 'failed',
      error: rejectionError(ports, 'quota', 'quota', 'parallel action quota is exhausted'),
    }
  }
  return { kind: 'admit' }
}

export async function dispatchAdmissionTx(
  ports: ControlPorts,
  request: DispatchAdmissionRequest,
): Promise<Committed<DispatchAdmissionResult>> {
  const verified = await ports.requireSession(request.guard.sessionId)
  const fingerprint = digestOf(request)
  const stored = ports.replayRequest<RememberedDispatch>(
    'dispatchAdmission',
    request.admissionId,
    fingerprint,
  )
  if (stored) {
    ports.assertReceipt(request.guard.sessionId, stored.receipt, fingerprint)
    return { result: stored.result, sessionId: request.guard.sessionId }
  }
  assertDispatchShape(request)
  const requested = parallelAmount(request)
  const guarded = assertGuard(ports, request.guard, 'follow')
  const pinned = loadPinnedDomain(ports, request.guard.sessionId)
  assertDomain(ports, request, guarded.value.bindingId, pinned)
  const actionHead = ports.loadHead(actionRecordId(request.actionId))
  if (!actionHead || actionHead.record_revision !== request.expectedActionRevision)
    refuse('conflict', 'action_state', 'action state does not match the admission')
  const action = storedValue<ActionValue>(actionHead)
  if (action.state !== 'prepared' || action.currentAttemptId !== null || action.runId !== request.guard.runId)
    refuse('conflict', 'action_state', 'action state does not match the admission')
  if (request.requestIdentity.requestDigest !== actionInputDigest(action))
    refuse('invalid_input', 'request_digest', 'request digest does not match the action input')
  const decision = decideDispatch(ports, request, guarded.value, requested)
  const stamp = at(ports)
  const input = blankInput(
    request.guard.sessionId,
    verified,
    request.commitId,
    stamp,
    fingerprint,
    request.guard.runId,
    request.guard.writerEpoch,
    guarded.value.revision,
  )
  const owner = ownerOf(actionHead)
  const admissionId = request.admissionId
  let result: DispatchAdmissionResult
  if (decision.kind === 'admit') {
    const authorizationId = stableId('az', admissionId)
    const mirrorId = requested > 0 ? stableId('qr', admissionId) : null
    const quotaReservationRefs = mirrorId ? [mirrorId] : []
    result = {
      state: 'admitted',
      commitId: request.commitId,
      authorizationId,
      attemptId: request.attemptId,
      budgetReservationRefs: [],
      quotaReservationRefs,
    }
    const attempt: AttemptValue = {
      attemptId: request.attemptId,
      actionId: request.actionId,
      number: 1,
      kind: 'leaf',
      bindingId: request.guard.bindingId,
      inputDigest: actionInputDigest(action),
      state: 'dispatching',
      requestIdentity: request.requestIdentity,
      externalRequests: [],
      authorizationRef: authorizationId,
      budgetReservationRefs: [],
      streamIds: [],
      startedAt: null,
      executeDeadline: request.deadline,
      finishedAt: null,
      receiptIds: [],
      writerEpoch: request.guard.writerEpoch,
    }
    const creates = [
      record(attemptRecordId(request.attemptId), ATTEMPT_SCHEMA, 1, owner, attempt),
      record(dispatchRecordId(admissionId), DISPATCH_ADMISSION_SCHEMA, 1, owner, {
        admissionId,
        requestFingerprint: fingerprint,
        result,
      } satisfies DispatchValue),
    ]
    const updates = [
      updated(actionHead, ACTION_SCHEMA, owner, {
        ...action,
        state: 'dispatching',
        currentAttemptId: request.attemptId,
        authorizationTaintSnapshot: taintOf(ports, request.guard.runId),
      }),
    ]
    if (mirrorId) {
      creates.push(
        record(quotaRecordId(mirrorId), QUOTA_MIRROR_SCHEMA, 1, owner, {
          source: {
            authorityId: ports.authority.authorityId,
            recordId: actionHead.record_id,
            recordRevision: actionHead.record_revision,
            schema: ACTION_SCHEMA,
            digest: actionHead.body_digest,
          },
          reservationId: mirrorId,
          ownerRef: { kind: 'run', id: request.guard.runId },
          scopeIds: [request.guard.runId],
          kind: 'parallel-action',
          quantity: requested,
          status: 'held',
          requestFingerprint: fingerprint,
          createdAt: stamp,
          releasedAt: null,
        }),
      )
      const quotaHead = requireHead(
        ports,
        runQuotaRecordId(request.guard.runId),
        'quota_absent',
        'run quota record is missing',
      )
      const quota = storedValue<RunQuotaValue>(quotaHead)
      updates.push(
        updated(quotaHead, RUN_QUOTA_SCHEMA, ownerOf(quotaHead), {
          ...quota,
          activeQuotaReservationRefs: [...quota.activeQuotaReservationRefs, mirrorId],
        }),
      )
    }
    input.creates = creates
    input.updates = updates
  } else {
    const controlId = stableId('ctl', admissionId)
    const receiptId = stableId('rcpt', admissionId)
    result = { state: 'rejected', commitId: request.commitId, reason: decision.reason, error: decision.error }
    const attempt: AttemptValue = {
      attemptId: controlId,
      actionId: request.actionId,
      number: 0,
      kind: 'control',
      bindingId: request.guard.bindingId,
      inputDigest: actionInputDigest(action),
      state: 'settled',
      requestIdentity: null,
      externalRequests: [],
      authorizationRef: null,
      budgetReservationRefs: [],
      streamIds: [],
      startedAt: stamp,
      executeDeadline: null,
      finishedAt: stamp,
      receiptIds: [receiptId],
      writerEpoch: request.guard.writerEpoch,
    }
    input.creates = [
      record(attemptRecordId(controlId), ATTEMPT_SCHEMA, 1, owner, attempt),
      record(receiptRecordId(receiptId), RECEIPT_SCHEMA, 1, owner, {
        receipt: {
          receiptId,
          actionId: request.actionId,
          attemptId: controlId,
          bindingId: request.guard.bindingId,
          inputDigest: actionInputDigest(action),
          outcome: decision.outcome,
          error: decision.error,
          externalRequests: [],
          usageRefs: [],
          references: [],
          provenance: { sourceRefs: [], producer: owner.ownerBinding, trustLabels: [] },
          completedAt: stamp,
        },
        evidenceRefs: [],
        acceptedBy: request.guard.writerId,
        acceptedAt: stamp,
      }),
      record(dispatchRecordId(admissionId), DISPATCH_ADMISSION_SCHEMA, 1, owner, {
        admissionId,
        requestFingerprint: fingerprint,
        result,
      } satisfies DispatchValue),
    ]
    const settledAction: ActionValue = {
      ...action,
      state: 'settled',
      currentAttemptId: controlId,
      firstReceiptId: receiptId,
    }
    input.updates = [updated(actionHead, ACTION_SCHEMA, owner, settledAction)]
    input.sides = [{ commitId: request.commitId, kind: 'receipt-created', receiptId }]
    const rejectionReceipt: Receipt = {
      receiptId,
      actionId: request.actionId,
      attemptId: controlId,
      bindingId: request.guard.bindingId,
      inputDigest: actionInputDigest(action),
      outcome: decision.outcome,
      error: decision.error,
      externalRequests: [],
      usageRefs: [],
      references: [],
      provenance: { sourceRefs: [], producer: owner.ownerBinding, trustLabels: [] },
      completedAt: stamp,
    }
    const published = publishNoHook(ports, {
      commitId: request.commitId,
      stamp,
      sessionId: request.guard.sessionId,
      owner,
      run: guarded.value,
      action: settledAction,
      attempt,
      receipt: rejectionReceipt,
      usage: [],
      evidence: [],
      acceptedBy: request.guard.writerId,
      intakeId: null,
      contentFingerprint: null,
      includeReceipt: false,
    })
    input.creates.push(...published.creates)
    input.updates.push(...published.updates)
    input.sides.push(...published.sides)
  }
  if (pinned === undefined) pinDomain(ports, request.guard.sessionId, request.atomicDomain)
  const written = ports.writeCommit(input)
  ports.rememberRequest('dispatchAdmission', admissionId, fingerprint, {
    request,
    decisionRef: request.decisionRef,
    result,
    receipt: written.receipt,
  } satisfies RememberedDispatch)
  return { result, sessionId: request.guard.sessionId, verified: written.verified }
}

export function probeDispatchTx(ports: ControlPorts, admissionId: string): DispatchAdmissionProbe {
  const head = ports.loadHead(dispatchRecordId(admissionId))
  if (!head) return { state: 'absent' }
  const value = storedValue<DispatchValue>(head)
  return {
    state: 'decided',
    admissionId: value.admissionId,
    requestFingerprint: value.requestFingerprint,
    result: value.result,
  }
}

function mergeExternal(
  stored: readonly ExternalRequestRef[],
  incoming: readonly ExternalRequestRef[],
): ExternalRequestRef[] {
  const appended: ExternalRequestRef[] = []
  for (const item of incoming) {
    const match = stored.find((entry) => entry.system === item.system && entry.requestId === item.requestId)
    if (!match) {
      appended.push(item)
      continue
    }
    if (
      match.requestDigest !== item.requestDigest ||
      (match.idempotencyKey ?? null) !== (item.idempotencyKey ?? null)
    )
      refuse('conflict', 'external_request', 'external request digest does not match')
  }
  return appended.length === 0 ? [...stored] : [...stored, ...appended]
}

export async function commitControlTx(
  ports: ControlPorts,
  request: CommitControlRequest,
): Promise<Committed<StateCommitReceipt>> {
  const verified = await ports.requireSession(request.guard.sessionId)
  const fingerprint = digestOf({ guard: request.guard, command: request.command })
  const stored = ports.replayRequest<StateCommitReceipt>('commitControl', request.commitId, fingerprint)
  if (stored) {
    ports.assertReceipt(request.guard.sessionId, stored, fingerprint)
    return { result: stored, sessionId: request.guard.sessionId }
  }
  if (request.command.kind !== 'mark_running') refuse('internal', 'unsupported', CONTROL_COMMAND)
  const command = request.command
  const guarded = assertGuard(ports, request.guard, 'follow')
  const head = requireHead(
    ports,
    attemptRecordId(command.attemptId),
    'attempt_absent',
    'attempt does not exist',
  )
  if (head.record_revision !== command.expectedAttemptRevision)
    refuse('conflict', 'attempt_revision', 'attempt revision does not match')
  const attempt = storedValue<AttemptValue>(head)
  if (attempt.state === 'settled') refuse('conflict', 'attempt_settled', 'attempt is already settled')
  if (attempt.state !== 'allocated' && attempt.state !== 'dispatching' && attempt.state !== 'running')
    refuse('conflict', 'attempt_state', 'attempt cannot be marked running')
  const actionHead = requireHead(
    ports,
    actionRecordId(attempt.actionId),
    'action_state',
    'action does not exist',
  )
  const action = storedValue<ActionValue>(actionHead)
  if (action.runId !== request.guard.runId)
    refuse('conflict', 'action_state', 'action state does not match the admission')
  const externalRequests = mergeExternal(attempt.externalRequests, command.externalRequests)
  const flushed = request.guard.queryUsage
    ? planQueryFlush(ports, guarded.invocation, request.guard.queryUsage)
    : undefined
  const stamp = at(ports)
  const queryUpdates: RecordUpdate[] = []
  if (flushed) {
    const quotaHead = requireHead(
      ports,
      runQuotaRecordId(request.guard.runId),
      'quota_absent',
      'run quota record is missing',
    )
    queryUpdates.push(
      updated(flushed.prepareHead, PREPARE_QUOTA_SCHEMA, ownerOf(flushed.prepareHead), flushed.prepare),
      updated(flushed.grantHead, QUERY_GRANT_SCHEMA, ownerOf(flushed.grantHead), flushed.grant),
      updated(
        quotaHead,
        RUN_QUOTA_SCHEMA,
        ownerOf(quotaHead),
        applyQueryDelta(storedValue(quotaHead), flushed.delta),
      ),
    )
  }
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      request.commitId,
      stamp,
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      guarded.value.revision,
    ),
    updates: [
      updated(head, ATTEMPT_SCHEMA, ownerOf(head), {
        ...attempt,
        state: 'running',
        startedAt: attempt.startedAt ?? stamp,
        externalRequests,
      }),
      ...queryUpdates,
    ],
  })
  ports.rememberRequest('commitControl', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}

export async function intakeReceiptTx(
  ports: ControlPorts,
  request: ReceiptIntakeRequest,
): Promise<Committed<ReceiptIntakeResult>> {
  assertNoHookHandling(request.resultHandling.kind)
  const actionHead = requireHead(
    ports,
    actionRecordId(request.receipt.actionId),
    'action_absent',
    'action does not exist',
  )
  const action = storedValue<ActionValue>(actionHead)
  const loaded = loadRun(ports, action.runId)
  const verified = await ports.requireSession(loaded.value.sessionId)
  const fingerprint = intakeFingerprint(request)
  const replayed = replayWrapped<ReceiptIntakeResult>(
    ports,
    loaded.value.sessionId,
    'intakeReceipt',
    request.intakeId,
    fingerprint,
  )
  if (replayed) return { result: replayed, sessionId: loaded.value.sessionId }
  const attemptHead = requireHead(
    ports,
    attemptRecordId(request.receipt.attemptId),
    'attempt_absent',
    'attempt does not exist',
  )
  const attempt = storedValue<AttemptValue>(attemptHead)
  const receiptHead = ports.loadHead(receiptRecordId(request.receipt.receiptId))
  if (receiptHead) {
    const stored = storedValue<StoredReceiptValue>(receiptHead)
    if (stored.contentFingerprint !== fingerprint || !stored.intakeId)
      refuse('conflict', 'receipt_conflict', 'receipt was already accepted with different content')
    assertLiveEpoch(ports, loaded.value.sessionId, attempt.writerEpoch)
    const original = ports.replayRequest<Remembered<ReceiptIntakeResult>>(
      'intakeReceipt',
      stored.intakeId,
      fingerprint,
    )
    if (!original) integrity('stored receipt intake is missing')
    const result: ReceiptIntakeResult = { intakeId: original.result.intakeId, state: 'duplicate' }
    ports.rememberRequest('intakeReceipt', request.intakeId, fingerprint, {
      result,
      receipt: original.receipt,
    })
    return { result, sessionId: loaded.value.sessionId }
  }
  assertLiveEpoch(ports, loaded.value.sessionId, attempt.writerEpoch)
  if (action.resultHookPlan !== null)
    refuse('conflict', 'result_handling', 'action result hook plan is not eligible for no-hook intake')
  if (attempt.kind === 'control' || attempt.number < 1)
    refuse('conflict', 'attempt_state', 'control attempt cannot accept a receipt')
  if (attempt.actionId !== action.actionId || attempt.attemptId !== request.receipt.attemptId)
    refuse('conflict', 'attempt_state', 'receipt attempt does not match the action')
  if (
    attempt.receiptIds.length > 0 ||
    (action.resolvedReceiptId !== null && action.resolvedReceiptId !== request.receipt.receiptId)
  )
    refuse('conflict', 'receipt_conflict', 'action already has a receipt')
  if (attempt.state !== 'dispatching' && attempt.state !== 'running')
    refuse('conflict', 'attempt_state', 'attempt is not open for a receipt')
  if (request.receipt.bindingId !== attempt.bindingId || request.receipt.actionId !== action.actionId)
    refuse('conflict', 'binding', 'receipt binding does not match the attempt')
  if (request.receipt.inputDigest !== attempt.inputDigest)
    refuse('conflict', 'input_digest', 'receipt input digest does not match the attempt')
  if (!sameJson(request.receipt.externalRequests, attempt.externalRequests))
    refuse('conflict', 'external_request', 'receipt external requests do not match the attempt')
  if (request.sourceAuthorizationRef !== attempt.authorizationRef)
    refuse('conflict', 'authorization', 'source authorization does not match the attempt')
  for (const fact of request.usage) {
    if (fact.actionId !== action.actionId || fact.attemptId !== attempt.attemptId)
      refuse('invalid_input', 'usage', 'usage fact does not match the attempt')
  }
  const lease = loadLease(ports, loaded.value.sessionId)
  if (!lease.writer_id) refuse('conflict', 'writer_lease', 'writer lease is not live')
  const flushed = request.queryUsage
    ? planQueryFlush(ports, loadInvocation(ports, request.queryUsage.invocationId), request.queryUsage)
    : undefined
  if (flushed && flushed.grant.runId !== action.runId)
    refuse('conflict', 'grant_absent', 'query grant does not match the run')
  const stamp = at(ports)
  const commitId = ports.ulid()
  const published = publishNoHook(ports, {
    commitId,
    stamp,
    sessionId: loaded.value.sessionId,
    owner: ownerOf(actionHead),
    run: loaded.value,
    action,
    attempt,
    receipt: request.receipt,
    usage: request.usage,
    evidence: request.evidence,
    acceptedBy: lease.writer_id,
    intakeId: request.intakeId,
    contentFingerprint: fingerprint,
    actionHead,
    attemptHead,
    includeReceipt: true,
  })
  if (flushed) mergeQuery(ports, published.updates, flushed)
  const result: ReceiptIntakeResult = { intakeId: request.intakeId, state: 'accepted' }
  return rememberWrapped(
    ports,
    {
      ...blankInput(
        loaded.value.sessionId,
        verified,
        commitId,
        stamp,
        fingerprint,
        action.runId,
        attempt.writerEpoch,
        loaded.value.revision,
      ),
      actionId: action.actionId,
      creates: published.creates,
      updates: published.updates,
      sides: published.sides,
    },
    'intakeReceipt',
    request.intakeId,
    fingerprint,
    result,
  )
}

function loadInvocation(ports: ControlPorts, invocationId: string): InvocationValue {
  const head = requireHead(
    ports,
    invocationRecordId(invocationId),
    'invocation_absent',
    'invocation does not exist',
  )
  return storedValue<InvocationValue>(head)
}

function mergeQuery(ports: ControlPorts, updates: RecordUpdate[], flushed: QueryDelta): void {
  updates.push(updated(flushed.grantHead, QUERY_GRANT_SCHEMA, ownerOf(flushed.grantHead), flushed.grant))
  const prepareIndex = updates.findIndex((update) => update.record.recordId === flushed.prepareHead.record_id)
  if (prepareIndex >= 0) {
    const current = updates[prepareIndex]
    if (current) {
      updates[prepareIndex] = {
        record: {
          ...current.record,
          value: { ...(current.record.value as PrepareValue), ...flushed.prepare },
        },
        previousRevision: current.previousRevision,
      }
    }
  } else {
    updates.push(
      updated(flushed.prepareHead, PREPARE_QUOTA_SCHEMA, ownerOf(flushed.prepareHead), flushed.prepare),
    )
  }
  const quotaHead = requireHead(
    ports,
    runQuotaRecordId(flushed.grant.runId),
    'quota_absent',
    'run quota record is missing',
  )
  const quotaIndex = updates.findIndex((update) => update.record.recordId === quotaHead.record_id)
  if (quotaIndex >= 0) {
    const current = updates[quotaIndex]
    if (!current) return
    updates[quotaIndex] = {
      record: {
        ...current.record,
        value: applyQueryDelta(current.record.value as RunQuotaValue, flushed.delta),
      },
      previousRevision: current.previousRevision,
    }
    return
  }
  updates.push(
    updated(
      quotaHead,
      RUN_QUOTA_SCHEMA,
      ownerOf(quotaHead),
      applyQueryDelta(storedValue(quotaHead), flushed.delta),
    ),
  )
}

export function probeActionResultTx(
  ports: ControlPorts,
  request: ProbeActionResultRequest,
): ActionVisibilityValue | null {
  const head = ports.loadHead(visibilityRecordId(request.sourceReceiptId))
  if (!head) return null
  const value = storedValue<ActionVisibilityValue>(head)
  if (value.actionId !== request.actionId) return null
  return value
}

export async function admitQueryTx(ports: ControlPorts, request: QueryAdmission): Promise<AdmitQueryResult> {
  const invocationHead = requireHead(
    ports,
    invocationRecordId(request.invocationId),
    'invocation_absent',
    'invocation does not exist',
  )
  const invocation = storedValue<InvocationValue>(invocationHead)
  const loaded = loadRun(ports, invocation.runId)
  await ports.requireSession(loaded.value.sessionId)
  const grantHead = ports.loadHead(grantRecordId(invocation.queryGrantId))
  if (!grantHead) refuse('invalid_input', 'grant_absent', 'query grant does not exist')
  const grant = storedValue<GrantValue>(grantHead)
  const meter = ports.queryMeter(grant.grantId)
  if (grant.state !== 'active' || !meter)
    refuse('conflict', 'query_owner', 'query meter is not available for this grant')
  const existing = ports.lookupQueryTicket(grant.grantId, request.requestId)
  if (existing) {
    if (existing.fingerprint !== request.queryFingerprint)
      refuse('conflict', 'idempotency_conflict', 'request id was already committed with different content')
    return { queryTicketId: existing.ticketId, remainingQueries: existing.remainingQueries }
  }
  if (meter.observed >= meter.capacity) refuse('conflict', 'quota', 'query grant is exhausted')
  const ticket = {
    fingerprint: request.queryFingerprint,
    ticketId: stableId('qt', `${grant.grantId}\0${request.requestId}`),
    remainingQueries: meter.capacity - (meter.observed + 1),
  }
  ports.rememberQueryTicket(grant.grantId, request.requestId, ticket)
  return { queryTicketId: ticket.ticketId, remainingQueries: ticket.remainingQueries }
}

export async function claimOutboxTx(
  ports: ControlPorts,
  request: ClaimOutboxRequest,
): Promise<Committed<ClaimOutboxResult>> {
  const fingerprint = digestOf(request)
  const sessionId = anySessionId(ports)
  await ports.requireSession(sessionId)
  const replayed = ports.replayRequest<ClaimOutboxResult>('claimOutbox', request.requestId, fingerprint)
  if (replayed) return { result: replayed, sessionId }
  const limit = Math.min(request.limit, MAX_OUTBOX_CLAIM)
  const now = ports.now()
  const due =
    limit <= 0
      ? []
      : ports.all<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM runtime_outbox_delivery
           WHERE destination = ? AND delivery = 'pending' AND next_attempt_at <= ?
           ORDER BY event_id LIMIT ?`,
          request.destination,
          now,
          limit,
        )
  if (due.length === 0) {
    ports.rememberRequest('claimOutbox', request.requestId, fingerprint, [])
    return { result: [], sessionId }
  }
  const claimed: ClaimOutboxResult = []
  for (const row of due) {
    if (row.session_id !== sessionId) await ports.requireSession(row.session_id)
    const epoch = row.claim_epoch + 1
    const until = now + request.leaseMs
    ports.run(
      `UPDATE runtime_outbox_delivery
       SET claim_epoch = ?, active_owner = ?, active_epoch = ?, active_until = ?, delivery = 'claimed', last_owner = ?
       WHERE event_id = ? AND delivery = 'pending'`,
      epoch,
      request.ownerId,
      epoch,
      until,
      request.ownerId,
      row.event_id,
    )
    const head = requireHead(
      ports,
      outboxRecordId(row.event_id),
      'outbox_absent',
      'outbox event does not exist',
    )
    const stored = storedValue<StoredOutbox>(head)
    const next: DeliveryRow = {
      ...row,
      claim_epoch: epoch,
      active_owner: request.ownerId,
      active_epoch: epoch,
      active_until: until,
      delivery: 'claimed',
      last_owner: request.ownerId,
    }
    const event = assembleOutbox(stored, next)
    const claim: OutboxClaim = {
      eventId: row.event_id,
      ownerId: request.ownerId,
      epoch,
      until: new Date(until).toISOString(),
    }
    claimed.push({ claim, event })
  }
  ports.noteWrite()
  ports.rememberRequest('claimOutbox', request.requestId, fingerprint, claimed)
  return { result: claimed, sessionId }
}

export async function ackOutboxTx(
  ports: ControlPorts,
  request: AckOutboxRequest,
): Promise<Committed<AckOutboxResult>> {
  const fingerprint = digestOf(request)
  const replayed = ports.replayRequest<AckOutboxResult>('ackOutbox', request.requestId, fingerprint)
  if (replayed) return { result: replayed, sessionId: anySessionId(ports) }
  const row = loadDelivery(ports, request.claim.eventId)
  if (!row || !claimIsCurrent(row, request.claim, ports.now(), true))
    refuse('conflict', 'claim_epoch', 'outbox claim epoch does not match')
  await ports.requireSession(row.session_id)
  const ackRef = stableId('ack', `${row.event_id}\0${request.requestId}`)
  ports.run(
    `UPDATE runtime_outbox_delivery
     SET delivery = 'acked', acked_epoch = ?, ack_ref = ?, active_owner = NULL, active_epoch = NULL, active_until = NULL
     WHERE event_id = ?`,
    request.claim.epoch,
    ackRef,
    row.event_id,
  )
  ports.noteWrite()
  const result: AckOutboxResult = { eventId: row.event_id, state: 'acked' }
  ports.rememberRequest('ackOutbox', request.requestId, fingerprint, result)
  return { result, sessionId: row.session_id }
}

export async function failOutboxTx(
  ports: ControlPorts,
  request: FailOutboxRequest,
): Promise<Committed<FailOutboxResult>> {
  const fingerprint = digestOf(request)
  const replayed = ports.replayRequest<FailOutboxResult>('failOutbox', request.requestId, fingerprint)
  if (replayed) return { result: replayed, sessionId: anySessionId(ports) }
  const row = loadDelivery(ports, request.claim.eventId)
  if (!row || !claimIsCurrent(row, request.claim, ports.now(), false))
    refuse('conflict', 'claim_epoch', 'outbox claim epoch does not match')
  await ports.requireSession(row.session_id)
  const attempts = row.attempts + 1
  const dead = attempts >= OUTBOX_DEAD_AFTER
  const delay = Math.min(OUTBOX_BACKOFF_CAP_MS, 1_000 * 2 ** (attempts - 1))
  const nextAt = ports.now() + delay
  ports.run(
    `UPDATE runtime_outbox_delivery
     SET delivery = ?, attempts = ?, next_attempt_at = ?, active_owner = NULL, active_epoch = NULL,
         active_until = NULL, error_json = ?, last_owner = ?
     WHERE event_id = ?`,
    dead ? 'dead' : 'pending',
    attempts,
    nextAt,
    canonicalJson(request.error),
    row.active_owner,
    row.event_id,
  )
  ports.noteWrite()
  const result: FailOutboxResult = {
    eventId: row.event_id,
    state: dead ? 'dead' : 'pending',
    nextAttemptAt: new Date(nextAt).toISOString(),
  }
  ports.rememberRequest('failOutbox', request.requestId, fingerprint, result)
  return { result, sessionId: row.session_id }
}

type CreationNote = { commitId: string; createdBy: string }

type AttemptNote = {
  attemptId: string
  actionId: string
  number: number
  kind: string
  state: string
  requestIdentity: unknown
  authorizationRef: string | null
  budgetReservationRefs: unknown[]
  externalRequests: unknown[]
  revision: number
}

type QuotaNote = {
  revision: number
  status: string
  kind: string
  requestFingerprint: string
  scopeIds: string[]
}

type AdmissionNote = {
  revision: number
  commitId: string
  admissionId: string
  requestFingerprint: string
  result: DispatchAdmissionResult
}

type ReceiptOutcome = { outcome: string; actionId: string; errorCode: string | null }

type ViewNote = {
  revision: number
  commitId: string
  actionId: string
  outcome: string
  errorCode: string | null
  state: string
}

export type ControlScan = {
  actions: Map<string, CreationNote>
  actionSides: Map<string, string>
  duplicateActionSide: boolean
  receipts: Map<string, CreationNote>
  receiptSides: Map<string, string>
  duplicateReceiptSide: boolean
  receiptsOnCommit: Map<string, number>
  receiptOutcomes: Map<string, ReceiptOutcome>
  attempts: Map<string, AttemptNote>
  attemptsOnCommit: Map<string, AttemptNote[]>
  actionStates: Map<string, string[]>
  admissions: Map<string, AdmissionNote>
  quotas: Map<string, QuotaNote>
  views: Map<string, ViewNote>
  signalsByReceipt: Set<string>
  signalConsumed: Map<string, number>
  outboxes: Map<string, string>
  outboxSides: Map<string, string>
  usages: Map<string, string>
  usageSides: Map<string, string>
  usageSideCount: Map<string, number>
}

export type ControlVersionNote = {
  record_id: string
  record_revision: number
  commit_id: string
  value_json: string
}

export type ControlEvidence = {
  sessionId: string
  requests(): { request_id: string; fingerprint: string; result_json: string }[]
  domainJson(): string | undefined
}

export function createControlScan(): ControlScan {
  return {
    actions: new Map(),
    actionSides: new Map(),
    duplicateActionSide: false,
    receipts: new Map(),
    receiptSides: new Map(),
    duplicateReceiptSide: false,
    receiptsOnCommit: new Map(),
    attempts: new Map(),
    attemptsOnCommit: new Map(),
    actionStates: new Map(),
    admissions: new Map(),
    quotas: new Map(),
    receiptOutcomes: new Map(),
    views: new Map(),
    signalsByReceipt: new Set(),
    signalConsumed: new Map(),
    outboxes: new Map(),
    outboxSides: new Map(),
    usages: new Map(),
    usageSides: new Map(),
    usageSideCount: new Map(),
  }
}

function bodyRecord(text: string): Record<string, unknown> {
  const value = parseJson(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    integrity('record body cannot be decoded')
  return value as Record<string, unknown>
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function errorCodeOf(value: unknown): string | null {
  const code = objectRecord(value)?.code
  return typeof code === 'string' ? code : null
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function noteLatest<T extends { revision: number }>(map: Map<string, T>, id: string, note: T): void {
  const current = map.get(id)
  if (!current || note.revision >= current.revision) map.set(id, note)
}

export function noteControlVersion(scan: ControlScan, version: ControlVersionNote): void {
  const id = version.record_id
  if (id.startsWith('action:')) noteActionVersion(scan, version)
  else if (id.startsWith('attempt:')) noteAttemptVersion(scan, version)
  else if (id.startsWith('dispatch:')) noteAdmissionVersion(scan, version)
  else if (id.startsWith('receipt:')) noteReceiptVersion(scan, version)
  else if (id.startsWith('quota:')) noteQuotaVersion(scan, version)
  else if (id.startsWith('visibility:')) noteVisibilityVersion(scan, version)
  else if (id.startsWith('signal:')) noteSignalVersion(scan, version)
  else if (id.startsWith('outbox:')) noteOutboxVersion(scan, version)
  else if (id.startsWith('usage:')) noteUsageVersion(scan, version)
}

function noteActionVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const actionId = typeof body.actionId === 'string' ? body.actionId : ''
  const state = typeof body.state === 'string' ? body.state : ''
  const states = scan.actionStates.get(version.commit_id) ?? []
  states.push(state)
  scan.actionStates.set(version.commit_id, states)
  if (version.record_revision !== 1) return
  const createdBy = typeof body.createdByCommitId === 'string' ? body.createdByCommitId : ''
  const prior = scan.actions.get(actionId)
  if (prior && prior.commitId !== version.commit_id) scan.duplicateActionSide = true
  scan.actions.set(actionId, { commitId: version.commit_id, createdBy })
  if (version.record_id !== actionRecordId(actionId)) scan.duplicateActionSide = true
}

function noteAttemptVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const note: AttemptNote = {
    attemptId: typeof body.attemptId === 'string' ? body.attemptId : '',
    actionId: typeof body.actionId === 'string' ? body.actionId : '',
    number: typeof body.number === 'number' ? body.number : -1,
    kind: typeof body.kind === 'string' ? body.kind : '',
    state: typeof body.state === 'string' ? body.state : '',
    requestIdentity: body.requestIdentity ?? null,
    authorizationRef: typeof body.authorizationRef === 'string' ? body.authorizationRef : null,
    budgetReservationRefs: Array.isArray(body.budgetReservationRefs) ? body.budgetReservationRefs : [null],
    externalRequests: Array.isArray(body.externalRequests) ? body.externalRequests : [null],
    revision: version.record_revision,
  }
  noteLatest(scan.attempts, note.attemptId, note)
  const onCommit = scan.attemptsOnCommit.get(version.commit_id) ?? []
  onCommit.push(note)
  scan.attemptsOnCommit.set(version.commit_id, onCommit)
}

function noteAdmissionVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const result = body.result
  if (!result || typeof result !== 'object') integrity('record body cannot be decoded')
  noteLatest(scan.admissions, typeof body.admissionId === 'string' ? body.admissionId : version.record_id, {
    revision: version.record_revision,
    commitId: version.commit_id,
    admissionId: typeof body.admissionId === 'string' ? body.admissionId : '',
    requestFingerprint: typeof body.requestFingerprint === 'string' ? body.requestFingerprint : '',
    result: result as DispatchAdmissionResult,
  })
}

function noteReceiptVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) return
  const body = bodyRecord(version.value_json)
  const receipt = body.receipt
  const receiptId =
    receipt &&
    typeof receipt === 'object' &&
    typeof (receipt as { receiptId?: unknown }).receiptId === 'string'
      ? (receipt as { receiptId: string }).receiptId
      : ''
  if (receiptId === '' || version.record_id !== receiptRecordId(receiptId)) scan.duplicateReceiptSide = true
  const prior = scan.receipts.get(receiptId)
  if (prior && prior.commitId !== version.commit_id) scan.duplicateReceiptSide = true
  scan.receipts.set(receiptId, { commitId: version.commit_id, createdBy: version.commit_id })
  const receiptRecord = objectRecord(receipt)
  scan.receiptOutcomes.set(receiptId, {
    outcome: typeof receiptRecord?.outcome === 'string' ? receiptRecord.outcome : '',
    actionId: typeof receiptRecord?.actionId === 'string' ? receiptRecord.actionId : '',
    errorCode: errorCodeOf(receiptRecord?.error),
  })
}

function noteQuotaVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  noteLatest(scan.quotas, version.record_id, {
    revision: version.record_revision,
    status: typeof body.status === 'string' ? body.status : '',
    kind: typeof body.kind === 'string' ? body.kind : '',
    requestFingerprint: typeof body.requestFingerprint === 'string' ? body.requestFingerprint : '',
    scopeIds: textList(body.scopeIds),
  })
}

function noteVisibilityVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const result = objectRecord(body.result)
  const sourceReceiptId = typeof body.sourceReceiptId === 'string' ? body.sourceReceiptId : ''
  noteLatest(scan.views, sourceReceiptId, {
    revision: version.record_revision,
    commitId: version.commit_id,
    actionId: typeof body.actionId === 'string' ? body.actionId : '',
    outcome: typeof result?.outcome === 'string' ? result.outcome : '',
    errorCode: errorCodeOf(result?.error),
    state: typeof body.state === 'string' ? body.state : '',
  })
}

function noteSignalVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const sourceReceiptId = typeof body.sourceReceiptId === 'string' ? body.sourceReceiptId : ''
  if (sourceReceiptId !== '') scan.signalsByReceipt.add(sourceReceiptId)
}

function noteOutboxVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) return
  const body = bodyRecord(version.value_json)
  const eventId = typeof body.eventId === 'string' ? body.eventId : version.record_id.slice('outbox:'.length)
  scan.outboxes.set(eventId, version.commit_id)
}

function noteUsageVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) return
  const body = bodyRecord(version.value_json)
  const authorityId = typeof body.sourceAuthorityId === 'string' ? body.sourceAuthorityId : ''
  const originKey = typeof body.originKey === 'string' ? body.originKey : ''
  scan.usages.set(`${authorityId}\0${originKey}`, version.commit_id)
}

export function noteControlSide(scan: ControlScan, entry: CommitSideEntry): void {
  if (entry.kind === 'action-created') {
    if (scan.actionSides.has(entry.actionId)) scan.duplicateActionSide = true
    else scan.actionSides.set(entry.actionId, entry.commitId)
  } else if (entry.kind === 'receipt-created') {
    scan.receiptsOnCommit.set(entry.commitId, (scan.receiptsOnCommit.get(entry.commitId) ?? 0) + 1)
    if (scan.receiptSides.has(entry.receiptId)) scan.duplicateReceiptSide = true
    else scan.receiptSides.set(entry.receiptId, entry.commitId)
  } else if (entry.kind === 'signal-consumed') {
    scan.signalConsumed.set(entry.signalId, (scan.signalConsumed.get(entry.signalId) ?? 0) + 1)
  } else if (entry.kind === 'outbox-created') {
    scan.outboxSides.set(entry.eventId, entry.commitId)
  } else {
    const identity = `${entry.sourceAuthorityId}\0${entry.originKey}`
    scan.usageSideCount.set(identity, (scan.usageSideCount.get(identity) ?? 0) + 1)
    if (!scan.usageSides.has(identity)) scan.usageSides.set(identity, entry.commitId)
  }
}

function matchCreation(
  records: ReadonlyMap<string, CreationNote>,
  sides: ReadonlyMap<string, string>,
  duplicate: boolean,
  message: string,
): void {
  if (duplicate || records.size !== sides.size) integrity(message)
  for (const [id, created] of records) {
    if (sides.get(id) !== created.commitId || created.createdBy !== created.commitId) integrity(message)
  }
}

function storedRequest(text: string): {
  request: Record<string, unknown>
  decisionRef: unknown
  result: unknown
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    integrity('stored request result cannot be decoded')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    integrity('stored dispatch request does not match its fingerprint')
  const body = parsed as { request?: unknown; decisionRef?: unknown; result?: unknown }
  if (body.request === null || typeof body.request !== 'object' || Array.isArray(body.request))
    integrity('stored dispatch request does not match its fingerprint')
  return {
    request: body.request as Record<string, unknown>,
    decisionRef: body.decisionRef,
    result: body.result,
  }
}

function receiptIdOnCommit(scan: ControlScan, commitId: string): string | undefined {
  let found: string | undefined
  for (const [receiptId, sideCommit] of scan.receiptSides) {
    if (sideCommit !== commitId) continue
    if (found !== undefined) return undefined
    found = receiptId
  }
  return found
}

function assertRejectionPublished(scan: ControlScan, commitId: string): void {
  const receiptId = receiptIdOnCommit(scan, commitId)
  const view = receiptId === undefined ? undefined : scan.views.get(receiptId)
  const eventId = receiptId === undefined ? undefined : stableId('obx', `${commitId}\0result\0${receiptId}`)
  if (
    receiptId === undefined ||
    view === undefined ||
    view.state !== 'ready' ||
    view.commitId !== commitId ||
    !scan.signalsByReceipt.has(receiptId) ||
    eventId === undefined ||
    scan.outboxSides.get(eventId) !== commitId
  )
    integrity('rejected admission does not publish a completion')
}

function assertPublication(scan: ControlScan): void {
  for (const count of scan.signalConsumed.values()) {
    if (count > 1) integrity('signal was consumed more than once')
  }
  for (const count of scan.usageSideCount.values()) {
    if (count > 1) integrity('usage origin was recorded twice')
  }
  if (scan.usages.size !== scan.usageSides.size)
    integrity('usage origin side entry does not match the usage mirror')
  for (const [identity, commitId] of scan.usages) {
    if (scan.usageSides.get(identity) !== commitId)
      integrity('usage origin side entry does not match the usage mirror')
  }
  if (scan.outboxes.size !== scan.outboxSides.size)
    integrity('outbox creation side entry does not match the outbox')
  for (const [eventId, commitId] of scan.outboxes) {
    if (scan.outboxSides.get(eventId) !== commitId)
      integrity('outbox creation side entry does not match the outbox')
  }
  for (const [receiptId, view] of scan.views) {
    if (view.state !== 'ready') continue
    const receipt = scan.receiptOutcomes.get(receiptId)
    if (
      receipt === undefined ||
      receipt.outcome !== view.outcome ||
      receipt.actionId !== view.actionId ||
      receipt.errorCode !== view.errorCode
    )
      integrity('ready view does not match the receipt')
  }
}

export function finishControlScan(scan: ControlScan, evidence: ControlEvidence): void {
  matchCreation(
    scan.actions,
    scan.actionSides,
    scan.duplicateActionSide,
    'action creation side entry does not match the action',
  )
  matchCreation(
    scan.receipts,
    scan.receiptSides,
    scan.duplicateReceiptSide,
    'receipt creation side entry does not match the receipt',
  )
  const unsettled = new Map<string, number>()
  for (const attempt of scan.attempts.values()) {
    if (attempt.kind === 'control') {
      if (
        attempt.requestIdentity !== null ||
        attempt.authorizationRef !== null ||
        attempt.budgetReservationRefs.length !== 0 ||
        attempt.externalRequests.length !== 0 ||
        attempt.number !== 0
      )
        integrity('control attempt carries execution authority')
    }
    if (attempt.kind === 'leaf' && (attempt.state === 'dispatching' || attempt.state === 'running')) {
      if (attempt.requestIdentity === null || attempt.authorizationRef === null)
        integrity('leaf attempt is missing execution authority')
    }
    if (attempt.number >= 1 && attempt.state !== 'settled')
      unsettled.set(attempt.actionId, (unsettled.get(attempt.actionId) ?? 0) + 1)
  }
  for (const count of unsettled.values()) {
    if (count > 1) integrity('action has more than one unsettled execution attempt')
  }
  const domains: unknown[] = []
  if (scan.admissions.size > 0) {
    const rows = evidence.requests()
    const byId = new Map(rows.map((row) => [row.request_id, row]))
    for (const admission of scan.admissions.values()) {
      const row = byId.get(admission.admissionId)
      if (!row) integrity('stored dispatch request does not match its fingerprint')
      const stored = storedRequest(row.result_json)
      const decisionRef = stored.request.decisionRef
      if (
        digestOf(stored.request) !== row.fingerprint ||
        row.fingerprint !== admission.requestFingerprint ||
        !sameJson(stored.decisionRef, decisionRef) ||
        !sameJson(stored.result, admission.result)
      )
        integrity('stored dispatch request does not match its fingerprint')
      const guard = stored.request.guard
      const guardRecord =
        guard !== null && typeof guard === 'object' && !Array.isArray(guard)
          ? (guard as { sessionId?: unknown; runId?: unknown })
          : undefined
      if (guardRecord?.sessionId === evidence.sessionId) domains.push(stored.request.atomicDomain)
      if (admission.result.state === 'admitted') {
        const authorizationId = stableId('az', admission.admissionId)
        const attempt = scan.attempts.get(admission.result.attemptId)
        if (
          admission.result.authorizationId !== authorizationId ||
          !attempt ||
          attempt.authorizationRef !== authorizationId ||
          attempt.attemptId !== admission.result.attemptId
        )
          integrity('admitted authorization does not match the decision')
      }
      if (admission.result.state === 'rejected') {
        const states = scan.actionStates.get(admission.commitId) ?? []
        const attempts = scan.attemptsOnCommit.get(admission.commitId) ?? []
        const controls = attempts.filter((attempt) => attempt.kind === 'control' && attempt.number === 0)
        const executing = attempts.filter((attempt) => attempt.number >= 1)
        const receipts = scan.receiptsOnCommit.get(admission.commitId) ?? 0
        if (
          states.length !== 1 ||
          states[0] !== 'settled' ||
          controls.length !== 1 ||
          executing.length !== 0 ||
          receipts !== 1
        )
          integrity('rejected admission does not settle the action')
        const runId = typeof guardRecord?.runId === 'string' ? guardRecord.runId : ''
        for (const quota of scan.quotas.values()) {
          if (
            quota.status === 'held' &&
            quota.kind === 'parallel-action' &&
            quota.requestFingerprint === admission.requestFingerprint &&
            quota.scopeIds.includes(runId)
          )
            integrity('rejected admission still holds quota')
        }
        assertRejectionPublished(scan, admission.commitId)
      }
    }
  }
  assertPublication(scan)
  const pinnedText = evidence.domainJson()
  if (scan.admissions.size === 0) {
    if (pinnedText !== undefined) integrity('dispatch domain does not match the pinned domain')
    return
  }
  if (pinnedText === undefined || domains.length !== scan.admissions.size)
    integrity('dispatch domain does not match the pinned domain')
  const pinned = parseJson(pinnedText)
  for (const domain of domains) {
    if (!sameJson(domain, pinned)) integrity('dispatch domain does not match the pinned domain')
  }
}
