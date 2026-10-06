import type {
  AckOutboxRequest,
  AckOutboxResult,
  ActionResultView,
  ActionVisibilityValue,
  AdmitInvocationResult,
  AdmitQueryResult,
  AdvanceProviderRequest,
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
  ReceiptRecordValue,
  RetentionRef,
  RuntimeError,
  SchemaRef,
  Signal,
  SignalRecordValue,
  StateAuthorityRef,
  StateCommitReceipt,
  UsageFact,
} from '@agnes/extension-api/runtime'
import type {
  ActionRecordValue,
  AuthorizationPreparation,
  InboxRecord,
  InteractionRecord,
  PolicyDecision,
  ProviderStateValue,
  RunBinding,
  TimerRecordValue,
  TrustedPolicyFacts,
  WaitRecordValue,
} from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs, RuntimeStateLegacyReaders, validateRuntime } from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import { noteJsonParse, profiling } from './profile.js'
import {
  ACTION_SCHEMA,
  ATTEMPT_SCHEMA,
  AUTHORIZATION_PREPARATION_SCHEMA,
  actionRecordId,
  attemptRecordId,
  type CommitSideEntry,
  DISPATCH_ADMISSION_SCHEMA,
  digestOf,
  dispatchRecordId,
  grantRecordId,
  INTERACTION_SCHEMA,
  INVOCATION_SCHEMA,
  type IntegrityState,
  invocationRecordId,
  MIN_READER,
  OUTBOX_SCHEMA,
  outboxRecordId,
  PREPARE_QUOTA_SCHEMA,
  PROVIDER_STATE_SCHEMA,
  prepareRecordId,
  providerStateRecordId,
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
  runBindingRecordId,
  runQuotaRecordId,
  runRecordId,
  type SessionIdentityValue,
  SIGNAL_SCHEMA,
  type StoredRecord,
  sameJson,
  signalRecordId,
  stableId,
  TIMER_SCHEMA,
  taintRecordId,
  timerRecordId,
  USAGE_MIRROR_SCHEMA,
  usageMirrorRecordId,
  VISIBILITY_SCHEMA,
  visibilityRecordId,
  WAIT_SCHEMA,
  waitRecordId,
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
const INLINE_PURE_RESULT = 'inline pure result handling is not implemented'
const STAGED_RESULT = 'staged result handling is not implemented'
const BUDGET_RESERVATION = 'bounded-units and cost-hard budget reservation is not implemented'
const LIVE_AGENT_QUOTA = 'live-agent quota is not implemented'
const HOOK_RESULTS = 'hook results and approval taint acknowledgement are not implemented'
const CONTROL_COMMAND = 'control command is not implemented'
const NEW_WORK_REFUSED = 'run does not accept new work in its current state'
const SUSPENDED_RUN_STATES = ['frozen', 'migrating', 'blocked_incompatible', 'blocked_integrity']
const SIGNAL_INDEX_MISMATCH = 'signal sequence index does not match the records'
const INVOCATION_INDEX_MISMATCH = 'active invocation index does not match the records'
const QUOTA_REF_MISMATCH = 'active quota reservation does not match the held mirror'
const QUOTA_MIRROR_MISSING = 'active quota reservation has no mirror'
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

export type ApprovalAskCommand = Extract<
  CommitControlRequest['command'],
  { kind: 'authorize_action'; decision: 'ask' | 'deny' }
>
export type VerifiedApprovalAsk = {
  preparationId: string
  decision: PolicyDecision
  interaction: InteractionRecord
}

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
  reserveCommitEventId(commitId: string): string
  verifyUsageSettlement?(
    fact: UsageFact,
    receipt: Receipt,
    evidence: readonly DataRef[],
  ): { settlementRef: string | null } | undefined
  verifyRetentionPin?(pin: RetentionRef, receipt: Receipt, evidence: readonly DataRef[]): boolean
  /** Selected synchronous C24 owner verifies the complete original preparation/fingerprint, policy/Hook DataRef provenance and current authority. */
  verifyAuthorizationPreparation?(
    preparation: AuthorizationPreparation,
    action: ActionRecordValue,
    guard: CommitGuard,
  ): TrustedPolicyFacts | undefined
  /** Selected owners prove actual Policy ask and current Interaction question membership, never a self-authored DTO. */
  verifyApprovalAsk?(
    command: ApprovalAskCommand,
    action: ActionRecordValue,
    guard: CommitGuard,
  ): VerifiedApprovalAsk | undefined
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
  /** Set only while several control steps share one state-commit. Replay keys stay on each request. */
  attestedCommitId: string | null
}

function attestedCommitId(ports: ControlPorts, requested: string): string {
  return ports.attestedCommitId ?? requested
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
    if (!profiling) return JSON.parse(text) as unknown
    const started = performance.now()
    const value = JSON.parse(text) as unknown
    noteJsonParse(performance.now() - started, text.length)
    return value
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

function actionInputDigest(action: Pick<ActionValue, 'intent'>): string {
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

type StoredReceiptValue = ReceiptRecordValue

type StoredOutbox = OutboxRecord

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
  consecutive_failures: number
  next_attempt_at: number
  delivery: string
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

const INTAKE_SOURCE_SCHEMA = RuntimeMethodSchemaRefs['agh.state'].intakeReceipt.input

function intakeSourceEvidence(request: ReceiptIntakeRequest): DataRef {
  if (request.evidence.some((item) => item.schema.typeId === INTAKE_SOURCE_SCHEMA.typeId))
    refuse('invalid_input', 'receipt_intake', 'caller evidence cannot claim the accepted intake source')
  const evidence: DataRef = { ...dataRef(request), schema: INTAKE_SOURCE_SCHEMA }
  if (!validateRuntime('DataRef', evidence).ok)
    refuse('invalid_input', 'receipt_intake', 'accepted intake source cannot be represented')
  return evidence
}

function acceptedIntakeSource(stored: StoredReceiptValue): ReceiptIntakeRequest | undefined {
  const candidates = stored.evidenceRefs.filter((item) => item.schema.typeId === INTAKE_SOURCE_SCHEMA.typeId)
  if (candidates.length !== 1) return undefined
  const evidence = candidates[0]
  if (
    evidence?.kind !== 'inline' ||
    !sameJson(evidence.schema, INTAKE_SOURCE_SCHEMA) ||
    !validateRuntime('DataRef', evidence).ok ||
    evidence.digest !== digestOf(evidence.value) ||
    evidence.bytes !== Buffer.byteLength(canonicalJson(evidence.value))
  )
    integrity('accepted intake source evidence is invalid')
  const checked = validateRuntime('ReceiptIntakeRequest', evidence.value)
  if (
    !checked.ok ||
    !sameJson(checked.value.receipt, stored.receipt) ||
    !sameJson([...checked.value.evidence, evidence], stored.evidenceRefs) ||
    checked.value.evidence.some((item) => item.schema.typeId === INTAKE_SOURCE_SCHEMA.typeId)
  )
    integrity('accepted intake source evidence does not match its receipt')
  return checked.value
}

function acceptedIntakeId(head: StoredHead, request: ReceiptIntakeRequest, fingerprint: string): string {
  const stored = storedValue<StoredReceiptValue>(head)
  const source = acceptedIntakeSource(stored)
  const legacy = RuntimeStateLegacyReaders.entries.some(
    (entry) =>
      entry.targetDefinition === 'ReceiptRecordValue' && sameJson(entry.source, parseJson(head.schema_json)),
  )
    ? storedValue<Record<string, unknown>>(head)
    : undefined
  const originalIntakeId = source?.intakeId ?? legacy?.intakeId
  const originalFingerprint = source ? intakeFingerprint(source) : legacy?.contentFingerprint
  if (
    typeof originalIntakeId !== 'string' ||
    originalIntakeId.length === 0 ||
    originalFingerprint !== fingerprint ||
    (source && source.sourceAuthorizationRef !== request.sourceAuthorizationRef)
  )
    refuse('conflict', 'receipt_conflict', 'receipt was already accepted with different content')
  return originalIntakeId
}

function requireUsageSettlement(
  ports: ControlPorts,
  fact: UsageFact,
  receipt: Receipt,
  evidence: readonly DataRef[],
): string | null {
  const proof = ports.verifyUsageSettlement?.(fact, receipt, evidence)
  if (!proof) refuse('conflict', 'usage_source', 'usage settlement has no verified current source')
  return proof.settlementRef
}

function requireRetentionPin(
  ports: ControlPorts,
  pin: RetentionRef,
  receipt: Receipt,
  evidence: readonly DataRef[],
): RetentionRef {
  if (!ports.verifyRetentionPin?.(pin, receipt, evidence))
    refuse('conflict', 'retention_source', 'retention pin has no verified current source')
  return pin
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

function signalTargetKey(targetActionId: string | null): string {
  // Action ids are non-empty. An empty key is the run-level signal; NULL would not be unique in the primary key.
  return targetActionId ?? ''
}

function wholeNumber(value: unknown): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined
}

function nextSignalSeq(ports: ControlPorts, runId: string, targetActionId: string | null): number {
  const row = ports.get<{ next_seq: unknown }>(
    'SELECT next_seq FROM runtime_signal_seq WHERE run_id = ? AND target_key = ?',
    runId,
    signalTargetKey(targetActionId),
  )
  if (!row) return 1
  const seq = wholeNumber(row.next_seq)
  if (seq === undefined || seq < 1) integrity(SIGNAL_INDEX_MISMATCH)
  return seq
}

function recordAssignedSignalSeq(
  ports: ControlPorts,
  runId: string,
  targetActionId: string | null,
  seq: number,
): void {
  const next = seq + 1
  ports.run(
    `INSERT INTO runtime_signal_seq (run_id, target_key, next_seq) VALUES (?, ?, ?)
     ON CONFLICT(run_id, target_key) DO UPDATE SET next_seq = ?`,
    runId,
    signalTargetKey(targetActionId),
    next,
    next,
  )
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
       acked_epoch, attempts, consecutive_failures, next_attempt_at, delivery, ack_ref, error_json, last_owner
     ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, 0, 0, ?, 'pending', NULL, NULL, NULL)`,
    eventId,
    sessionId,
    destination,
    nextAttemptAt,
  )
}

function outboxValue(
  ports: ControlPorts,
  commitId: string,
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
    consecutiveFailures: 0,
    nextAttemptAt: stamp,
    claim: null,
    ackRef: null,
    lastError: null,
  }
}

function sourceRecordId(value: Record<string, unknown>): string | undefined {
  const source = value.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  const recordId = (source as { recordId?: unknown }).recordId
  return typeof recordId === 'string' ? recordId : undefined
}

function requireHeldMirror(
  ports: ControlPorts,
  runId: string,
  reservationId: string,
): { head: StoredHead; value: Record<string, unknown> } {
  const head = ports.loadHead(quotaRecordId(reservationId))
  if (!head) integrity(QUOTA_MIRROR_MISSING)
  const value = storedValue<Record<string, unknown>>(head)
  const scopeIds = Array.isArray(value.scopeIds) ? value.scopeIds : []
  if (
    value.reservationId !== reservationId ||
    value.kind !== 'parallel-action' ||
    value.status !== 'held' ||
    !scopeIds.includes(runId) ||
    !Number.isSafeInteger(value.quantity) ||
    (value.quantity as number) <= 0
  )
    integrity(QUOTA_REF_MISMATCH)
  return { head, value }
}

function reservationRefs(ports: ControlPorts, runId: string): { head?: StoredHead; refs: string[] } {
  const loaded = loadQuota(ports, runId)
  const refs = loaded.value?.activeQuotaReservationRefs ?? []
  if (new Set(refs).size !== refs.length) integrity(QUOTA_REF_MISMATCH)
  return loaded.head ? { head: loaded.head, refs } : { refs }
}

function releaseHeldMirrors(
  ports: ControlPorts,
  runId: string,
  actionId: string,
  stamp: string,
): RecordUpdate[] {
  const listed = reservationRefs(ports, runId)
  if (!listed.head || listed.refs.length === 0) return []
  const actionKey = actionRecordId(actionId)
  const updates: RecordUpdate[] = []
  const released: string[] = []
  for (const reservationId of listed.refs) {
    const { head, value } = requireHeldMirror(ports, runId, reservationId)
    if (sourceRecordId(value) !== actionKey) continue
    updates.push(
      updated(head, QUOTA_MIRROR_SCHEMA, ownerOf(head), { ...value, status: 'released', releasedAt: stamp }),
    )
    released.push(reservationId)
  }
  if (released.length === 0) return updates
  const quota = storedValue<RunQuotaValue>(listed.head)
  const dropping = new Set(released)
  updates.push(
    updated(listed.head, RUN_QUOTA_SCHEMA, ownerOf(listed.head), {
      ...quota,
      activeQuotaReservationRefs: listed.refs.filter((id) => !dropping.has(id)),
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
    intakeRequest?: ReceiptIntakeRequest
    actionHead?: StoredHead
    attemptHead?: StoredHead
    includeReceipt: boolean
  },
): { creates: StoredRecord[]; updates: RecordUpdate[]; sides: CommitSideEntry[] } {
  const creates: StoredRecord[] = []
  const updates: RecordUpdate[] = []
  const sides: CommitSideEntry[] = []
  const { stamp, owner, receipt } = input
  const commitId = attestedCommitId(ports, input.commitId)
  if (!sameJson(owner.authority, ports.authority))
    integrity('publication authority does not match record owner')
  if (input.includeReceipt) {
    creates.push(
      record(receiptRecordId(receipt.receiptId), RECEIPT_SCHEMA, 1, owner, {
        receipt,
        evidenceRefs: input.intakeRequest
          ? [...input.evidence, intakeSourceEvidence(input.intakeRequest)]
          : [...input.evidence],
        acceptedBy: input.acceptedBy,
        acceptedAt: stamp,
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
  const seenOrigins = new Map<string, UsageFact>()
  for (const fact of input.usage) {
    const identity = `${ports.authority.authorityId}\0${fact.originKey}`
    const seen = seenOrigins.get(identity)
    if (seen) {
      if (!sameJson(seen, fact)) refuse('conflict', 'usage_source', 'usage origin has conflicting facts')
      continue
    }
    seenOrigins.set(identity, fact)
    const usageId = stableId('use', identity)
    const existing = ports.loadHead(usageMirrorRecordId(usageId))
    if (existing) {
      if (!sameJson(storedValue<{ usage: UsageFact }>(existing).usage, fact))
        refuse('conflict', 'usage_source', 'usage origin was recorded with different content')
      continue
    }
    creates.push(
      record(usageMirrorRecordId(usageId), USAGE_MIRROR_SCHEMA, 1, owner, {
        usage: fact,
        sourceAuthorityRef: owner.authority,
        sourceEventId: ports.reserveCommitEventId(attestedCommitId(ports, commitId)),
        settlementRef: requireUsageSettlement(ports, fact, receipt, input.evidence),
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
        sourceRecordId: receiptRecordId(receipt.receiptId),
        status: 'confirmed',
        target: { kind: 'retained', retention: requireRetentionPin(ports, pin, receipt, input.evidence) },
        releaseReason: null,
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
  const seq = nextSignalSeq(ports, input.run.runId, targetActionId)
  recordAssignedSignalSeq(ports, input.run.runId, targetActionId, seq)
  const signal: Signal = {
    signalId,
    runId: input.run.runId,
    targetActionId,
    seq,
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
          attestedCommitId(ports, commitId),
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

function deliveryError(raw: string | null): RuntimeError | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    integrity('outbox error cannot be decoded')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    integrity('outbox error cannot be decoded')
  return parsed as RuntimeError
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
  const record = {
    eventId: stored.eventId,
    sourceAuthorityId: stored.sourceAuthorityId,
    sourceCommitId: stored.sourceCommitId,
    destination: stored.destination,
    typeId: stored.typeId,
    payload: stored.payload,
    fingerprint: stored.fingerprint,
    attempts: row.attempts,
    consecutiveFailures: row.consecutive_failures,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    claim,
    ackRef: row.ack_ref,
  }
  const lastError = deliveryError(row.error_json)
  if (row.delivery === 'dead') {
    if (lastError === null) integrity('outbox dead letter has no error')
    return { ...record, delivery: 'dead', lastError }
  }
  if (row.delivery !== 'pending' && row.delivery !== 'claimed' && row.delivery !== 'acked')
    integrity('outbox delivery state is unknown')
  return { ...record, delivery: row.delivery, lastError }
}

export function assertStoredOutbox(
  stored: unknown,
  row: {
    event_id: string
    delivery: string
    attempts: number
    consecutive_failures: number
    next_attempt_at: number
    active_owner: string | null
    active_epoch: number | null
    active_until: number | null
    ack_ref: string | null
    error_json: string | null
    claim_epoch: number
    acked_epoch: number | null
  },
): void {
  if (row.delivery === 'acked') {
    if (
      row.acked_epoch === null ||
      !Number.isSafeInteger(row.acked_epoch) ||
      row.acked_epoch < 1 ||
      !Number.isSafeInteger(row.claim_epoch) ||
      row.claim_epoch < 1 ||
      row.acked_epoch > row.claim_epoch
    )
      integrity('outbox acknowledgement has no claim epoch')
  }
  if (
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 0 ||
    !Number.isSafeInteger(row.consecutive_failures) ||
    row.consecutive_failures < 0 ||
    row.attempts !== row.consecutive_failures
  )
    integrity('outbox failure count does not match its attempts')
  if (row.delivery === 'dead') {
    if (row.consecutive_failures < OUTBOX_DEAD_AFTER)
      integrity('outbox dead letter is below the failure threshold')
  } else if (row.consecutive_failures >= OUTBOX_DEAD_AFTER)
    integrity('outbox failure count passed the dead-letter threshold')
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored))
    integrity('outbox record does not match its schema')
  const body = stored as StoredOutbox
  if (body.eventId !== row.event_id) integrity('outbox record does not match its schema')
  const record = assembleOutbox(body, {
    event_id: row.event_id,
    session_id: '',
    destination: body.destination,
    claim_epoch: row.claim_epoch,
    active_owner: row.active_owner,
    active_epoch: row.active_epoch,
    active_until: row.active_until,
    acked_epoch: row.acked_epoch,
    attempts: row.attempts,
    consecutive_failures: row.consecutive_failures,
    next_attempt_at: row.next_attempt_at,
    delivery: row.delivery,
    ack_ref: row.ack_ref,
    error_json: row.error_json,
    last_owner: null,
  })
  if (!validateRuntime('OutboxRecord', record).ok) integrity('outbox record does not match its schema')
}

const DELIVERY_COLUMNS = `event_id, session_id, destination, claim_epoch, active_owner, active_epoch, active_until,
  acked_epoch, attempts, consecutive_failures, next_attempt_at, delivery, ack_ref, error_json, last_owner`

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
  const active = ports.get<{ invocation_id: string }>(
    'SELECT invocation_id FROM runtime_active_invocation WHERE run_id = ?',
    request.runId,
  )
  if (active) refuse('conflict', 'invocation_state', 'an invocation is already active')
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
  ports.run(
    'INSERT INTO runtime_active_invocation (run_id, invocation_id) VALUES (?, ?)',
    request.runId,
    request.invocationId,
  )
  return rememberWrapped(
    ports,
    {
      ...blankInput(
        loaded.value.sessionId,
        verified,
        attestedCommitId(ports, ports.ulid()),
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
  const active = ports.get<{ invocation_id: string }>(
    'SELECT invocation_id FROM runtime_active_invocation WHERE run_id = ?',
    invocation.runId,
  )
  if (!active || active.invocation_id !== invocation.invocationId) integrity(INVOCATION_INDEX_MISMATCH)
  ports.run('DELETE FROM runtime_active_invocation WHERE run_id = ?', invocation.runId)
  const result: CloseInvocationResult = { invocationId: request.invocationId, state: resulting }
  return rememberWrapped(
    ports,
    {
      ...blankInput(
        loaded.value.sessionId,
        verified,
        attestedCommitId(ports, ports.ulid()),
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

const RUN_STEP_STATES = ['admitted', 'runnable', 'waiting']
const UNRESOLVED_ACTION_STATES = ['unknown', 'reconciling']

type RunStep = {
  creates: StoredRecord[]
  updates: RecordUpdate[]
  run: Partial<RunRecordValue>
  progressed: boolean
}

function runActions(ports: ControlPorts, runId: string): ActionValue[] {
  return ports
    .all<{ value_json: string }>(
      "SELECT b.value_json FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id LIKE 'action:%' AND json_extract(b.value_json,'$.runId')=?",
      runId,
    )
    .map((row) => JSON.parse(row.value_json) as ActionValue)
}

/** Refuses unless the run may complete now. Same refusal order as the supervisor completion judgement. */
function judgeRunComplete(proposed: number, actions: readonly ActionValue[]): OwnerRef[] {
  if (proposed > 0) refuse('conflict', 'complete_new_actions', 'a completing transition creates no action')
  const open = actions.filter((item) => item.intent.obligation === 'mandatory' && item.state !== 'settled')
  if (open.some((item) => UNRESOLVED_ACTION_STATES.includes(item.state)))
    refuse('conflict', 'complete_unknown', 'an action has an unresolved effect')
  if (open.some((item) => item.parentActionId !== null))
    refuse('conflict', 'complete_children', 'a child action is still open')
  if (open.length > 0) refuse('conflict', 'complete_pending', 'a mandatory action is not settled')
  const detached = actions.filter((item) => item.intent.obligation === 'detached' && item.state !== 'settled')
  if (detached.some((item) => item.ownerRef.kind !== 'job'))
    refuse('conflict', 'detached_owner_missing', 'a detached action has no owning job')
  return detached.map((item) => item.ownerRef)
}

function assertWaitTargets(
  ports: ControlPorts,
  runId: string,
  condition: WaitRecordValue['condition'],
  planned: ReadonlySet<string>,
): void {
  for (const clause of condition.anyOf) {
    if (clause.kind !== 'actions') continue
    for (const ref of clause.actions) {
      const actionId =
        'existingActionId' in ref ? ref.existingActionId : stableId('act', `${runId}\0${ref.localKey}`)
      const head = planned.has(actionId) ? undefined : ports.loadHead(actionRecordId(actionId))
      if (!planned.has(actionId) && (!head || storedValue<ActionValue>(head).runId !== runId))
        refuse('invalid_input', 'wait_action_unknown', 'a wait names an action of another run or none')
    }
  }
}

/** Closes the run's open wait and its timer; the wait id of a scheduled timer derives from its commit. */
function closeRunWait(
  ports: ControlPorts,
  run: RunRecordValue,
  consumed: readonly string[],
  outcome: 'ready' | 'cancelled',
): RecordUpdate[] {
  if (typeof run.waitId !== 'string') integrity('waiting run has no wait record')
  const head = requireHead(ports, waitRecordId(run.waitId), 'wait_absent', 'wait record does not exist')
  const wait = storedValue<WaitRecordValue>(head)
  if (wait.state !== 'waiting' || wait.runId !== run.runId)
    refuse('conflict', 'wait_state', 'wait record is not waiting for this run')
  const closed: RecordUpdate[] = [
    updated(head, WAIT_SCHEMA, ownerOf(head), {
      ...wait,
      state: outcome,
      matchedSignalIds: [...consumed],
    } satisfies WaitRecordValue),
  ]
  if (wait.condition.deadline === undefined) return closed
  const timerHead = ports.loadHead(timerRecordId(stableId('timer', wait.registeredByCommitId)))
  if (!timerHead) integrity('wait deadline has no timer record')
  const timer = storedValue<TimerRecordValue>(timerHead)
  if (timer.state === 'scheduled')
    closed.push(
      updated(timerHead, TIMER_SCHEMA, ownerOf(timerHead), {
        ...timer,
        state: 'cancelled',
      } satisfies TimerRecordValue),
    )
  return closed
}

/**
 * The run-level part of a transition: wait, complete and fail, plus resuming a waiting run. Every refusal
 * happens before anything is written. Resuming needs a consumed signal; whether the signal satisfies the wait
 * condition is not evaluated here.
 */
function planRunStep(
  ports: ControlPorts,
  request: AdvanceRunRequest,
  run: RunRecordValue,
  owner: RecordOwner,
  commitId: string,
  stamp: string,
  planned: ReadonlySet<string>,
): RunStep {
  const { transition } = request
  const next = transition.next
  const step: RunStep = { creates: [], updates: [], run: {}, progressed: false }
  if (next.kind !== 'continue' && !RUN_STEP_STATES.includes(run.state))
    refuse('conflict', 'run_state', 'run does not take this transition')
  if ((next.kind === 'wait' || next.kind === 'complete') && run.cancellation != null)
    refuse('conflict', 'run_cancelled', 'run is cancelled')
  if (run.state === 'waiting') {
    if (next.kind !== 'fail' && transition.consumeSignals.length === 0)
      refuse('conflict', 'wait_not_satisfied', 'a waiting run resumes only on consumed signals')
    step.updates.push(
      ...closeRunWait(ports, run, transition.consumeSignals, next.kind === 'fail' ? 'cancelled' : 'ready'),
    )
    step.run = { state: 'runnable', waitId: null }
  }
  if (next.kind === 'continue') return step
  step.progressed = true
  if (next.kind === 'wait') {
    assertWaitTargets(ports, run.runId, next.condition, planned)
    const waitId = stableId('wait', commitId)
    step.creates.push(
      record(waitRecordId(waitId), WAIT_SCHEMA, 1, owner, {
        waitId,
        runId: run.runId,
        targetActionId: null,
        condition: next.condition,
        registeredByCommitId: commitId,
        state: 'waiting',
        matchedSignalIds: [],
        deadlineSignalId: null,
      } satisfies WaitRecordValue),
    )
    if (next.condition.deadline !== undefined) {
      const timerId = stableId('timer', commitId)
      step.creates.push(
        record(timerRecordId(timerId), TIMER_SCHEMA, 1, owner, {
          timerId,
          runId: run.runId,
          targetActionId: null,
          waitId,
          dueAt: next.condition.deadline,
          state: 'scheduled',
          signalId: stableId('sig', `timer\0${timerId}`),
          registeredByCommitId: commitId,
          firedByCommitId: null,
        } satisfies TimerRecordValue),
      )
    }
    step.run = { state: 'waiting', waitId }
    return step
  }
  const actions = runActions(ports, run.runId)
  if (next.kind === 'complete') {
    const detachedOwnerRefs = judgeRunComplete(transition.actions.length, actions)
    const pins = new Set<string>()
    for (const pin of next.references) {
      if (pins.has(pin.pinId)) refuse('invalid_input', 'reference_duplicate', 'a reference is listed twice')
      pins.add(pin.pinId)
      const referenceId = stableId('ref', `${run.runId}\0${pin.pinId}`)
      step.creates.push(
        record(referenceRecordId(referenceId), REFERENCE_SCHEMA, 1, owner, {
          referenceId,
          sourceRecordId: runRecordId(run.runId),
          status: 'pending',
          target: { kind: 'retained', retention: pin },
          releaseReason: null,
        }),
      )
    }
    step.run = {
      ...step.run,
      state: 'succeeded',
      waitId: null,
      terminal: {
        outcome: 'succeeded',
        output: next.output,
        references: next.references,
        error: null,
        unknownActionIds: [],
        detachedOwnerRefs,
      },
    }
    return step
  }
  if (transition.actions.length > 0)
    refuse('conflict', 'fail_new_actions', 'a failing transition creates no action')
  const open = actions.filter((item) => item.state !== 'settled')
  step.run = {
    ...step.run,
    state: 'failing',
    waitId: null,
    cancellation: { reason: next.error.detailCode, requestedAt: stamp, by: request.guard.writerId },
    terminal: {
      outcome: 'failed',
      output: null,
      references: [],
      error: next.error,
      unknownActionIds: open
        .filter(
          (item) => item.intent.obligation === 'mandatory' && UNRESOLVED_ACTION_STATES.includes(item.state),
        )
        .map((item) => item.actionId),
      detachedOwnerRefs: open
        .filter((item) => item.intent.obligation === 'detached' && item.ownerRef.kind === 'job')
        .map((item) => item.ownerRef),
    },
  }
  return step
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
  const commitId = attestedCommitId(ports, request.commitId)
  assertTransition(request)
  const guarded = assertGuard(ports, request.guard, 'advance')
  const flushed = request.guard.queryUsage
    ? planQueryFlush(ports, guarded.invocation, request.guard.queryUsage)
    : undefined
  const consumed = consumeSignals(ports, request.guard.runId, request.transition.consumeSignals, commitId)
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
      createdByCommitId: commitId,
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
  if (created > 0 && !runAcceptsNewWork(guarded.value.state))
    refuse('conflict', 'run_state', NEW_WORK_REFUSED)
  const stamp = at(ports)
  const step = planRunStep(
    ports,
    request,
    guarded.value,
    guarded.owner,
    commitId,
    stamp,
    new Set(planned.map((item) => item.actionId)),
  )
  const quotaHead = requireHead(
    ports,
    runQuotaRecordId(request.guard.runId),
    'quota_absent',
    'run quota record is missing',
  )
  const quota = storedValue<RunQuotaValue>(quotaHead)
  const progressed = created > 0 || request.transition.consumeSignals.length > 0 || step.progressed
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
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      commitId,
      stamp,
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      guarded.value.revision + 1,
    ),
    actionId: actionIds.length === 1 ? (actionIds[0]?.actionId ?? null) : null,
    actionIds,
    creates: [...planned.flatMap((item) => (item.create ? [item.create] : [])), ...step.creates],
    updates: [
      updated(guarded.head, RUN_RECORD_SCHEMA, guarded.owner, {
        ...guarded.value,
        continuation: request.transition.continuation,
        revision: guarded.value.revision + 1,
        writerEpoch: request.guard.writerEpoch,
        ...step.run,
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
      ...step.updates,
    ],
    sides: [
      ...planned.flatMap((item) =>
        item.create ? [{ commitId, kind: 'action-created' as const, actionId: item.actionId }] : [],
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
  const listed = reservationRefs(ports, runId)
  let held = 0
  for (const reservationId of listed.refs) {
    const { value } = requireHeldMirror(ports, runId, reservationId)
    held += value.quantity as number
  }
  return held
}

function loadPinnedDomain(ports: ControlPorts, sessionId: string): unknown | undefined {
  const row = ports.get<{ dispatch_domain_json: string | null }>(
    'SELECT dispatch_domain_json FROM runtime_session_meta WHERE session_id = ?',
    sessionId,
  )
  return row?.dispatch_domain_json ? parseJson(row.dispatch_domain_json) : undefined
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
    'UPDATE runtime_session_meta SET dispatch_domain_json = ? WHERE session_id = ?',
    canonicalJson(domain),
    sessionId,
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
  if (!runAcceptsNewWork(run.state)) {
    if (SUSPENDED_RUN_STATES.includes(run.state)) refuse('conflict', 'run_state', NEW_WORK_REFUSED)
    return {
      kind: 'reject',
      reason: 'cancelled',
      outcome: 'cancelled',
      error: rejectionError(ports, 'cancelled', 'run_closing', 'run no longer accepts new work'),
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
  if (request.requestIdentity === null)
    refuse('incompatible', 'effects_stage_source_unavailable', 'pure stage dispatch source is unavailable')
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
  const commitId = attestedCommitId(ports, request.commitId)
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
    commitId,
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
      commitId,
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
    result = { state: 'rejected', commitId, reason: decision.reason, error: decision.error }
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
    input.sides = [{ commitId, kind: 'receipt-created', receiptId }]
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
      commitId,
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

function authorizationPreparationId(preparationId: string): string {
  return `authorization-preparation:${preparationId}`
}
function approvalAskId(actionId: string, preparationId: string): string {
  return `approval-ask:${actionId}:${preparationId}`
}
function approvalAction(
  ports: ControlPorts,
  request: CommitControlRequest,
  actionId: string,
  revision: number,
) {
  const guarded = assertGuard(ports, request.guard, 'follow')
  const head = requireHead(ports, actionRecordId(actionId), 'action_absent', 'approval action is unavailable')
  const parsed = validateRuntime('ActionRecordValue', storedValue(head))
  if (!parsed.ok || parsed.value.runId !== request.guard.runId)
    integrity('approval action original source differs')
  if (head.record_revision !== revision)
    refuse('conflict', 'action_revision', 'approval action revision differs')
  if (parsed.value.state !== 'prepared' && parsed.value.state !== 'awaiting-approval')
    refuse('conflict', 'action_state', 'approval action is no longer awaiting authorization')
  return { guarded, head, action: parsed.value, owner: ownerOf(head) }
}
function verifiedPreparationFacts(
  ports: ControlPorts,
  preparation: AuthorizationPreparation,
  action: ActionRecordValue,
  guard: CommitGuard,
): TrustedPolicyFacts {
  const source = ports.verifyAuthorizationPreparation?.(preparation, action, guard)
  const parsed = validateRuntime('TrustedPolicyFacts', source)
  if (!parsed.ok)
    refuse(
      'incompatible',
      'unproven_approval_policy',
      'original verified approval policy source is unavailable',
    )
  const facts = parsed.value
  if (
    facts.actionId !== action.actionId ||
    facts.inputDigest !== actionInputDigest(action) ||
    preparation.actionId !== action.actionId ||
    preparation.inputDigest !== facts.inputDigest ||
    preparation.approvalRequest.inputDigest !== facts.inputDigest ||
    preparation.approvalRequest.actionRef !== action.actionId ||
    !sameJson(
      preparation.approvalRequest.scope,
      ownerOf(
        requireHead(ports, actionRecordId(action.actionId), 'action_absent', 'approval action unavailable'),
      ).scope,
    ) ||
    facts.taint.runId !== guard.runId ||
    !sameJson(facts.taint.captured, action.taintSnapshot) ||
    !sameJson(facts.taint.current, taintOf(ports, guard.runId)) ||
    digestOf(facts) !==
      (preparation.policyFactsRef.kind === 'blob'
        ? preparation.policyFactsRef.blob.digest
        : preparation.policyFactsRef.digest)
  )
    refuse(
      'conflict',
      'approval_policy_source',
      'approval policy facts differ from actual action or current State cutoff',
    )
  if (
    !guard.readGuards.some(
      (item) =>
        item.recordId === taintRecordId(guard.runId) &&
        item.expectedRecordRevision === facts.taint.current.recordRevision,
    )
  )
    refuse('conflict', 'read_guard', 'approval cutoff has no original State read guard')
  return facts
}
async function approvalControlTx(
  ports: ControlPorts,
  request: CommitControlRequest,
  verified: SessionView,
  fingerprint: string,
): Promise<Committed<StateCommitReceipt>> {
  if (!validateRuntime('CommitControlRequest', request).ok)
    refuse('invalid_input', 'approval_control', 'invalid approval control request')
  const command = request.command
  if (
    command.kind !== 'prepare_authorization' &&
    !(command.kind === 'authorize_action' && command.decision === 'ask')
  )
    refuse('internal', 'unsupported', CONTROL_COMMAND)
  const loaded = approvalAction(ports, request, command.actionId, command.expectedActionRevision)
  const creates: StoredRecord[] = []
  const updates: RecordUpdate[] = []
  const flushed = request.guard.queryUsage
    ? planQueryFlush(ports, loaded.guarded.invocation, request.guard.queryUsage)
    : undefined
  if (flushed) {
    const quotaHead = requireHead(
      ports,
      runQuotaRecordId(request.guard.runId),
      'quota_absent',
      'run quota record is missing',
    )
    updates.push(
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
  if (command.kind === 'prepare_authorization') {
    const preparation = command.preparation
    if (Date.parse(preparation.approvalRequest.expiresAt) <= ports.now())
      refuse('invalid_input', 'approval_expired', 'approval question is expired')
    verifiedPreparationFacts(ports, preparation, loaded.action, request.guard)
    const id = authorizationPreparationId(preparation.preparationId),
      prior = ports.loadHead(id)
    if (prior) {
      if (
        !sameJson(parseJson(prior.schema_json), AUTHORIZATION_PREPARATION_SCHEMA) ||
        !sameJson(storedValue(prior), preparation) ||
        !sameJson(ownerOf(prior), loaded.owner)
      )
        refuse('conflict', 'idempotency_conflict', 'original approval preparation differs')
    } else creates.push(record(id, AUTHORIZATION_PREPARATION_SCHEMA, 1, loaded.owner, preparation))
  } else {
    const source = ports.verifyApprovalAsk?.(command, loaded.action, request.guard)
    // The selected owner resolves the actual question to its original preparation identity.
    if (!source)
      refuse('incompatible', 'unproven_approval_ask', 'actual approval ask authority source is unavailable')
    const interaction = validateRuntime('InteractionRecord', source.interaction),
      decision = validateRuntime('PolicyDecision', source.decision)
    if (!interaction.ok || !decision.ok || interaction.value.request.kind !== 'approval')
      integrity('approval ask source is invalid')
    const question = interaction.value.request
    if (!validateRuntime('Id', source.preparationId).ok)
      integrity('approval ask preparation identity is invalid')
    const preparationHead = requireHead(
      ports,
      authorizationPreparationId(source.preparationId),
      'approval_preparation_absent',
      'ask original preparation is unavailable',
    )
    const parsedPreparation = validateRuntime('AuthorizationPreparation', storedValue(preparationHead))
    if (
      !sameJson(parseJson(preparationHead.schema_json), AUTHORIZATION_PREPARATION_SCHEMA) ||
      !parsedPreparation.ok ||
      parsedPreparation.value.actionId !== command.actionId ||
      !sameJson(parsedPreparation.value.approvalRequest, question) ||
      !sameJson(ownerOf(preparationHead), loaded.owner)
    )
      integrity('ask differs from its original immutable preparation')
    const preparation = parsedPreparation.value
    verifiedPreparationFacts(ports, preparation, loaded.action, request.guard)
    const currentInteraction = interaction.value,
      policy = decision.value
    if (
      currentInteraction.status !== 'pending' ||
      currentInteraction.interactionId !== command.interactionId ||
      currentInteraction.owner.runId !== request.guard.runId ||
      currentInteraction.owner.actionId !== command.actionId ||
      policy.decision !== 'ask' ||
      policy.inputDigest !== preparation.inputDigest ||
      policy.validUntil !== command.validUntil ||
      Date.parse(command.validUntil) <= ports.now() ||
      Date.parse(question.expiresAt) <= ports.now() ||
      !sameJson(policy.scope, loaded.owner.scope) ||
      !sameJson(policy.approvalSpec, question) ||
      (command.decisionRef.kind === 'blob' ? command.decisionRef.blob.digest : command.decisionRef.digest) !==
        digestOf(policy)
    )
      refuse(
        'conflict',
        'approval_ask_source',
        'approval ask does not match the actual pending question or policy decision',
      )
    const id = approvalAskId(command.actionId, preparation.preparationId),
      prior = ports.loadHead(id)
    if (prior) refuse('conflict', 'approval_ask_exists', 'approval ask already exists with another request')
    creates.push(
      record(id, RuntimeMethodSchemaRefs['agh.state'].commitControl.input, 1, loaded.owner, request),
    )
    updates.push(
      updated(loaded.head, ACTION_SCHEMA, loaded.owner, { ...loaded.action, state: 'awaiting-approval' }),
    )
  }
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      attestedCommitId(ports, request.commitId),
      at(ports),
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      loaded.guarded.value.revision,
    ),
    creates,
    updates,
  })
  ports.rememberRequest('commitControl', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
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
  if (
    request.command.kind === 'prepare_authorization' ||
    (request.command.kind === 'authorize_action' && request.command.decision === 'ask')
  )
    return approvalControlTx(ports, request, verified, fingerprint)
  if (request.command.kind === 'start_composite')
    return startCompositeTx(ports, request, verified, fingerprint)
  if (request.command.kind === 'begin_drain') return beginDrainTx(ports, request, verified, fingerprint)
  if (request.command.kind === 'cancel_run') return cancelRunTx(ports, request, verified, fingerprint)
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
  const checkedRequest = validateRuntime('ReceiptIntakeRequest', request)
  if (!checkedRequest.ok)
    refuse('invalid_input', 'receipt_intake', 'receipt intake does not match its schema')
  request = checkedRequest.value
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
  if (replayed) {
    const head = requireHead(
      ports,
      receiptRecordId(request.receipt.receiptId),
      'receipt_absent',
      'accepted receipt source is missing',
    )
    const originalIntakeId = acceptedIntakeId(head, request, fingerprint)
    if (replayed.intakeId !== originalIntakeId)
      integrity('receipt replay identity differs from its original source')
    return {
      result: {
        intakeId: originalIntakeId,
        state: request.intakeId === originalIntakeId ? 'accepted' : 'duplicate',
      },
      sessionId: loaded.value.sessionId,
    }
  }
  const attemptHead = requireHead(
    ports,
    attemptRecordId(request.receipt.attemptId),
    'attempt_absent',
    'attempt does not exist',
  )
  const attempt = storedValue<AttemptValue>(attemptHead)
  const receiptHead = ports.loadHead(receiptRecordId(request.receipt.receiptId))
  if (receiptHead) {
    const originalIntakeId = acceptedIntakeId(receiptHead, request, fingerprint)
    assertLiveEpoch(ports, loaded.value.sessionId, attempt.writerEpoch)
    const original = ports.replayRequest<Remembered<ReceiptIntakeResult>>(
      'intakeReceipt',
      originalIntakeId,
      fingerprint,
    )
    if (!original || original.receipt.commitId !== receiptHead.last_commit_id)
      integrity('stored receipt intake is missing')
    ports.assertReceipt(loaded.value.sessionId, original.receipt, fingerprint)
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
    if (
      fact.actionId !== action.actionId ||
      fact.attemptId !== attempt.attemptId ||
      !request.receipt.usageRefs.includes(fact.usageId)
    )
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
    intakeRequest: request,
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
     SET delivery = 'acked', acked_epoch = ?, ack_ref = ?, active_owner = NULL, active_epoch = NULL,
         active_until = NULL, error_json = NULL
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
  const consecutiveFailures = row.consecutive_failures + 1
  const dead = consecutiveFailures >= OUTBOX_DEAD_AFTER
  const delay = Math.min(OUTBOX_BACKOFF_CAP_MS, 1_000 * 2 ** (attempts - 1))
  const nextAt = ports.now() + delay
  ports.run(
    `UPDATE runtime_outbox_delivery
     SET delivery = ?, attempts = ?, consecutive_failures = ?, next_attempt_at = ?, active_owner = NULL,
         active_epoch = NULL, active_until = NULL, error_json = ?, last_owner = ?
     WHERE event_id = ?`,
    dead ? 'dead' : 'pending',
    attempts,
    consecutiveFailures,
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
  reservationId: string
}

type RunQuotaNote = { revision: number; refs: string[] | undefined }

type SignalHeadNote = { revision: number; runId: string; targetKey: string; seq: number }

type InvocationHeadNote = { revision: number; runId: string; invocationId: string; state: string }

type AdmissionNote = {
  revision: number
  commitId: string
  admissionId: string
  requestFingerprint: string
  result: DispatchAdmissionResult
}

type ReceiptOutcome = {
  outcome: string
  actionId: string
  attemptId: string
  producer: unknown
  authorityId: string
  errorCode: string | null
}

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
  actionStates: Map<string, { actionId: string; state: string }[]>
  admissions: Map<string, AdmissionNote>
  quotas: Map<string, QuotaNote>
  views: Map<string, ViewNote>
  interactionSources: Map<string, { record: InteractionRecord; owner: RecordOwner; commitId: string }>
  approvalInboxes: Map<string, { recordId: string; value: InboxRecord; owner: RecordOwner; commitId: string }>
  approvalSignals: Map<string, { signal: Signal; owner: RecordOwner; commitId: string }>
  signalsByReceipt: Set<string>
  signalSources: Map<string, { receiptId: string; commitId: string; authorityId: string; signal: Signal }>
  outboxSources: Map<
    string,
    { receiptId: string; commitId: string; authorityId: string; value: StoredOutbox }
  >
  signalConsumed: Map<string, number>
  outboxes: Map<string, string>
  outboxSides: Map<string, string>
  usages: Map<string, string>
  usageSides: Map<string, string>
  usageSideCount: Map<string, number>
  signalHeads: Map<string, SignalHeadNote>
  invocations: Map<string, InvocationHeadNote>
  runQuotas: Map<string, RunQuotaNote>
}

export type ControlVersionNote = {
  record_id: string
  record_revision: number
  commit_id: string
  value_json: string
  owner_json?: string
  event_id?: string
}

export type ControlEvidence = {
  sessionId: string
  requests(): { request_id: string; fingerprint: string; result_json: string }[]
  domainJson(): string | undefined
  signalSeqIndex(): { run_id: string; target_key: string; next_seq: unknown }[]
  activeInvocations(): { run_id: string; invocation_id: string }[]
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
    interactionSources: new Map(),
    approvalInboxes: new Map(),
    approvalSignals: new Map(),
    signalsByReceipt: new Set(),
    signalSources: new Map(),
    outboxSources: new Map(),
    signalConsumed: new Map(),
    outboxes: new Map(),
    outboxSides: new Map(),
    usages: new Map(),
    usageSides: new Map(),
    usageSideCount: new Map(),
    signalHeads: new Map(),
    invocations: new Map(),
    runQuotas: new Map(),
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
  if (id.startsWith('interaction:')) noteApprovalInteractionVersion(scan, version)
  else if (id.startsWith('approval-inbox-')) noteApprovalInboxVersion(scan, version)
  else if (id.startsWith('action:')) noteActionVersion(scan, version)
  else if (id.startsWith('attempt:')) noteAttemptVersion(scan, version)
  else if (id.startsWith('dispatch:')) noteAdmissionVersion(scan, version)
  else if (id.startsWith('receipt:')) noteReceiptVersion(scan, version)
  else if (id.startsWith('quota:')) noteQuotaVersion(scan, version)
  else if (id.startsWith('run-quota:')) noteRunQuotaVersion(scan, version)
  else if (id.startsWith('invocation:')) noteInvocationVersion(scan, version)
  else if (id.startsWith('visibility:')) noteVisibilityVersion(scan, version)
  else if (id.startsWith('signal:')) noteSignalVersion(scan, version)
  else if (id.startsWith('outbox:')) noteOutboxVersion(scan, version)
  else if (id.startsWith('usage:')) noteUsageVersion(scan, version)
  else if (id.startsWith('provider:')) noteProviderStateVersion(version)
  else if (id.startsWith('wait:')) noteWaitVersion(version)
  else if (id.startsWith('timer:')) noteTimerVersion(version)
}

const PROVIDER_STATES = ['runnable', 'waiting', 'draining', 'completed', 'failed']
const WAIT_STATES = ['waiting', 'ready', 'cancelled']
const TIMER_STATES = ['scheduled', 'fired', 'cancelled']
const NEW_WORK_RUN_STATES = ['admitted', 'runnable', 'waiting']

/** True when a run in this state may still take new actions. The drain gate of every path that creates or starts work. */
export function runAcceptsNewWork(state: string): boolean {
  return NEW_WORK_RUN_STATES.includes(state)
}

function noteProviderStateVersion(version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const actionId = typeof body.actionId === 'string' ? body.actionId : ''
  const state = typeof body.state === 'string' ? body.state : ''
  if (actionId === '' || version.record_id !== providerStateRecordId(actionId))
    integrity('provider state record id does not match its action')
  if (!PROVIDER_STATES.includes(state)) integrity('provider state is not a known state')
  if ((state === 'waiting') !== (body.waitId !== null))
    integrity('provider state wait does not match its state')
}

function noteWaitVersion(version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const waitId = typeof body.waitId === 'string' ? body.waitId : ''
  if (waitId === '' || version.record_id !== waitRecordId(waitId))
    integrity('wait record id does not match its wait')
  if (typeof body.runId !== 'string' || body.runId === '') integrity('wait record has no run')
  if (typeof body.state !== 'string' || !WAIT_STATES.includes(body.state))
    integrity('wait record is not in a known state')
  if (!Array.isArray(body.matchedSignalIds)) integrity('wait record has no matched signals')
}

function noteTimerVersion(version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const timerId = typeof body.timerId === 'string' ? body.timerId : ''
  if (timerId === '' || version.record_id !== timerRecordId(timerId))
    integrity('timer record id does not match its timer')
  if (typeof body.runId !== 'string' || body.runId === '') integrity('timer record has no run')
  if (typeof body.state !== 'string' || !TIMER_STATES.includes(body.state))
    integrity('timer record is not in a known state')
  if ((body.state === 'fired') !== (body.firedByCommitId !== null))
    integrity('timer record fire commit does not match its state')
}

function noteActionVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const actionId = typeof body.actionId === 'string' ? body.actionId : ''
  const state = typeof body.state === 'string' ? body.state : ''
  const states = scan.actionStates.get(version.commit_id) ?? []
  states.push({ actionId, state })
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
    attemptId: typeof receiptRecord?.attemptId === 'string' ? receiptRecord.attemptId : '',
    producer: objectRecord(receiptRecord?.provenance)?.producer,
    authorityId: version.owner_json
      ? (parseJson(version.owner_json) as RecordOwner).authority.authorityId
      : '',
    errorCode: errorCodeOf(receiptRecord?.error),
  })
}

function stringRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const refs: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    refs.push(item)
  }
  return refs
}

function noteQuotaVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  noteLatest(scan.quotas, version.record_id, {
    revision: version.record_revision,
    status: typeof body.status === 'string' ? body.status : '',
    kind: typeof body.kind === 'string' ? body.kind : '',
    requestFingerprint: typeof body.requestFingerprint === 'string' ? body.requestFingerprint : '',
    scopeIds: textList(body.scopeIds),
    reservationId: typeof body.reservationId === 'string' ? body.reservationId : '',
  })
}

function noteRunQuotaVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const runId = typeof body.runId === 'string' ? body.runId : ''
  noteLatest(scan.runQuotas, runId === '' ? version.record_id : runId, {
    revision: version.record_revision,
    refs: stringRefs(body.activeQuotaReservationRefs),
  })
}

function noteInvocationVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  noteLatest(scan.invocations, version.record_id, {
    revision: version.record_revision,
    runId: typeof body.runId === 'string' ? body.runId : '',
    invocationId: typeof body.invocationId === 'string' ? body.invocationId : '',
    state: typeof body.state === 'string' ? body.state : '',
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

function inlineSourcePayload(value: unknown): Record<string, unknown> {
  const checked = validateRuntime('DataRef', value)
  if (
    !checked.ok ||
    checked.value.kind !== 'inline' ||
    checked.value.digest !== digestOf(checked.value.value) ||
    checked.value.bytes !== Buffer.byteLength(canonicalJson(checked.value.value))
  )
    integrity('publication source payload is not a canonical inline reference')
  const body = objectRecord(checked.value.value)
  if (!body) integrity('publication source payload is not an object')
  return body
}

function sourceAuthority(version: ControlVersionNote): string {
  if (!version.owner_json) integrity('publication source has no physical owner')
  const checked = validateRuntime('RecordOwner', parseJson(version.owner_json))
  if (!checked.ok) integrity('publication source owner is invalid')
  return checked.value.authority.authorityId
}

function approvalVersionOwner(version: ControlVersionNote): RecordOwner {
  if (!version.owner_json) integrity('approval source has no physical owner')
  const owner = validateRuntime('RecordOwner', parseJson(version.owner_json))
  if (!owner.ok) integrity('approval source owner is invalid')
  return owner.value
}
function noteApprovalInteractionVersion(scan: ControlScan, version: ControlVersionNote): void {
  const checked = validateRuntime('InteractionRecord', parseJson(version.value_json))
  if (!checked.ok || version.record_id !== `interaction:${checked.value.interactionId}`)
    integrity('approval domain source record identity differs')
  const key = `${checked.value.interactionId}@${checked.value.version}`,
    prior = scan.interactionSources.get(key)
  if (prior && (prior.commitId !== version.commit_id || !sameJson(prior.record, checked.value)))
    integrity('approval domain version has conflicting original sources')
  scan.interactionSources.set(key, {
    record: checked.value,
    owner: approvalVersionOwner(version),
    commitId: version.commit_id,
  })
}
function noteApprovalInboxVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) integrity('approval inbox immutable source was rewritten')
  const checked = validateRuntime('InboxRecord', parseJson(version.value_json))
  if (!checked.ok || checked.value.appliedCommitId !== version.commit_id)
    integrity('approval inbox source commit differs')
  if (scan.approvalInboxes.has(version.record_id)) integrity('approval inbox source is duplicated')
  scan.approvalInboxes.set(version.record_id, {
    recordId: version.record_id,
    value: checked.value,
    owner: approvalVersionOwner(version),
    commitId: version.commit_id,
  })
}

function noteSignalVersion(scan: ControlScan, version: ControlVersionNote): void {
  const body = bodyRecord(version.value_json)
  const signal = objectRecord(body.signal)
  if (version.record_revision === 1) {
    const payload = inlineSourcePayload(signal?.payload)
    if (sameJson(signal?.schema, INTERACTION_SCHEMA)) {
      const checked = validateRuntime('Signal', signal),
        interaction = validateRuntime('InteractionRecord', payload)
      if (
        !checked.ok ||
        !interaction.ok ||
        !sameJson(checked.value.payload.schema, INTERACTION_SCHEMA) ||
        checked.value.typeId !== INTERACTION_SCHEMA.typeId ||
        version.record_id !== signalRecordId(checked.value.signalId)
      )
        integrity('approval wake signal source is invalid')
      scan.approvalSignals.set(version.record_id, {
        signal: checked.value,
        owner: approvalVersionOwner(version),
        commitId: version.commit_id,
      })
    } else {
      const receiptId = typeof payload.receiptId === 'string' ? payload.receiptId : ''
      if (receiptId === '' || (body.sourceReceiptId !== undefined && body.sourceReceiptId !== receiptId))
        integrity('signal source receipt does not match its payload')
      const checked = validateRuntime('Signal', signal)
      if (!checked.ok || version.record_id !== signalRecordId(checked.value.signalId))
        integrity('signal source record is invalid')
      scan.signalsByReceipt.add(receiptId)
      scan.signalSources.set(version.record_id, {
        receiptId,
        commitId: version.commit_id,
        authorityId: sourceAuthority(version),
        signal: checked.value,
      })
    }
  }
  const target = signal?.targetActionId
  const seq = wholeNumber(signal?.seq)
  noteLatest(scan.signalHeads, version.record_id, {
    revision: version.record_revision,
    runId: typeof signal?.runId === 'string' ? signal.runId : '',
    targetKey: typeof target === 'string' ? target : '',
    seq: seq ?? 0,
  })
}

function noteOutboxVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) return
  const body = bodyRecord(version.value_json)
  const eventId = typeof body.eventId === 'string' ? body.eventId : version.record_id.slice('outbox:'.length)
  scan.outboxes.set(eventId, version.commit_id)
  const payload = inlineSourcePayload(body.payload)
  const receiptId = typeof payload.receiptId === 'string' ? payload.receiptId : ''
  if (
    receiptId === '' ||
    body.sourceCommitId !== version.commit_id ||
    (body.sourceReceiptId !== undefined && body.sourceReceiptId !== receiptId) ||
    body.fingerprint !== digestOf(payload)
  )
    integrity('outbox source receipt does not match its payload')
  scan.outboxSources.set(eventId, {
    receiptId,
    commitId: version.commit_id,
    authorityId: sourceAuthority(version),
    value: body as StoredOutbox,
  })
}

function noteUsageVersion(scan: ControlScan, version: ControlVersionNote): void {
  if (version.record_revision !== 1) return
  const body = bodyRecord(version.value_json)
  const authority = objectRecord(body.sourceAuthorityRef)
  const usage = objectRecord(body.usage)
  const authorityId =
    typeof authority?.authorityId === 'string'
      ? authority.authorityId
      : typeof body.sourceAuthorityId === 'string'
        ? body.sourceAuthorityId
        : ''
  if (authority && (body.sourceEventId !== version.event_id || authorityId !== sourceAuthority(version)))
    integrity('usage source is not its actual State event')
  const originKey =
    typeof usage?.originKey === 'string'
      ? usage.originKey
      : typeof body.originKey === 'string'
        ? body.originKey
        : ''
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

function receiptIdsForAction(scan: ControlScan, commitId: string, actionId: string): string[] {
  const found: string[] = []
  for (const [receiptId, sideCommit] of scan.receiptSides) {
    if (sideCommit !== commitId) continue
    if (scan.receiptOutcomes.get(receiptId)?.actionId === actionId) found.push(receiptId)
  }
  return found
}

function assertRejectionPublished(scan: ControlScan, commitId: string, receiptId: string | undefined): void {
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
  for (const source of scan.approvalSignals.values()) {
    const signal = source.signal,
      payload = validateRuntime('InteractionRecord', inlineSourcePayload(signal.payload))
    if (!payload.ok || payload.value.status !== 'answered')
      integrity('approval wake has no actual answered domain source')
    const record = payload.value,
      key = `${record.interactionId}@${record.version}`,
      domain = scan.interactionSources.get(key)
    if (
      !domain ||
      domain.commitId !== source.commitId ||
      !sameJson(domain.record, record) ||
      signal.causation.interactionId !== record.interactionId ||
      signal.causation.externalEventId !== key ||
      signal.causation.actionId !== record.owner.actionId ||
      signal.targetActionId !== record.owner.actionId ||
      signal.runId !== record.owner.runId ||
      !sameJson(signal.source, domain.owner.ownerBinding)
    )
      integrity('approval wake differs from its original Interaction domain commit')
    const consumerId = source.owner.ownerBinding.bindingId
    const inboxId = stableId(
        'approval-inbox',
        canonicalJson({
          authority: domain.owner.authority,
          binding: domain.owner.ownerBinding,
          scope: domain.owner.scope,
          id: key,
        }),
      ),
      inbox = scan.approvalInboxes.get(inboxId)
    const fingerprint = digestOf({
      deliveryKey: key,
      interactionId: record.interactionId,
      owner: record.owner,
      version: record.version,
      status: record.status,
      responseId: record.resolution.responseId,
    })
    if (
      !inbox ||
      inbox.commitId !== source.commitId ||
      !sameJson(inbox.owner, source.owner) ||
      inbox.value.sourceAuthorityId !== domain.owner.authority.authorityId ||
      inbox.value.eventId !== key ||
      inbox.value.consumerId !== consumerId ||
      inbox.value.fingerprint !== fingerprint ||
      !sameJson(inbox.value.acknowledgement, signal.payload) ||
      signal.signalId !==
        stableId(
          'approval-signal',
          canonicalJson({ sourceAuthorityId: domain.owner.authority.authorityId, eventId: key, consumerId }),
        )
    )
      integrity('approval wake has no matching original inbox application proof')
  }

  for (const source of scan.signalSources.values()) {
    const receipt = scan.receiptOutcomes.get(source.receiptId)
    const signal = source.signal
    const targetKey = signal.targetActionId === null ? 'run' : signal.targetActionId
    if (
      !receipt ||
      scan.receiptSides.get(source.receiptId) !== source.commitId ||
      receipt.authorityId !== source.authorityId ||
      signal.signalId !== stableId('sig', `${source.authorityId}\0${source.receiptId}\0${targetKey}`) ||
      signal.causation.actionId !== receipt.actionId ||
      signal.causation.attemptId !== receipt.attemptId ||
      !sameJson(signal.source, receipt.producer) ||
      !sameJson(signal.schema, signal.payload.schema) ||
      inlineSourcePayload(signal.payload).outcome !== receipt.outcome
    )
      integrity('signal source is not the receipt in its original commit')
  }
  for (const [eventId, source] of scan.outboxSources) {
    const receipt = scan.receiptOutcomes.get(source.receiptId),
      value = source.value
    const payload = inlineSourcePayload(value.payload)
    const suffix =
      value.typeId === RESULT_TYPE
        ? `result\0${source.receiptId}`
        : value.typeId === STREAM_END_TYPE && typeof payload.streamId === 'string'
          ? `stream-end\0${source.receiptId}\0${payload.streamId}`
          : undefined
    if (
      !receipt ||
      scan.receiptSides.get(source.receiptId) !== source.commitId ||
      receipt.authorityId !== source.authorityId ||
      value.sourceAuthorityId !== source.authorityId ||
      suffix === undefined ||
      eventId !== stableId('obx', `${source.commitId}\0${suffix}`) ||
      value.destination !== stableId('obxdst', source.authorityId) ||
      (value.typeId === RESULT_TYPE &&
        (payload.actionId !== receipt.actionId ||
          payload.attemptId !== receipt.attemptId ||
          payload.outcome !== receipt.outcome)) ||
      (value.typeId === STREAM_END_TYPE && payload.status !== receipt.outcome)
    )
      integrity('outbox source is not the receipt in its original commit')
  }
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

function assertQuotaReservations(scan: ControlScan): void {
  const heldByRun = new Map<string, Set<string>>()
  const heldIds = new Set<string>()
  for (const quota of scan.quotas.values()) {
    if (quota.kind !== 'parallel-action' || quota.status !== 'held') continue
    if (quota.reservationId === '' || heldIds.has(quota.reservationId) || quota.scopeIds.length === 0)
      integrity(QUOTA_REF_MISMATCH)
    heldIds.add(quota.reservationId)
    for (const runId of quota.scopeIds) {
      const set = heldByRun.get(runId) ?? new Set<string>()
      set.add(quota.reservationId)
      heldByRun.set(runId, set)
    }
  }
  const referenced = new Set<string>()
  for (const [runId, quota] of scan.runQuotas) {
    if (!quota.refs) integrity(QUOTA_REF_MISMATCH)
    const unique = new Set(quota.refs)
    if (unique.size !== quota.refs.length) integrity(QUOTA_REF_MISMATCH)
    const expected = heldByRun.get(runId) ?? new Set<string>()
    if (unique.size !== expected.size) integrity(QUOTA_REF_MISMATCH)
    for (const id of unique) {
      if (!expected.has(id)) integrity(QUOTA_REF_MISMATCH)
      referenced.add(id)
    }
    heldByRun.delete(runId)
  }
  if (heldByRun.size > 0) integrity(QUOTA_REF_MISMATCH)
  for (const id of heldIds) {
    if (!referenced.has(id)) integrity(QUOTA_REF_MISMATCH)
  }
}

function assertSignalSeq(scan: ControlScan, evidence: ControlEvidence): void {
  const expected = new Map<string, SignalHeadNote>()
  for (const note of scan.signalHeads.values()) {
    if (note.runId === '' || note.seq < 1) integrity(SIGNAL_INDEX_MISMATCH)
    const key = `${note.runId}\0${note.targetKey}`
    const current = expected.get(key)
    if (!current || note.seq > current.seq) expected.set(key, note)
  }
  const rows = evidence.signalSeqIndex()
  if (rows.length !== expected.size) integrity(SIGNAL_INDEX_MISMATCH)
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.run_id}\0${row.target_key}`
    const next = wholeNumber(row.next_seq)
    const match = expected.get(key)
    if (seen.has(key) || next === undefined || !match || next !== match.seq + 1)
      integrity(SIGNAL_INDEX_MISMATCH)
    seen.add(key)
  }
}

function assertActiveInvocations(scan: ControlScan, evidence: ControlEvidence): void {
  const expected = new Map<string, string>()
  for (const note of scan.invocations.values()) {
    if (note.state !== 'active') continue
    if (note.runId === '' || note.invocationId === '' || expected.has(note.runId))
      integrity(INVOCATION_INDEX_MISMATCH)
    expected.set(note.runId, note.invocationId)
  }
  const rows = evidence.activeInvocations()
  if (rows.length !== expected.size) integrity(INVOCATION_INDEX_MISMATCH)
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.run_id) || expected.get(row.run_id) !== row.invocation_id)
      integrity(INVOCATION_INDEX_MISMATCH)
    seen.add(row.run_id)
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
        const actionId = typeof stored.request.actionId === 'string' ? stored.request.actionId : ''
        const states = (scan.actionStates.get(admission.commitId) ?? []).filter(
          (item) => item.actionId === actionId,
        )
        const attempts = (scan.attemptsOnCommit.get(admission.commitId) ?? []).filter(
          (attempt) => attempt.actionId === actionId,
        )
        const controls = attempts.filter((attempt) => attempt.kind === 'control' && attempt.number === 0)
        const executing = attempts.filter((attempt) => attempt.number >= 1)
        const receiptIds = receiptIdsForAction(scan, admission.commitId, actionId)
        if (
          actionId === '' ||
          states.length !== 1 ||
          states[0]?.state !== 'settled' ||
          controls.length !== 1 ||
          executing.length !== 0 ||
          receiptIds.length !== 1
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
        assertRejectionPublished(scan, admission.commitId, receiptIds[0])
      }
    }
  }
  assertPublication(scan)
  assertQuotaReservations(scan)
  assertSignalSeq(scan, evidence)
  assertActiveInvocations(scan, evidence)
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

const PROVIDER_COMPLETION = 'complete and fail transitions of a composite provider are not accepted yet'
const PROVIDER_DEADLINE = 'a composite provider wait with a deadline is not accepted yet'

function compositeTarget(ports: ControlPorts, runId: string, action: ActionValue) {
  const binding = storedValue<RunBinding>(
    requireHead(ports, runBindingRecordId(runId), 'binding_absent', 'run binding record is missing'),
  )
  const targets = binding.providers.filter((candidate) => sameJson(candidate.binding, action.intent.target))
  const target = targets[0]
  if (targets.length !== 1 || !target)
    refuse('invalid_input', 'composite_target', 'action target is not one provider of the run binding')
  const operations = target.descriptor.operations.filter(
    (operation) => operation.method === action.intent.method,
  )
  if (
    operations.length !== 1 ||
    operations[0]?.kind !== 'action' ||
    target.descriptor.stateCodecs.length === 0
  )
    refuse('invalid_input', 'composite_target', 'action target does not declare a composite method')
  return target
}

/** Starts a composite parent: its composite attempt and revision-zero provider state in one commit. */
async function startCompositeTx(
  ports: ControlPorts,
  request: CommitControlRequest,
  verified: SessionView,
  fingerprint: string,
): Promise<Committed<StateCommitReceipt>> {
  const command = request.command
  if (command.kind !== 'start_composite') refuse('internal', 'unsupported', CONTROL_COMMAND)
  const guarded = assertGuard(ports, request.guard, 'follow')
  if (!runAcceptsNewWork(guarded.value.state)) refuse('conflict', 'run_state', NEW_WORK_REFUSED)
  if (guarded.value.cancellation != null) refuse('conflict', 'run_cancelled', 'run is cancelled')
  const actionHead = ports.loadHead(actionRecordId(command.actionId))
  if (!actionHead || actionHead.record_revision !== command.expectedActionRevision)
    refuse('conflict', 'action_state', 'action state does not match the start')
  const action = storedValue<ActionValue>(actionHead)
  if (
    action.state !== 'prepared' ||
    action.currentAttemptId !== null ||
    action.providerStateId !== null ||
    action.runId !== request.guard.runId
  )
    refuse('conflict', 'action_state', 'action state does not match the start')
  if (ports.loadHead(attemptRecordId(command.attemptId)))
    refuse('conflict', 'attempt_exists', 'attempt already exists')
  if (ports.loadHead(providerStateRecordId(action.actionId)))
    refuse('conflict', 'provider_exists', 'provider state already exists')
  compositeTarget(ports, request.guard.runId, action)
  const stamp = at(ports)
  const owner = ownerOf(actionHead)
  const attempt: AttemptValue = {
    attemptId: command.attemptId,
    actionId: action.actionId,
    number: 1,
    kind: 'composite',
    bindingId: request.guard.bindingId,
    inputDigest: actionInputDigest(action),
    state: 'running',
    requestIdentity: null,
    externalRequests: [],
    authorizationRef: null,
    budgetReservationRefs: [],
    streamIds: [],
    startedAt: stamp,
    executeDeadline: null,
    finishedAt: null,
    receiptIds: [],
    writerEpoch: request.guard.writerEpoch,
  }
  const provider: ProviderStateValue = {
    actionId: action.actionId,
    providerRevision: 0,
    state: 'runnable',
    continuation: null,
    waitId: null,
    writerEpoch: request.guard.writerEpoch,
    termination: null,
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
    creates: [
      record(attemptRecordId(command.attemptId), ATTEMPT_SCHEMA, 1, owner, attempt),
      record(providerStateRecordId(action.actionId), PROVIDER_STATE_SCHEMA, 1, owner, provider),
    ],
    updates: [
      updated(actionHead, ACTION_SCHEMA, owner, {
        ...action,
        state: 'running',
        currentAttemptId: command.attemptId,
        providerStateId: providerStateRecordId(action.actionId),
      }),
    ],
  })
  ports.rememberRequest('commitControl', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}

function assertProviderTransition(request: AdvanceProviderRequest): void {
  const transition = request.transition
  if (transition.expectedProviderRevision !== request.expectedProviderRevision)
    refuse('invalid_input', 'provider_revision', 'the request and the transition name different revisions')
  if (new Set(transition.consumeSignals).size !== transition.consumeSignals.length)
    refuse('invalid_input', 'signal_duplicate', 'signal is listed more than once')
  if (transition.next.kind !== 'continue' && transition.next.kind !== 'wait')
    refuse('internal', 'unsupported', PROVIDER_COMPLETION)
  if (transition.next.kind === 'wait' && transition.next.condition.deadline !== undefined)
    refuse('internal', 'unsupported', PROVIDER_DEADLINE)
  if (transition.children.length > MAX_ACTIONS)
    refuse('invalid_input', 'action_count', 'a transition has too many actions')
  if (new Set(transition.children.map((child) => child.key)).size !== transition.children.length)
    refuse('invalid_input', 'child_key_duplicate', 'a child key is listed more than once')
  if (Buffer.byteLength(canonicalJson(transition.continuation)) > MAX_CONTINUATION_BYTES)
    refuse('invalid_input', 'continuation', 'continuation is too large')
}

/**
 * One commit for a composite parent step: provider revision plus one, the continuation, the children, the
 * consumed signals and the wait. The run revision does not move.
 */
export async function advanceProviderTx(
  ports: ControlPorts,
  request: AdvanceProviderRequest,
): Promise<Committed<StateCommitReceipt>> {
  const verified = await ports.requireSession(request.guard.sessionId)
  const fingerprint = digestOf({
    guard: request.guard,
    actionId: request.actionId,
    expectedProviderRevision: request.expectedProviderRevision,
    transition: request.transition,
  })
  const stored = ports.replayRequest<StateCommitReceipt>('advanceProvider', request.commitId, fingerprint)
  if (stored) {
    ports.assertReceipt(request.guard.sessionId, stored, fingerprint)
    return { result: stored, sessionId: request.guard.sessionId }
  }
  const commitId = attestedCommitId(ports, request.commitId)
  assertProviderTransition(request)
  const guarded = assertGuard(ports, request.guard, 'advance')
  if (guarded.invocation.targetActionId !== request.actionId)
    refuse('conflict', 'invocation_target', 'invocation does not target this composite parent')
  if (guarded.value.cancellation != null) refuse('conflict', 'run_cancelled', 'run is cancelled')
  const parentHead = requireHead(
    ports,
    actionRecordId(request.actionId),
    'action_state',
    'action does not exist',
  )
  const parent = storedValue<ActionValue>(parentHead)
  if (parent.runId !== request.guard.runId || parent.state !== 'running' || parent.currentAttemptId === null)
    refuse('conflict', 'action_state', 'action is not a running composite parent')
  const attempt = storedValue<AttemptValue>(
    requireHead(ports, attemptRecordId(parent.currentAttemptId), 'attempt_absent', 'attempt does not exist'),
  )
  if (attempt.kind !== 'composite' || attempt.state !== 'running' || attempt.actionId !== parent.actionId)
    refuse('conflict', 'attempt_state', 'attempt is not the running composite attempt')
  const providerHead = requireHead(
    ports,
    providerStateRecordId(parent.actionId),
    'provider_absent',
    'provider state does not exist',
  )
  const provider = storedValue<ProviderStateValue>(providerHead)
  if (provider.providerRevision !== request.expectedProviderRevision)
    refuse('conflict', 'provider_revision', 'provider revision does not match')
  if (provider.state !== 'runnable' && provider.state !== 'waiting')
    refuse('conflict', 'provider_state', 'provider state does not take a transition')
  const target = compositeTarget(ports, request.guard.runId, parent)
  const continuation = request.transition.continuation
  if (
    !target.descriptor.stateCodecs.some(
      (codec) =>
        codec.namespace === continuation.namespace && codec.codecVersion === continuation.codecVersion,
    )
  )
    refuse('invalid_input', 'continuation_codec', 'continuation codec is not declared by the provider')
  for (const signalId of request.transition.consumeSignals) {
    const head = ports.loadHead(signalRecordId(signalId))
    if (head && storedValue<SignalRecordValue>(head).signal.targetActionId !== parent.actionId)
      refuse('conflict', 'signal_absent', 'signal does not exist')
  }
  const consumed = consumeSignals(ports, request.guard.runId, request.transition.consumeSignals, commitId)
  const flushed = request.guard.queryUsage
    ? planQueryFlush(ports, guarded.invocation, request.guard.queryUsage)
    : undefined
  const creates: StoredRecord[] = []
  const updates: RecordUpdate[] = []
  let resumedWait: StoredHead | undefined
  if (provider.state === 'waiting') {
    if (provider.waitId === null || request.transition.consumeSignals.length === 0)
      refuse('conflict', 'wait_not_satisfied', 'a waiting provider resumes only on consumed signals')
    resumedWait = requireHead(
      ports,
      waitRecordId(provider.waitId),
      'wait_absent',
      'wait record does not exist',
    )
    const previous = storedValue<WaitRecordValue>(resumedWait)
    if (previous.state !== 'waiting' || previous.targetActionId !== parent.actionId)
      refuse('conflict', 'wait_state', 'wait record is not waiting for this parent')
    updates.push(
      updated(resumedWait, WAIT_SCHEMA, ownerOf(resumedWait), {
        ...previous,
        state: 'ready',
        matchedSignalIds: request.transition.consumeSignals,
      } satisfies WaitRecordValue),
    )
  }
  const planned: { key: string; actionId: string; created: boolean }[] = []
  const snapshot = taintOf(ports, request.guard.runId)
  for (const child of request.transition.children) {
    const childFingerprint = actionFingerprint(child)
    const childId = stableId('act', `${request.guard.runId}\0${parent.actionId}\0${child.key}`)
    const existing = ports.loadHead(actionRecordId(childId))
    if (existing) {
      if (storedValue<ActionValue>(existing).intentFingerprint !== childFingerprint)
        refuse('conflict', 'intent_fingerprint', 'action intent fingerprint does not match')
      planned.push({ key: child.key, actionId: childId, created: false })
      continue
    }
    planned.push({ key: child.key, actionId: childId, created: true })
    creates.push(
      record(actionRecordId(childId), ACTION_SCHEMA, 1, guarded.owner, {
        actionId: childId,
        runId: request.guard.runId,
        parentActionId: parent.actionId,
        key: child.key,
        intent: child,
        intentFingerprint: childFingerprint,
        state: 'prepared',
        currentAttemptId: null,
        providerStateId: null,
        firstReceiptId: null,
        resolvedReceiptId: null,
        resolutionId: null,
        ownerRef: { kind: 'action', id: parent.actionId },
        createdByCommitId: commitId,
        resultHookPlan: null,
        taintSnapshot: snapshot,
        authorizationTaintSnapshot: null,
      } satisfies ActionValue),
    )
  }
  if (planned.some((item) => item.created) && !runAcceptsNewWork(guarded.value.state))
    refuse('conflict', 'run_state', NEW_WORK_REFUSED)
  const next = request.transition.next
  let waitId: string | null = null
  if (next.kind === 'wait') {
    waitId = stableId('wait', commitId)
    creates.push(
      record(waitRecordId(waitId), WAIT_SCHEMA, 1, guarded.owner, {
        waitId,
        runId: request.guard.runId,
        targetActionId: parent.actionId,
        condition: next.condition,
        registeredByCommitId: commitId,
        state: 'waiting',
        matchedSignalIds: [],
        deadlineSignalId: null,
      } satisfies WaitRecordValue),
    )
  }
  const createdCount = creates.filter((item) => item.recordId.startsWith('action:')).length
  const quotaHead = requireHead(
    ports,
    runQuotaRecordId(request.guard.runId),
    'quota_absent',
    'run quota record is missing',
  )
  const quota = storedValue<RunQuotaValue>(quotaHead)
  const progressed = createdCount > 0 || request.transition.consumeSignals.length > 0 || waitId !== null
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
  const lastCreated = planned.filter((item) => item.created).at(-1)
  const quotaNext = {
    ...quota,
    totalTransitions: quota.totalTransitions + 1,
    noProgressTransitions: noProgress,
    submittedActions: quota.submittedActions + createdCount,
    lastProgressRef: lastCreated?.actionId ?? quota.lastProgressRef,
  }
  const stamp = at(ports)
  const nextProvider: ProviderStateValue = {
    actionId: parent.actionId,
    providerRevision: provider.providerRevision + 1,
    state: waitId === null ? 'runnable' : 'waiting',
    continuation,
    waitId,
    writerEpoch: request.guard.writerEpoch,
    termination: null,
  }
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      commitId,
      stamp,
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      guarded.value.revision,
    ),
    actionIds: planned.map((item) => ({ key: item.key, actionId: item.actionId })),
    creates,
    updates: [
      ...updates,
      updated(providerHead, PROVIDER_STATE_SCHEMA, ownerOf(providerHead), nextProvider),
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
        item.created ? [{ commitId, kind: 'action-created' as const, actionId: item.actionId }] : [],
      ),
      ...consumed.sides,
    ],
  })
  ports.rememberRequest('advanceProvider', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}

const DRAINABLE_RUN_STATES = [...NEW_WORK_RUN_STATES, 'failing', 'cancelling']

function commandRun(request: CommitControlRequest, runId: string): void {
  if (runId !== request.guard.runId) refuse('invalid_input', 'run_target', 'command names another run')
}

/**
 * Closes the admission of new work for the run, or for one composite parent. Existing actions stay. The reason is
 * checked by the schema and covered by the commit fingerprint; the finishing commands carry the terminal error.
 */
async function beginDrainTx(
  ports: ControlPorts,
  request: CommitControlRequest,
  verified: SessionView,
  fingerprint: string,
): Promise<Committed<StateCommitReceipt>> {
  const command = request.command
  if (command.kind !== 'begin_drain') refuse('internal', 'unsupported', CONTROL_COMMAND)
  commandRun(request, command.target.runId)
  const guarded = assertGuard(ports, request.guard, 'follow')
  const updates: RecordUpdate[] = []
  if (command.target.actionId === null) {
    const run = guarded.value
    if (!DRAINABLE_RUN_STATES.includes(run.state))
      refuse('conflict', 'run_state', 'run does not take a drain')
    if (run.state === 'waiting') updates.push(...closeRunWait(ports, run, [], 'cancelled'))
    updates.push(
      updated(guarded.head, RUN_RECORD_SCHEMA, guarded.owner, {
        ...run,
        state: 'draining',
        waitId: null,
        writerEpoch: request.guard.writerEpoch,
      }),
    )
  } else {
    const parent = storedValue<ActionValue>(
      requireHead(ports, actionRecordId(command.target.actionId), 'action_state', 'action does not exist'),
    )
    if (parent.runId !== request.guard.runId || parent.state !== 'running' || parent.providerStateId === null)
      refuse('conflict', 'action_state', 'action is not a running composite parent')
    const providerHead = requireHead(
      ports,
      providerStateRecordId(parent.actionId),
      'provider_absent',
      'provider state does not exist',
    )
    const provider = storedValue<ProviderStateValue>(providerHead)
    if (provider.state !== 'runnable' && provider.state !== 'waiting')
      refuse('conflict', 'provider_state', 'provider state does not take a drain')
    if (provider.state === 'waiting') {
      if (provider.waitId === null) integrity('waiting provider has no wait record')
      const waitHead = requireHead(
        ports,
        waitRecordId(provider.waitId),
        'wait_absent',
        'wait record does not exist',
      )
      const wait = storedValue<WaitRecordValue>(waitHead)
      if (wait.state !== 'waiting' || wait.targetActionId !== parent.actionId)
        refuse('conflict', 'wait_state', 'wait record is not waiting for this parent')
      updates.push(
        updated(waitHead, WAIT_SCHEMA, ownerOf(waitHead), {
          ...wait,
          state: 'cancelled',
        } satisfies WaitRecordValue),
      )
    }
    updates.push(
      updated(providerHead, PROVIDER_STATE_SCHEMA, ownerOf(providerHead), {
        ...provider,
        state: 'draining',
        waitId: null,
        writerEpoch: request.guard.writerEpoch,
      } satisfies ProviderStateValue),
    )
  }
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      request.commitId,
      at(ports),
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      guarded.value.revision,
    ),
    updates,
  })
  ports.rememberRequest('commitControl', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}

/**
 * Records the cancellation and closes admission. The first cancellation of a run wins: another request on a
 * cancelling run commits the run record unchanged, so it still has its own receipt and changes nothing.
 */
async function cancelRunTx(
  ports: ControlPorts,
  request: CommitControlRequest,
  verified: SessionView,
  fingerprint: string,
): Promise<Committed<StateCommitReceipt>> {
  const command = request.command
  if (command.kind !== 'cancel_run') refuse('internal', 'unsupported', CONTROL_COMMAND)
  commandRun(request, command.runId)
  const guarded = assertGuard(ports, request.guard, 'follow')
  const run = guarded.value
  const stamp = at(ports)
  const updates: RecordUpdate[] = []
  let next: RunRecordValue = run
  if (run.state !== 'cancelling') {
    if (!NEW_WORK_RUN_STATES.includes(run.state))
      refuse('conflict', 'run_state', 'run does not take a cancel')
    if (run.state === 'waiting') updates.push(...closeRunWait(ports, run, [], 'cancelled'))
    next = {
      ...run,
      state: 'cancelling',
      waitId: null,
      cancellation: { reason: command.reason, requestedAt: stamp, by: command.requestedBy },
      writerEpoch: request.guard.writerEpoch,
    }
  }
  updates.push(updated(guarded.head, RUN_RECORD_SCHEMA, guarded.owner, next))
  const written = ports.writeCommit({
    ...blankInput(
      request.guard.sessionId,
      verified,
      request.commitId,
      stamp,
      fingerprint,
      request.guard.runId,
      request.guard.writerEpoch,
      run.revision,
    ),
    updates,
  })
  ports.rememberRequest('commitControl', request.commitId, fingerprint, written.receipt)
  return { result: written.receipt, sessionId: request.guard.sessionId, verified: written.verified }
}
