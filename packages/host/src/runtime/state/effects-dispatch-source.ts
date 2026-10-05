import type { DatabaseSync } from 'node:sqlite'
import type {
  PreparedAction,
  ProviderBindingSnapshot,
  RecordVersionRef,
  RunBinding,
  RunRecordValue,
} from '@agnes/protocol/runtime'
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
  RUN_BINDING_SCHEMA,
  RUN_RECORD_SCHEMA,
  runBindingRecordId,
  runRecordId,
  sameJson,
} from './records.js'
import { integrity, refuse } from './refusal.js'

export type EffectsDispatchSource = Readonly<{
  sessionId: string
  runId: string
  actionId: string
  actionRevision: number
  runRevision: number
  createdByCommitId: string
  owner: RecordOwner
  intent: PreparedAction
  run: RunRecordValue
  runBinding: RunBinding
  target: ProviderBindingSnapshot
  versions: Readonly<{ action: RecordVersionRef; run: RecordVersionRef; binding: RecordVersionRef }>
  writer: Readonly<{ writerId: string; writerEpoch: number; leaseUntil: number }>
}>

function versionRef(row: StoredHead, schema: RecordVersionRef['schema']): RecordVersionRef {
  const value = JSON.parse(row.value_json) as unknown
  const json = canonicalJson(value)
  return {
    recordId: row.record_id,
    recordRevision: row.record_revision,
    schema,
    commitId: row.last_commit_id,
    digest: row.body_digest,
    body: {
      state: 'available',
      ref: {
        kind: 'inline',
        schema,
        value: value as never,
        digest: digestOf(value),
        bytes: Buffer.byteLength(json),
      },
    },
  }
}

function head(
  ports: ControlPorts,
  id: string,
  schema: unknown,
  codec: 'ActionRecordValue' | 'RunRecordValue' | 'RunBinding',
) {
  const row = ports.loadHead(id)
  if (!row || row.schema_json !== canonicalJson(schema) || row.min_reader !== MIN_READER)
    integrity(`original ${codec} head missing or incompatible`)
  const owner = JSON.parse(row.owner_json) as RecordOwner
  const value = JSON.parse(row.value_json) as unknown
  if (
    !validateRuntime('RecordOwner', owner).ok ||
    !validateRuntime(codec, value).ok ||
    row.body_digest !== bodyDigest(owner, value) ||
    !sameJson(owner.authority, ports.authority)
  )
    integrity(`original ${codec} body differs`)
  return { row, owner, value }
}

function originalVersion(ports: ControlPorts, row: StoredHead, commitId: string) {
  const versions = ports.all<{
    record_id: string
    schema_json: string
    record_revision: number
    commit_id: string
    owner_json: string
    value_json: string
    digest: string
  }>(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND record_revision=? AND commit_id=?',
    row.record_id,
    row.record_revision,
    commitId,
  )
  const version = versions[0]
  if (
    versions.length !== 1 ||
    !version ||
    row.last_commit_id !== commitId ||
    version.schema_json !== row.schema_json ||
    version.owner_json !== row.owner_json ||
    version.value_json !== row.value_json ||
    version.digest !== row.body_digest
  )
    integrity('original record version differs')
}

export type VerifiedEffectsLease = Readonly<{
  writer_id: string | null
  writer_epoch: number | null
  lease_until: number | null
  authority_epoch: number
}>

export function readCurrentEffectsDispatchSource(
  ports: ControlPorts,
  sessionId: string,
  actionId: string,
  loadVerifiedLease: (sessionId: string) => VerifiedEffectsLease,
): EffectsDispatchSource {
  const observedAt = ports.now()
  const action = head(ports, actionRecordId(actionId), ACTION_SCHEMA, 'ActionRecordValue')
  const actionValue = action.value as {
    actionId: string
    runId: string
    state: string
    currentAttemptId: string | null
    createdByCommitId: string
    intent: PreparedAction
  }
  if (actionValue.state !== 'prepared' || actionValue.currentAttemptId !== null)
    refuse('conflict', 'effects_action_state', 'original Action is no longer prepared')
  if (actionValue.actionId !== actionId || action.row.record_revision !== 1)
    integrity('original Action identity or revision differs')
  const run = head(ports, runRecordId(actionValue.runId), RUN_RECORD_SCHEMA, 'RunRecordValue')
  originalVersion(ports, run.row, run.row.last_commit_id)
  const runValue = run.value as RunRecordValue
  if (
    runValue.runId !== actionValue.runId ||
    runValue.sessionId !== sessionId ||
    !sameJson(action.owner, run.owner)
  )
    integrity('original Action/Run relationship differs')
  if (runValue.cancellation !== null || runValue.terminal !== null)
    refuse('conflict', 'effects_run_cancelled', 'original Run is cancelled or terminal')
  const binding = head(ports, runBindingRecordId(runValue.runId), RUN_BINDING_SCHEMA, 'RunBinding')
  const runBinding = binding.value as RunBinding
  if (
    runBinding.bindingId !== runValue.bindingId ||
    !sameJson(binding.owner, run.owner) ||
    !sameJson(runBinding.stateAuthorityAtCreation, ports.authority)
  )
    integrity('original RunBinding relationship differs')
  originalVersion(ports, binding.row, binding.row.last_commit_id)
  const event = ports.all<{ ledger_seq: number }>(
    `SELECT p.ledger_seq FROM runtime_commit_proofs p JOIN events e
       ON e.session_key=? AND e.seq=p.ledger_seq
      WHERE p.commit_id=? AND e.type='runtime/state-commit' AND json_extract(e.data,'$.commitId')=?`,
    sessionId,
    binding.row.last_commit_id,
    binding.row.last_commit_id,
  )
  if (event.length !== 1) integrity('original RunBinding commit event differs')
  const intent = actionValue.intent
  const targets = runBinding.providers.filter((candidate) => sameJson(candidate.binding, intent.target))
  if (targets.length !== 1 || !targets[0]) integrity('original Action target is not uniquely selected')
  const target = targets[0]
  const operations = target.descriptor.operations.filter((operation) => operation.method === intent.method)
  const operation = operations[0]
  if (
    target.descriptor.providerId !== target.binding.providerId ||
    target.descriptor.contract !== target.binding.contract ||
    target.descriptor.logicalName !== target.binding.logicalName ||
    operations.length !== 1 ||
    !operation ||
    operation.kind !== 'action' ||
    !sameJson(operation.inputSchema, intent.input.schema) ||
    !sameJson(operation.outputSchema, intent.resultSchema)
  )
    integrity('original selected action operation differs')
  const lease = loadVerifiedLease(sessionId)
  if (
    !lease?.writer_id ||
    lease.writer_epoch !== runValue.writerEpoch ||
    lease.authority_epoch !== ports.authority.authorityEpoch ||
    lease.lease_until === null ||
    lease.lease_until <= observedAt
  )
    refuse('conflict', 'writer_lease', 'original Action writer lease is not live')
  return {
    sessionId,
    runId: runValue.runId,
    actionId,
    actionRevision: action.row.record_revision,
    runRevision: runValue.revision,
    createdByCommitId: actionValue.createdByCommitId,
    owner: action.owner,
    intent,
    run: runValue,
    runBinding,
    target,
    versions: {
      action: versionRef(action.row, ACTION_SCHEMA),
      run: versionRef(run.row, RUN_RECORD_SCHEMA),
      binding: versionRef(binding.row, RUN_BINDING_SCHEMA),
    },
    writer: { writerId: lease.writer_id, writerEpoch: lease.writer_epoch, leaseUntil: lease.lease_until },
  }
}

export async function readEffectsDispatchSource(
  ports: ControlPorts,
  sessionId: string,
  actionId: string,
  loadVerifiedLease: (sessionId: string) => VerifiedEffectsLease,
): Promise<EffectsDispatchSource> {
  await ports.requireSession(sessionId)
  return readCurrentEffectsDispatchSource(ports, sessionId, actionId, loadVerifiedLease)
}

/** Freeze only the original source rows before the final clock. The returned tail reads native rows only. */
export function captureEffectsDispatchNativeFence(
  database: DatabaseSync,
  source: EffectsDispatchSource,
): () => void {
  const checks: Array<() => void> = []
  const watch = (sql: string, ...args: Array<string | number>) => {
    const statement = database.prepare(sql)
    const read = statement.get.bind(statement)
    const original = read(...args) as Record<string, unknown> | undefined
    const slots = original
      ? Object.entries(original).map(
          ([key, value]) => [key, value instanceof Uint8Array ? new Uint8Array(value) : value] as const,
        )
      : undefined
    checks.push(() => {
      const current = read(...args) as Record<string, unknown> | undefined
      if (!slots) {
        if (current) integrity('Effects source native row appeared')
        return
      }
      if (!current || Object.keys(current).length !== slots.length)
        integrity('Effects source native row disappeared')
      for (const [key, value] of slots) {
        const next = current[key]
        if (
          value instanceof Uint8Array
            ? !(next instanceof Uint8Array) ||
              value.length !== next.length ||
              value.some((byte, index) => next[index] !== byte)
            : next !== value
        )
          integrity('Effects source native row changed')
      }
    })
    return original
  }
  const ids = [
    source.versions.action.recordId,
    source.versions.run.recordId,
    source.versions.binding.recordId,
    `state-lease:${source.sessionId}`,
  ]
  const commits = new Set<string>()
  for (const id of ids) {
    const head = watch('SELECT * FROM runtime_record_heads WHERE record_id=?', id)
    if (!head || typeof head.record_revision !== 'number' || typeof head.last_commit_id !== 'string')
      integrity('Effects source native head absent')
    watch(
      'SELECT * FROM runtime_version_bodies WHERE record_id=? AND record_revision=?',
      id,
      head.record_revision,
    )
    commits.add(head.last_commit_id)
  }
  for (const commitId of commits) {
    const proof = watch('SELECT * FROM runtime_commit_proofs WHERE commit_id=?', commitId)
    if (!proof || typeof proof.ledger_seq !== 'number') integrity('Effects source native proof absent')
    watch('SELECT * FROM events WHERE session_key=? AND seq=?', source.sessionId, proof.ledger_seq)
  }
  watch('SELECT * FROM runtime_leases WHERE scope_id=?', source.sessionId)
  watch('SELECT * FROM runtime_session_meta WHERE session_id=?', source.sessionId)
  return () => {
    for (const check of checks) check()
  }
}
