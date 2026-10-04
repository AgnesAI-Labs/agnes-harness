import type { DatabaseSync } from 'node:sqlite'
import type { ConfigResolveResult } from '@agnes/protocol/runtime'
import {
  type SessionControlRequest,
  type SessionControlResult,
  type SessionControlState,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import type { ControlPorts, StoredHead } from './control.js'
import {
  bodyDigest,
  digestOf,
  MIN_READER,
  type RecordOwner,
  SESSION_CONTROL_REQUEST_SCHEMA,
  SESSION_CONTROL_RESULT_SCHEMA,
  SESSION_CONTROL_STATE_SCHEMA,
  sameJson,
  stableId,
} from './records.js'
import { integrity } from './refusal.js'
import type {
  SessionConfigurationIssue,
  SessionControlPermissionProof,
} from './session-control-configuration.js'
import type { SessionControlSource } from './session-control-source.js'

export const CONTROL_HEADS = 'runtime_session_control_heads'
export const CONTROL_COMMANDS = 'runtime_session_control_commands'
export function controlStateId(sessionId: string): string {
  return stableId('scs', sessionId)
}
export type Association = Readonly<{
  sessionId: string
  requestId: string
  permission: SessionControlPermissionProof
  configurationDigest: string
  selected: ConfigResolveResult
  sourcePresetDigest: string
  fingerprint: string
  revision: number
  commitId: string
  stateRecordId: string
}>
export type CommandRow = {
  key: string
  session_id: string
  request_id: string
  actor_key: string
  association_json: string
  request_record_id: string
  result_record_id: string
  commit_id: string
  revision: number
  receipt_json: string
}
export type HeadRow = {
  session_id: string
  revision: number
  state_record_id: string
  pending_request_id: string
  commit_id: string
}
export function commandKey(sessionId: string, actorKey: string, requestId: string): string {
  return digestOf({ sessionId, actorKey, requestId })
}
export function commandRecordIds(association: Association) {
  const seal = digestOf(association)
  return { request: stableId('scr', seal), result: stableId('sco', seal) }
}
function payload<K extends 'SessionControlRequest' | 'SessionControlResult' | 'SessionControlState'>(
  head: StoredHead,
  kind: K,
  schema: StoredHead['schema_json'],
  owner: RecordOwner,
) {
  if (
    head.schema_json !== schema ||
    head.min_reader !== MIN_READER ||
    !sameJson(JSON.parse(head.owner_json), owner)
  )
    integrity('session control original member header differs')
  const value: unknown = JSON.parse(head.value_json)
  const checked = validateRuntime(kind, value)
  if (
    !checked.ok ||
    head.body_digest !== bodyDigest(owner, checked.value) ||
    head.value_json !== canonicalJson(checked.value)
  )
    integrity('session control original member body differs')
  return checked.value
}
function version(ports: ControlPorts, id: string, revision: number, commitId: string): StoredHead {
  const rows = ports.all<StoredHead>(
    `SELECT v.record_id,v.schema_json,v.record_revision,v.commit_id AS last_commit_id,v.owner_json,v.value_json,v.digest AS body_digest,h.min_reader FROM runtime_record_versions v JOIN runtime_record_heads h ON h.record_id=v.record_id WHERE v.record_id=? AND v.record_revision=? AND v.commit_id=?`,
    id,
    revision,
    commitId,
  )
  if (rows.length !== 1 || !rows[0]) integrity('session control immutable original version missing')
  return rows[0]
}
export function readControl(
  ports: ControlPorts,
  source: SessionControlSource,
  sessionId: string,
  issue: SessionConfigurationIssue,
  owner: RecordOwner,
): {
  head: HeadRow | null
  state: SessionControlState | null
  staticCheck(): void
  commands: ReadonlyArray<{
    row: CommandRow
    association: Association
    request: SessionControlRequest
    result: SessionControlResult
  }>
} {
  const historicalChecks: Array<() => void> = []
  const staticCheck = () => {
    for (const check of historicalChecks) check()
  }
  const head = ports.get<HeadRow>(`SELECT * FROM ${CONTROL_HEADS} WHERE session_id=?`, sessionId) ?? null
  const rows = ports.all<CommandRow>(
    `SELECT * FROM ${CONTROL_COMMANDS} WHERE session_id=? ORDER BY revision`,
    sessionId,
  )
  // Enumerate immutable official members independently of the mutable command index.
  const officialRequests = ports.all<{ record_id: string }>(
    `SELECT DISTINCT record_id FROM runtime_record_versions WHERE schema_json=? AND json_extract(value_json,'$.sessionId')=?`,
    canonicalJson(SESSION_CONTROL_REQUEST_SCHEMA),
    sessionId,
  )
  const officialResults = ports.all<{ record_id: string }>(
    `SELECT DISTINCT record_id FROM runtime_record_versions WHERE schema_json=? AND json_extract(value_json,'$.sessionId')=?`,
    canonicalJson(SESSION_CONTROL_RESULT_SCHEMA),
    sessionId,
  )
  const officialStates = ports.all<{ record_id: string; record_revision: number }>(
    `SELECT record_id,record_revision FROM runtime_record_versions WHERE schema_json=? AND json_extract(value_json,'$.sessionId')=?`,
    canonicalJson(SESSION_CONTROL_STATE_SCHEMA),
    sessionId,
  )
  if (
    rows.length !== officialRequests.length ||
    rows.length !== officialResults.length ||
    rows.length !== officialStates.length ||
    rows.length > 0 !== Boolean(head)
  )
    integrity('session control closed membership or original head missing')
  if (!head) return { head: null, state: null, commands: [], staticCheck }
  if (head.revision !== rows.length || head.state_record_id !== controlStateId(sessionId))
    integrity('session control global revision differs')
  let previous: SessionControlState | null = null
  const commands = rows.map((row, offset) => {
    const association: Association = JSON.parse(row.association_json)
    const ids = commandRecordIds(association)
    if (
      row.association_json !== canonicalJson(association) ||
      association.sessionId !== sessionId ||
      association.revision !== offset + 1 ||
      row.revision !== association.revision ||
      row.commit_id !== association.commitId ||
      association.stateRecordId !== head.state_record_id ||
      association.configurationDigest !== digestOf(issue) ||
      row.actor_key !== association.permission.actorRef ||
      row.request_id !== association.requestId ||
      row.key !== commandKey(sessionId, association.permission.actorRef, association.requestId) ||
      row.request_record_id !== ids.request ||
      row.result_record_id !== ids.result ||
      !officialRequests.some((r) => r.record_id === ids.request) ||
      !officialResults.some((r) => r.record_id === ids.result)
    )
      integrity('session control original association differs')
    const members = ports.all<{ record_id: string; record_revision: number }>(
      'SELECT record_id,record_revision FROM runtime_record_versions WHERE commit_id=?',
      association.commitId,
    )
    const expected = new Map([
      [ids.request, 1],
      [ids.result, 1],
      [head.state_record_id, association.revision],
    ])
    if (
      members.length !== expected.size ||
      members.some((member) => expected.get(member.record_id) !== member.record_revision) ||
      ports.all('SELECT 1 FROM runtime_side_entries WHERE commit_id=?', association.commitId).length !== 0
    )
      integrity('session control original commit has different closed members')
    const request = payload(
      version(ports, ids.request, 1, association.commitId),
      'SessionControlRequest',
      canonicalJson(SESSION_CONTROL_REQUEST_SCHEMA),
      owner,
    )
    const permission = source.readHistoricalCommand(request, association.permission)
    permission.staticCheck()
    historicalChecks.push(permission.staticCheck)
    const selected = validateRuntime('ConfigResolveResult', association.selected)
    if (
      !selected.ok ||
      selected.value.preset.id !==
        (request.command.kind === 'set-preset' ? request.command.presetId : null) ||
      !sameJson(selected.value.profile, issue.resolved.profile) ||
      selected.value.presetDigest !== digestOf(selected.value.preset) ||
      selected.value.profileDigest !== digestOf(selected.value.profile) ||
      association.permission.sessionId !== sessionId ||
      !sameJson(association.permission.scope, owner.scope) ||
      association.permission.tenantRef !== ports.authority.tenantId
    )
      integrity('session control original selected configuration differs')
    const result = payload(
      version(ports, ids.result, 1, association.commitId),
      'SessionControlResult',
      canonicalJson(SESSION_CONTROL_RESULT_SCHEMA),
      owner,
    )
    const state = payload(
      version(ports, head.state_record_id, association.revision, association.commitId),
      'SessionControlState',
      canonicalJson(SESSION_CONTROL_STATE_SCHEMA),
      owner,
    )
    if (
      digestOf(request) !== association.fingerprint ||
      request.requestId !== association.requestId ||
      request.sessionId !== sessionId ||
      request.command.kind !== 'set-preset' ||
      request.command.apply !== 'next-run' ||
      request.command.presetDigest !== association.sourcePresetDigest ||
      result.sessionId !== sessionId ||
      result.requestId !== request.requestId ||
      result.revision !== association.revision ||
      result.status !== 'accepted' ||
      result.effective !== null ||
      result.error !== null ||
      result.compact !== null ||
      result.childSessionId !== null ||
      result.runId !== issue.runId ||
      state.sessionId !== sessionId ||
      state.revision !== association.revision ||
      state.activeRunId !== issue.runId ||
      state.activeTurnId !== null ||
      (request.expectedRevision !== null && request.expectedRevision !== offset)
    )
      integrity('session control original accepted relation differs')
    if (
      previous
        ? !sameJson(state.parameters, previous.parameters)
        : state.parameters.revision !== 0 ||
          state.parameters.previousRevision !== null ||
          state.parameters.sourceRequestId !== issue.ticketId ||
          state.parameters.presetId !== issue.resolved.preset.id ||
          state.parameters.presetDigest !== issue.resolved.presetDigest ||
          !sameJson(state.parameters.parameters, issue.resolved.preset.parameters) ||
          state.parameters.effective.kind !== 'immediate' ||
          state.parameters.effective.revision !== 0 ||
          state.parameters.effective.runId !== issue.runId ||
          state.parameters.effective.afterRequestId !== null
    )
      integrity('session control effective parameter source differs')
    const originalTime = ports.get<{ ts: string }>(
      `SELECT e.ts FROM runtime_commit_proofs p JOIN events e ON e.session_key=? AND e.seq=p.ledger_seq WHERE p.commit_id=?`,
      sessionId,
      association.commitId,
    )
    if (!previous && (!originalTime || state.parameters.committedAt !== originalTime.ts))
      integrity('session control initial effective boundary is not its actual commit')
    const receipt = validateRuntime('StateCommitReceipt', JSON.parse(row.receipt_json))
    if (
      !receipt.ok ||
      receipt.value.commitId !== association.commitId ||
      receipt.value.transactionFingerprint !== association.fingerprint ||
      receipt.value.sessionId !== sessionId ||
      receipt.value.runRevision !== 0 ||
      receipt.value.actionIds.length !== 0
    )
      integrity('session control original commit receipt differs')
    ports.assertReceipt(sessionId, receipt.value, association.fingerprint)
    // The authoritative latest heads cannot silently disappear while versions remain.
    for (const id of [ids.request, ids.result]) {
      const current = ports.loadHead(id)
      if (current?.record_revision !== 1 || current.last_commit_id !== association.commitId)
        integrity('session control original member head missing')
    }
    previous = state
    return { row, association, request, result }
  })
  const last = commands.at(-1)
  const stateHead = ports.loadHead(head.state_record_id)
  if (
    !last ||
    !stateHead ||
    stateHead.record_revision !== head.revision ||
    stateHead.last_commit_id !== head.commit_id ||
    head.commit_id !== last.association.commitId ||
    head.pending_request_id !== last.row.request_record_id ||
    !previous ||
    !sameJson(
      payload(stateHead, 'SessionControlState', canonicalJson(SESSION_CONTROL_STATE_SCHEMA), owner),
      previous,
    )
  )
    integrity('session control latest pending or effective member differs')
  return { head, state: previous, commands, staticCheck }
}
export function installControlTables(database: DatabaseSync): void {
  const tables = [CONTROL_HEADS, CONTROL_COMMANDS]
  const present = tables.filter((t) =>
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t),
  )
  if (present.length === 2) return
  const members = database
    .prepare('SELECT 1 FROM runtime_record_versions WHERE schema_json IN (?,?,?) LIMIT 1')
    .get(
      ...[SESSION_CONTROL_REQUEST_SCHEMA, SESSION_CONTROL_RESULT_SCHEMA, SESSION_CONTROL_STATE_SCHEMA].map(
        canonicalJson,
      ),
    )
  if (present.length || members)
    integrity('original session control index schema missing; recovery cannot initialize it')
  database.exec('SAVEPOINT session_control_install')
  try {
    database.exec(
      `CREATE TABLE ${CONTROL_HEADS} (session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state_record_id TEXT NOT NULL,pending_request_id TEXT NOT NULL,commit_id TEXT NOT NULL) WITHOUT ROWID`,
    )
    database.exec(
      `CREATE TABLE ${CONTROL_COMMANDS} (key TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,actor_key TEXT NOT NULL,association_json TEXT NOT NULL,request_record_id TEXT UNIQUE NOT NULL,result_record_id TEXT UNIQUE NOT NULL,commit_id TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT NOT NULL, UNIQUE(session_id,revision),UNIQUE(session_id,actor_key,request_id)) WITHOUT ROWID`,
    )
    database.exec('RELEASE session_control_install')
  } catch (error) {
    database.exec('ROLLBACK TO session_control_install')
    database.exec('RELEASE session_control_install')
    throw error
  }
}
