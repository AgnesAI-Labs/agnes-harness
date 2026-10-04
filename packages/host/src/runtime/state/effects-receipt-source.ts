import type { Receipt, ReceiptIntakeRequest } from '@agnes/extension-api/runtime'
import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import type { ControlPorts, StoredHead } from './control.js'
import {
  ACTION_SCHEMA,
  ATTEMPT_SCHEMA,
  actionRecordId,
  attemptRecordId,
  bodyDigest,
  DISPATCH_ADMISSION_SCHEMA,
  digestOf,
  MIN_READER,
  RECEIPT_SCHEMA,
  type RecordOwner,
  RUN_RECORD_SCHEMA,
  receiptRecordId,
  runRecordId,
  sameJson,
} from './records.js'
import { integrity, refuse } from './refusal.js'

/** A persisted no-hook fact. This does not attest an Effects stage or selected package. */
export type EffectsReceiptSource = Readonly<{
  sessionId: string
  runId: string
  actionId: string
  attemptId: string
  receiptId: string
  commitId: string
  receipt: Receipt
}>

type Version = {
  record_id: string
  record_revision: number
  commit_id: string
  schema_json: string
  owner_json: string
  value_json: string | null
  digest: string
}

type WireName = Parameters<typeof validateRuntime>[0]

function head(ports: ControlPorts, id: string, schema: unknown, codec: WireName) {
  const found = ports.loadHead(id)
  if (!found || found.schema_json !== canonicalJson(schema) || found.min_reader !== MIN_READER)
    integrity(`original ${codec} head missing or incompatible`)
  const owner = JSON.parse(found.owner_json) as RecordOwner
  const value = JSON.parse(found.value_json) as unknown
  if (!validateRuntime('RecordOwner', owner).ok || !validateRuntime(codec, value).ok)
    integrity(`original ${codec} codec differs`)
  if (found.body_digest !== bodyDigest(owner, value) || !sameJson(owner.authority, ports.authority))
    integrity(`original ${codec} body or authority differs`)
  return { found, owner, value }
}

function version(
  ports: ControlPorts,
  found: StoredHead,
  revision: number,
  commitId: string,
  codec: WireName,
) {
  const rows = ports.all<Version>(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND record_revision=? AND commit_id=?',
    found.record_id,
    revision,
    commitId,
  )
  const row = rows[0]
  if (rows.length !== 1 || !row || row.value_json === null || row.schema_json !== found.schema_json)
    integrity(`original ${codec} version missing or incompatible`)
  const owner = JSON.parse(row.owner_json) as RecordOwner
  const value = JSON.parse(row.value_json) as unknown
  if (
    !sameJson(owner, JSON.parse(found.owner_json)) ||
    !validateRuntime(codec, value).ok ||
    row.digest !== bodyDigest(owner, value)
  )
    integrity(`original ${codec} version body differs`)
  if (
    found.record_revision === revision &&
    found.last_commit_id === commitId &&
    (!sameJson(value, JSON.parse(found.value_json)) || row.digest !== found.body_digest)
  )
    integrity(`original ${codec} head differs from version`)
  return value
}

function side(ports: ControlPorts, commitId: string, kind: string, identity: string, entry: unknown) {
  const rows = ports.all<{ entry_json: string }>(
    'SELECT entry_json FROM runtime_side_entries WHERE commit_id=? AND kind=? AND identity=?',
    commitId,
    kind,
    identity,
  )
  if (rows.length !== 1 || !sameJson(JSON.parse(rows[0]?.entry_json ?? 'null'), entry))
    integrity(`original ${kind} side differs`)
}

function event(ports: ControlPorts, sessionId: string, commitId: string) {
  const rows = ports.all<{ ledger_seq: number }>(
    `SELECT p.ledger_seq FROM runtime_commit_proofs p JOIN events e
       ON e.session_key=? AND e.seq=p.ledger_seq
      WHERE p.commit_id=? AND e.type='runtime/state-commit' AND json_extract(e.data,'$.commitId')=?`,
    sessionId,
    commitId,
    commitId,
  )
  if (rows.length !== 1) integrity('original commit event differs')
}

function intake(stored: { receipt: Receipt; evidenceRefs: unknown[] }): ReceiptIntakeRequest {
  const sourceSchema = RuntimeMethodSchemaRefs['agh.state'].intakeReceipt.input
  const refs = stored.evidenceRefs as Array<{
    schema?: { typeId?: string }
    kind?: string
    value?: unknown
    digest?: string
    bytes?: number
  }>
  const candidates = refs.filter((ref) => ref.schema?.typeId === sourceSchema.typeId)
  const source = candidates[0]
  if (
    candidates.length !== 1 ||
    !source ||
    source.kind !== 'inline' ||
    !sameJson(source.schema, sourceSchema) ||
    !validateRuntime('DataRef', source).ok ||
    source.digest !== digestOf(source.value) ||
    source.bytes !== Buffer.byteLength(canonicalJson(source.value))
  )
    integrity('original no-hook intake source is missing or invalid')
  const checked = validateRuntime('ReceiptIntakeRequest', source.value)
  if (
    !checked.ok ||
    checked.value.resultHandling.kind !== 'no-hook' ||
    !sameJson(checked.value.receipt, stored.receipt) ||
    !sameJson([...checked.value.evidence, source], refs) ||
    checked.value.evidence.some((ref) => ref.schema.typeId === sourceSchema.typeId)
  )
    integrity('original no-hook intake source differs')
  return checked.value
}

export async function readEffectsReceiptSource(
  ports: ControlPorts,
  receiptId: string,
): Promise<EffectsReceiptSource> {
  if (!receiptId) refuse('invalid_input', 'effects_receipt', 'Receipt identity is required')
  const storedReceipt = head(ports, receiptRecordId(receiptId), RECEIPT_SCHEMA, 'ReceiptRecordValue')
  const stored = storedReceipt.value as { receipt: Receipt; evidenceRefs: unknown[] }
  const receipt = stored.receipt
  if (receipt.receiptId !== receiptId || storedReceipt.found.record_revision !== 1)
    integrity('original Receipt identity differs')
  const action = head(ports, actionRecordId(receipt.actionId), ACTION_SCHEMA, 'ActionRecordValue')
  const attempt = head(ports, attemptRecordId(receipt.attemptId), ATTEMPT_SCHEMA, 'AttemptRecordValue')
  const actionValue = action.value as {
    actionId: string
    runId: string
    state: string
    currentAttemptId: string | null
    firstReceiptId: string | null
    resolvedReceiptId: string | null
    createdByCommitId: string
    intent: { input: unknown }
  }
  const attemptValue = attempt.value as {
    attemptId: string
    actionId: string
    number: number
    kind: string
    state: string
    bindingId: string
    inputDigest: string
    receiptIds: string[]
    authorizationRef: string | null
  }
  const run = head(ports, runRecordId(actionValue.runId), RUN_RECORD_SCHEMA, 'RunRecordValue')
  const runValue = run.value as { runId: string; sessionId: string }
  await ports.requireSession(runValue.sessionId)
  if (
    actionValue.actionId !== receipt.actionId ||
    runValue.runId !== actionValue.runId ||
    !sameJson(action.owner, attempt.owner) ||
    !sameJson(action.owner, storedReceipt.owner) ||
    !sameJson(action.owner, run.owner) ||
    actionValue.state !== 'settled' ||
    actionValue.currentAttemptId !== receipt.attemptId ||
    actionValue.resolvedReceiptId !== receiptId ||
    actionValue.firstReceiptId !== receiptId ||
    attemptValue.state !== 'settled' ||
    attemptValue.kind === 'control' ||
    attemptValue.number < 1 ||
    attemptValue.attemptId !== receipt.attemptId ||
    attemptValue.actionId !== receipt.actionId ||
    !attemptValue.receiptIds.includes(receiptId) ||
    attemptValue.receiptIds.length !== 1 ||
    attemptValue.bindingId !== receipt.bindingId ||
    attemptValue.inputDigest !== receipt.inputDigest ||
    digestOf(actionValue.intent.input) !== receipt.inputDigest
  )
    integrity('original Action/Attempt/Receipt relationship differs')
  const intakeRequest = intake(stored)
  if (intakeRequest.sourceAuthorizationRef !== attemptValue.authorizationRef)
    integrity('original intake authorization differs')
  const receiptCommit = storedReceipt.found.last_commit_id
  version(ports, storedReceipt.found, 1, receiptCommit, 'ReceiptRecordValue')
  version(ports, action.found, action.found.record_revision, receiptCommit, 'ActionRecordValue')
  version(ports, attempt.found, attempt.found.record_revision, receiptCommit, 'AttemptRecordValue')
  if (action.found.last_commit_id !== receiptCommit || attempt.found.last_commit_id !== receiptCommit)
    integrity('original settlement commit differs')
  side(ports, receiptCommit, 'receipt-created', receiptId, {
    commitId: receiptCommit,
    kind: 'receipt-created',
    receiptId,
  })
  event(ports, runValue.sessionId, receiptCommit)
  const created = version(ports, action.found, 1, actionValue.createdByCommitId, 'ActionRecordValue') as {
    actionId: string
    runId: string
    state: string
    currentAttemptId: string | null
    createdByCommitId: string
    intent: { input: unknown }
  }
  if (
    created.actionId !== receipt.actionId ||
    created.runId !== runValue.runId ||
    created.state !== 'prepared' ||
    created.currentAttemptId !== null ||
    created.createdByCommitId !== actionValue.createdByCommitId ||
    !sameJson(created.intent.input, actionValue.intent.input)
  )
    integrity('original Action creation differs')
  side(ports, actionValue.createdByCommitId, 'action-created', receipt.actionId, {
    commitId: actionValue.createdByCommitId,
    kind: 'action-created',
    actionId: receipt.actionId,
  })
  event(ports, runValue.sessionId, actionValue.createdByCommitId)
  const originalAttempt = ports.all<Version>(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND record_revision=1',
    attempt.found.record_id,
  )
  if (originalAttempt.length !== 1 || !originalAttempt[0]) integrity('original Attempt creation missing')
  const dispatchCommit = originalAttempt[0].commit_id
  const createdAttempt = version(ports, attempt.found, 1, dispatchCommit, 'AttemptRecordValue') as {
    attemptId: string
    actionId: string
    bindingId: string
    inputDigest: string
    state: string
    authorizationRef: string | null
  }
  if (
    createdAttempt.attemptId !== receipt.attemptId ||
    createdAttempt.actionId !== receipt.actionId ||
    createdAttempt.bindingId !== receipt.bindingId ||
    createdAttempt.inputDigest !== receipt.inputDigest ||
    createdAttempt.state !== 'dispatching' ||
    createdAttempt.authorizationRef !== attemptValue.authorizationRef
  )
    integrity('original Attempt creation differs')
  const dispatchedAction = ports.all<Version>(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND commit_id=?',
    action.found.record_id,
    dispatchCommit,
  )
  if (dispatchedAction.length !== 1 || !dispatchedAction[0])
    integrity('original Action dispatch version missing')
  const atDispatch = version(
    ports,
    action.found,
    dispatchedAction[0].record_revision,
    dispatchCommit,
    'ActionRecordValue',
  ) as { currentAttemptId: string | null; state: string }
  if (atDispatch.state !== 'dispatching' || atDispatch.currentAttemptId !== receipt.attemptId)
    integrity('original Action dispatch differs')
  const dispatches = ports
    .all<Version>(
      'SELECT * FROM runtime_record_versions WHERE commit_id=? AND schema_json=?',
      dispatchCommit,
      canonicalJson(DISPATCH_ADMISSION_SCHEMA),
    )
    .filter((row) => {
      if (!row.value_json) return false
      const checked = validateRuntime('DispatchAdmissionRecordValue', JSON.parse(row.value_json))
      return (
        checked.ok &&
        checked.value.result.state === 'admitted' &&
        checked.value.result.attemptId === receipt.attemptId
      )
    })
  if (dispatches.length !== 1 || !dispatches[0]) integrity('original dispatch admission missing')
  const dispatch = dispatches[0]
  const dispatchHead = head(
    ports,
    dispatch.record_id,
    DISPATCH_ADMISSION_SCHEMA,
    'DispatchAdmissionRecordValue',
  )
  const dispatchValue = version(
    ports,
    dispatchHead.found,
    1,
    dispatchCommit,
    'DispatchAdmissionRecordValue',
  ) as { result: { state: string; attemptId?: string; authorizationId?: string } }
  if (
    dispatchValue.result.state !== 'admitted' ||
    dispatchValue.result.attemptId !== receipt.attemptId ||
    dispatchValue.result.authorizationId !== attemptValue.authorizationRef
  )
    integrity('original dispatch authorization differs')
  if (!sameJson(dispatchHead.owner, action.owner)) integrity('original dispatch owner differs')
  event(ports, runValue.sessionId, dispatchCommit)
  return Object.freeze({
    sessionId: runValue.sessionId,
    runId: runValue.runId,
    actionId: receipt.actionId,
    attemptId: receipt.attemptId,
    receiptId,
    commitId: receiptCommit,
    receipt,
  })
}
