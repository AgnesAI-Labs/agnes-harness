import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type SessionControlRequest,
  type SessionControlResult,
  type SessionControlState,
  type StateStoreControlSessionControlStatusRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { captureAdmissionStateFence } from './admission.js'
import { canonicalJson } from './canonical-json.js'
import type { ControlPorts } from './control.js'
import {
  bodyDigest,
  digestOf,
  MIN_READER,
  type RecordOwner,
  RUN_RECORD_SCHEMA,
  runRecordId,
  SESSION_CONTROL_REQUEST_SCHEMA,
  SESSION_CONTROL_RESULT_SCHEMA,
  SESSION_CONTROL_STATE_SCHEMA,
  type StoredRecord,
  sameJson,
} from './records.js'
import { integrity, refuse } from './refusal.js'
import {
  type Association,
  CONTROL_COMMANDS,
  CONTROL_HEADS,
  commandKey,
  commandRecordIds,
  controlStateId,
  installControlTables,
  readControl,
} from './session-control-cold.js'
import type { SessionConfigurationIssue } from './session-control-configuration.js'
import {
  isSessionControlSource,
  type SessionControlSource,
  sessionControlSourceUsesDatabase,
} from './session-control-source.js'

type Queue = <T>(
  method: string,
  requestId: string,
  body: () => T | Promise<T>,
  finalCheck: () => void,
) => Promise<T>
export type SessionControlOwner = Readonly<{
  read(sessionId: string, context: CallContext): Promise<SessionControlState>
  status(
    request: StateStoreControlSessionControlStatusRequest,
    context: CallContext,
  ): Promise<SessionControlResult | null>
  submit(request: SessionControlRequest, context: CallContext): Promise<SessionControlResult>
}>
function nativeIndices(database: DatabaseSync): () => void {
  const checks = [CONTROL_HEADS, CONTROL_COMMANDS].map((table) => {
    const statement = database.prepare(
      `SELECT * FROM ${table} ORDER BY session_id${table === CONTROL_COMMANDS ? ',revision' : ''}`,
    )
    const read = statement.all.bind(statement)
    const rows = read().map((row) => Object.entries(row))
    return () => {
      const actual = read()
      if (actual.length !== rows.length) integrity('session control native index membership changed')
      rows.forEach((slots, i) => {
        const row = actual[i]
        if (!row || Object.keys(row).length !== slots.length || slots.some(([k, v]) => row[k] !== v))
          integrity('session control native index bytes changed')
      })
    }
  })
  return () => {
    for (const check of checks) check()
  }
}
function originalRun(ports: ControlPorts, issue: SessionConfigurationIssue, context: CallContext) {
  const head = ports.loadHead(runRecordId(issue.runId))
  if (!head || head.schema_json !== canonicalJson(RUN_RECORD_SCHEMA))
    integrity('session control original Run missing')
  const run = validateRuntime('RunRecordValue', JSON.parse(head.value_json))
  const owner: RecordOwner = JSON.parse(head.owner_json)
  if (
    !run.ok ||
    run.value.runId !== issue.runId ||
    run.value.sessionId !== issue.sessionId ||
    run.value.bindingId !== issue.binding.bindingId ||
    head.body_digest !== bodyDigest(owner, run.value) ||
    !sameJson(owner.authority, ports.authority) ||
    !sameJson(owner.scope, context.scope)
  )
    integrity('session control original Run binding differs')
  if (
    head.record_revision !== 1 ||
    head.last_commit_id !== issue.commitId ||
    run.value.revision !== 0 ||
    ['completed', 'failed', 'cancelled'].includes(run.value.state)
  )
    refuse(
      'incompatible',
      'session_control_active_run',
      'this slice requires its original admitted Run; progressed or idle foreground ownership is not installed',
    )
  return { run: run.value, owner }
}
function checked<K extends 'SessionControlState' | 'SessionControlResult'>(kind: K, value: unknown) {
  const parsed = validateRuntime(kind, value)
  if (!parsed.ok) integrity('session control planned official output violates its codec')
  return parsed.value
}
export function createSessionControlOwner(
  database: DatabaseSync,
  source: SessionControlSource,
  ports: ControlPorts,
  queue: Queue,
): SessionControlOwner {
  if (!isSessionControlSource(source) || !sessionControlSourceUsesDatabase(source, database))
    refuse('denied', 'session_control_source', 'genuine same-connection source required')
  installControlTables(database)
  function tail(dynamic: () => void, final: (check: () => void) => void, historical: () => void) {
    const state = captureAdmissionStateFence(database),
      indices = nativeIndices(database)
    return () => {
      dynamic()
      final(() => {
        historical()
        state()
        indices()
      })
    }
  }
  async function read(sessionId: string, context: CallContext): Promise<SessionControlState> {
    let finish = () => {}
    return queue(
      'readSessionControl',
      sessionId,
      async () => {
        const cap = source.captureRead(sessionId, context)
        await ports.requireSession(sessionId)
        const native = originalRun(ports, cap.issue, context)
        const controls = readControl(ports, source, sessionId, cap.issue, native.owner)
        if (!controls.state)
          refuse('denied', 'session_control_uninitialized', 'no original committed effective state')
        finish = tail(cap.dynamicCheck, cap.finalCheck, controls.staticCheck)
        return controls.state
      },
      () => finish(),
    )
  }
  async function status(
    request: StateStoreControlSessionControlStatusRequest,
    context: CallContext,
  ): Promise<SessionControlResult | null> {
    let finish = () => {}
    return queue(
      'sessionControlStatus',
      request.requestId,
      async () => {
        const cap = source.captureStatus(request.sessionId, context)
        await ports.requireSession(request.sessionId)
        const native = originalRun(ports, cap.issue, context)
        const controls = readControl(ports, source, request.sessionId, cap.issue, native.owner)
        const key = commandKey(request.sessionId, cap.permission.actorRef, request.requestId)
        const result = controls.commands.find((c) => c.row.key === key)?.result ?? null
        finish = tail(cap.dynamicCheck, cap.finalCheck, controls.staticCheck)
        return result
      },
      () => finish(),
    )
  }
  async function submit(raw: SessionControlRequest, context: CallContext): Promise<SessionControlResult> {
    const parsed = validateRuntime('SessionControlRequest', raw)
    if (!parsed.ok)
      refuse('invalid_input', 'session_control_request', 'request does not match official codec')
    if (parsed.value.command.kind !== 'set-preset' || parsed.value.command.apply !== 'next-run')
      refuse('incompatible', 'unsupported_session_control_command', 'only set-preset next-run is implemented')
    let finish = () => {}
    return queue(
      'submitSessionControl',
      parsed.value.requestId,
      async () => {
        const cap = source.captureSubmit(parsed.value, context)
        const request = cap.request,
          issue = cap.configuration
        const verified = await ports.requireSession(request.sessionId)
        const native = originalRun(ports, issue, context)
        const controls = readControl(ports, source, request.sessionId, issue, native.owner)
        const key = commandKey(request.sessionId, cap.permission.actorRef, request.requestId)
        const replay = controls.commands.find((c) => c.row.key === key)
        if (replay) {
          if (replay.association.fingerprint !== cap.requestFingerprint || !sameJson(replay.request, request))
            refuse(
              'conflict',
              'command_payload_mismatch',
              'request identity already names a different original command',
            )
          finish = tail(cap.dynamicCheck, cap.finalCheck, controls.staticCheck)
          return replay.result
        }
        const previous = controls.head?.revision ?? 0
        if (request.expectedRevision !== null && request.expectedRevision !== previous)
          refuse('conflict', 'session_control_revision', 'session control revision changed')
        if (!Number.isSafeInteger(previous + 1))
          refuse('conflict', 'session_control_revision', 'session control revision exhausted')
        const revision = previous + 1,
          commitId = ports.ulid(),
          at = new Date(ports.now()).toISOString()
        const state = checked('SessionControlState', {
          sessionId: request.sessionId,
          revision,
          parameters: controls.state?.parameters ?? {
            sessionId: request.sessionId,
            revision: 0,
            previousRevision: null,
            sourceRequestId: issue.ticketId,
            presetId: issue.resolved.preset.id,
            presetDigest: issue.resolved.presetDigest,
            parameters: issue.resolved.preset.parameters,
            effective: { kind: 'immediate', revision: 0, runId: issue.runId, afterRequestId: null },
            committedAt: at,
          },
          activeRunId: issue.runId,
          activeTurnId: null,
        })
        const result = checked('SessionControlResult', {
          sessionId: request.sessionId,
          requestId: request.requestId,
          status: 'accepted',
          revision,
          effective: null,
          runId: issue.runId,
          childSessionId: null,
          compact: null,
          error: null,
        })
        if (request.command.kind !== 'set-preset') integrity('captured command kind changed')
        const association: Association = {
          sessionId: request.sessionId,
          requestId: request.requestId,
          permission: cap.permission,
          configurationDigest: digestOf(issue),
          selected: cap.selected,
          sourcePresetDigest: request.command.presetDigest,
          fingerprint: cap.requestFingerprint,
          revision,
          commitId,
          stateRecordId: controlStateId(request.sessionId),
        }
        const ids = commandRecordIds(association)
        const record = (
          recordId: string,
          schema: StoredRecord['schema'],
          value: unknown,
          recordRevision = 1,
        ): StoredRecord => ({
          recordId,
          schema,
          value,
          recordRevision,
          minReader: MIN_READER,
          owner: native.owner,
        })
        const stateRecord = record(association.stateRecordId, SESSION_CONTROL_STATE_SCHEMA, state, revision)
        const committed = ports.writeCommit({
          sessionId: request.sessionId,
          verified,
          commitId,
          at,
          fingerprint: cap.requestFingerprint,
          runId: issue.runId,
          actionId: null,
          writerEpoch: native.run.writerEpoch,
          runRevision: native.run.revision,
          actionIds: [],
          creates: [
            record(ids.request, SESSION_CONTROL_REQUEST_SCHEMA, request),
            record(ids.result, SESSION_CONTROL_RESULT_SCHEMA, result),
            ...(!controls.head ? [stateRecord] : []),
          ],
          updates: controls.head ? [{ record: stateRecord, previousRevision: previous }] : [],
          sides: [],
        })
        ports.run(
          `INSERT INTO ${CONTROL_COMMANDS} VALUES(?,?,?,?,?,?,?,?,?,?)`,
          key,
          request.sessionId,
          request.requestId,
          cap.permission.actorRef,
          canonicalJson(association),
          ids.request,
          ids.result,
          commitId,
          revision,
          canonicalJson(committed.receipt),
        )
        if (controls.head)
          ports.run(
            `UPDATE ${CONTROL_HEADS} SET revision=?,pending_request_id=?,commit_id=? WHERE session_id=? AND revision=?`,
            revision,
            ids.request,
            commitId,
            request.sessionId,
            previous,
          )
        else
          ports.run(
            `INSERT INTO ${CONTROL_HEADS} VALUES(?,?,?,?,?)`,
            request.sessionId,
            revision,
            association.stateRecordId,
            ids.request,
            commitId,
          )
        finish = tail(cap.dynamicCheck, cap.finalCheck, controls.staticCheck)
        return result
      },
      () => finish(),
    )
  }
  return Object.freeze({ read, status, submit })
}
