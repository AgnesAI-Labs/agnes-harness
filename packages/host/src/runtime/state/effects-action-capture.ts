import type { DatabaseSync } from 'node:sqlite'
import { validateRuntime } from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import type { ControlPorts, StoredHead } from './control.js'
import {
  ACTION_SCHEMA,
  actionRecordId,
  bodyDigest,
  digestOf,
  MIN_READER,
  type RecordOwner,
  RUN_RECORD_SCHEMA,
  runRecordId,
  sameJson,
} from './records.js'
import { integrity, refuse } from './refusal.js'

export type EffectsActionCapture = Readonly<{
  sessionId: string
  runId: string
  actionId: string
  bindingId: string
  workspaceId: string
  createdByCommitId: string
  inputDigest: string
  runRevision: number
}>

type Fixed = { database: DatabaseSync; owner: object; bytes: string }
const fixed = new WeakMap<EffectsActionCapture, Fixed>()

type Action = {
  actionId: string
  runId: string
  state: string
  createdByCommitId: string
  currentAttemptId: string | null
  intent: { input: { digest: string } }
}

function checkedHead(head: StoredHead | undefined, schema: unknown, kind: string) {
  if (!head || head.schema_json !== canonicalJson(schema) || head.min_reader !== MIN_READER)
    integrity(`original ${kind} head missing or incompatible`)
  const owner = JSON.parse(head.owner_json) as RecordOwner
  const value = JSON.parse(head.value_json) as unknown
  if (!validateRuntime('RecordOwner', owner).ok || head.body_digest !== bodyDigest(owner, value))
    integrity(`original ${kind} body differs`)
  return { head, owner, value }
}

function original(
  ports: ControlPorts,
  sessionId: string,
  actionId: string,
): { capture: EffectsActionCapture; bytes: string } {
  const action = checkedHead(ports.loadHead(actionRecordId(actionId)), ACTION_SCHEMA, 'Action')
  const actionValue = validateRuntime('ActionRecordValue', action.value)
  if (!actionValue.ok) integrity('original Action codec differs')
  const value = actionValue.value as Action
  if (
    value.actionId !== actionId ||
    value.state !== 'prepared' ||
    value.currentAttemptId !== null ||
    action.head.record_revision !== 1 ||
    action.head.last_commit_id !== value.createdByCommitId
  )
    integrity('original Action creation relation differs')
  const run = checkedHead(ports.loadHead(runRecordId(value.runId)), RUN_RECORD_SCHEMA, 'Run')
  const runValue = validateRuntime('RunRecordValue', run.value)
  if (
    !runValue.ok ||
    runValue.value.runId !== value.runId ||
    runValue.value.sessionId !== sessionId ||
    runValue.value.bindingId !== run.owner.ownerBinding.bindingId ||
    !sameJson(action.owner, run.owner) ||
    !sameJson(action.owner.authority, ports.authority)
  )
    integrity('original Action/Run owner or scope differs')
  const version = ports.all<StoredHead>(
    `SELECT v.record_id,v.schema_json,v.record_revision,v.commit_id AS last_commit_id,
            v.owner_json,v.value_json,v.digest AS body_digest,h.min_reader
       FROM runtime_record_versions v JOIN runtime_record_heads h ON h.record_id=v.record_id
      WHERE v.record_id=? AND v.record_revision=1 AND v.commit_id=?`,
    actionRecordId(actionId),
    value.createdByCommitId,
  )
  if (version.length !== 1 || !sameJson(version[0], action.head))
    integrity('original Action revision-one version differs')
  const sides = ports.all<{ entry_json: string }>(
    `SELECT entry_json FROM runtime_side_entries
      WHERE commit_id=? AND kind='action-created' AND identity=?`,
    value.createdByCommitId,
    actionId,
  )
  if (
    sides.length !== 1 ||
    !sameJson(JSON.parse(sides[0]?.entry_json ?? 'null'), {
      commitId: value.createdByCommitId,
      kind: 'action-created',
      actionId,
    })
  )
    integrity('original action-created side differs')
  const proof = ports.all<{ ledger_seq: number }>(
    `SELECT p.ledger_seq FROM runtime_commit_proofs p JOIN events e
       ON e.session_key=? AND e.seq=p.ledger_seq WHERE p.commit_id=?
       AND e.type='runtime/state-commit' AND json_extract(e.data,'$.commitId')=p.commit_id`,
    sessionId,
    value.createdByCommitId,
  )
  if (proof.length !== 1) integrity('original Action commit event differs')
  const meta = ports.get<{ workspace_id: string }>(
    'SELECT workspace_id FROM runtime_session_meta WHERE session_id=?',
    sessionId,
  )
  if (!meta) integrity('original Action session workspace missing')
  const capture = Object.freeze({
    sessionId,
    runId: value.runId,
    actionId,
    bindingId: runValue.value.bindingId,
    workspaceId: meta.workspace_id,
    createdByCommitId: value.createdByCommitId,
    inputDigest: digestOf(value.intent.input),
    runRevision: runValue.value.revision,
  })
  return { capture, bytes: canonicalJson({ action: action.head, run: run.head, proof, sides, meta }) }
}

export function createEffectsActionCaptureOwner(database: DatabaseSync, ports: ControlPorts) {
  const owner = Object.freeze({})
  return Object.freeze({
    async capture(sessionId: string, actionId: string): Promise<EffectsActionCapture> {
      if (!sessionId || !actionId) refuse('invalid_input', 'effects_action', 'Action identity is required')
      await ports.requireSession(sessionId)
      const found = original(ports, sessionId, actionId)
      fixed.set(found.capture, { database, owner, bytes: found.bytes })
      return found.capture
    },
    async verify(capture: EffectsActionCapture): Promise<boolean> {
      const source = fixed.get(capture)
      if (!source || source.database !== database || source.owner !== owner) return false
      await ports.requireSession(capture.sessionId)
      const current = original(ports, capture.sessionId, capture.actionId)
      return source.bytes === current.bytes && sameJson(capture, current.capture)
    },
    verifyCurrent(capture: EffectsActionCapture): boolean {
      const source = fixed.get(capture)
      if (!source || source.database !== database || source.owner !== owner) return false
      const current = original(ports, capture.sessionId, capture.actionId)
      return source.bytes === current.bytes && sameJson(capture, current.capture)
    },
  })
}
