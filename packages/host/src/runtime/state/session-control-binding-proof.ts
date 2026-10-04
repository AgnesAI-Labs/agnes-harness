import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { verifyIntegrityRows } from '@agnes/core'
import { EventEnvelope, RuntimeCommitData } from '@agnes/protocol/gen/session-v1'
import { validateRuntime } from '@agnes/protocol/runtime'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { canonicalJson } from './canonical-json.js'
import {
  bodyDigest,
  digestOf,
  MIN_READER,
  mutationDigest,
  RUN_BINDING_SCHEMA,
  runBindingRecordId,
  STATE_COMMIT_EVENT,
  sameJson,
  sideCounts,
  sideListsDigest,
} from './records.js'
import { integrity } from './refusal.js'

const envelope = TypeCompiler.Compile(EventEnvelope)
const commitCodec = TypeCompiler.Compile(RuntimeCommitData)
function json(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== 'string') integrity('original Binding proof JSON missing')
  return JSON.parse(value)
}
function objectJson(value: SQLOutputValue | undefined): Record<string, unknown> {
  const parsed = json(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    integrity('original Binding side JSON invalid')
  return Object.fromEntries(Object.entries(parsed))
}
function frozenRows(read: () => Record<string, SQLOutputValue>[]): () => void {
  const rows = read().map((row) => Object.entries(row))
  return () => {
    const actual = read()
    if (actual.length !== rows.length) integrity('original Binding proof membership changed')
    rows.forEach((fields, i) => {
      const row = actual[i]
      if (
        !row ||
        Object.keys(row).length !== fields.length ||
        fields.some(([key, value]) => row[key] !== value)
      )
        integrity('original Binding proof native bytes changed')
    })
  }
}
/** Authenticate the original official Binding member before capturing its fixed native tail. */
export function captureSessionControlBindingProof(
  db: DatabaseSync,
  runId: string,
  commitId: string,
  ticketId: string,
) {
  const recordId = runBindingRecordId(runId)
  const headStatement = db.prepare('SELECT * FROM runtime_records WHERE record_id=$recordId')
  const readHead = headStatement.all.bind(headStatement, { recordId })
  const original = readHead()[0]
  if (
    !original ||
    original.schema_json !== canonicalJson(RUN_BINDING_SCHEMA) ||
    original.min_reader !== MIN_READER ||
    original.record_revision !== 1 ||
    original.last_commit_id !== commitId
  )
    integrity('original RunBinding official header differs')
  const owner = validateRuntime('RecordOwner', json(original.owner_json))
  const binding = validateRuntime('RunBinding', json(original.value_json))
  if (
    !owner.ok ||
    !binding.ok ||
    original.value_json !== canonicalJson(binding.value) ||
    original.owner_json !== canonicalJson(owner.value) ||
    bodyDigest(owner.value, binding.value) !== original.body_digest ||
    !('sessionId' in owner.value.scope)
  )
    integrity('original RunBinding official body differs')
  const sessionId = owner.value.scope.sessionId
  const versionStatement = db.prepare(
    'SELECT * FROM runtime_record_versions WHERE record_id=$recordId AND record_revision=1 AND commit_id=$commitId',
  )
  const readVersion = versionStatement.all.bind(versionStatement, { recordId, commitId })
  const versions = readVersion()
  const version = versions[0]
  if (
    versions.length !== 1 ||
    !version ||
    version.schema_json !== original.schema_json ||
    version.owner_json !== original.owner_json ||
    version.value_json !== original.value_json ||
    version.digest !== original.body_digest
  )
    integrity('original RunBinding immutable version differs')
  const proofStatement = db.prepare('SELECT * FROM runtime_commit_proofs WHERE commit_id=$commitId')
  const readProof = proofStatement.all.bind(proofStatement, { commitId })
  const proof = readProof()[0]
  if (!proof || typeof proof.ledger_seq !== 'number') integrity('original RunBinding commit proof missing')
  const manifestStatement = db.prepare(
    'SELECT * FROM runtime_mutation_manifests WHERE commit_id=$commitId ORDER BY record_id',
  )
  const readManifests = manifestStatement.all.bind(manifestStatement, { commitId })
  const manifests = readManifests().map((row) => {
    const parsed = validateRuntime('CommitMutationManifest', {
      commitId,
      recordId: row.record_id,
      previousRevision: row.previous_revision,
      next: json(row.next_json),
    })
    if (!parsed.ok) integrity('original RunBinding manifest invalid')
    return parsed.value
  })
  const member = manifests.filter((m) => m.recordId === recordId)
  if (
    member.length !== 1 ||
    member[0]?.previousRevision !== null ||
    member[0].next === null ||
    member[0].next.recordRevision !== 1 ||
    !sameJson(member[0].next.schema, RUN_BINDING_SCHEMA) ||
    member[0].next.digest !== original.body_digest
  )
    integrity('original RunBinding manifest member differs')
  const eventsStatement = db.prepare(
    'SELECT seq,ts,id,type,CAST(lane AS TEXT) lane,v,actor,origin,trust,data,integrity_mode,integrity_prev,integrity_digest FROM events WHERE session_key=$sessionId AND seq<=$seq ORDER BY seq',
  )
  const readEvents = eventsStatement.all.bind(eventsStatement, { sessionId, seq: proof.ledger_seq })
  const rows = readEvents().map((row) => {
    const event = {
      seq: row.seq,
      ts: row.ts,
      id: row.id,
      type: row.type,
      lane: row.lane,
      v: row.v,
      actor: json(row.actor),
      origin: row.origin,
      trust: row.trust,
      data: json(row.data),
    }
    if (
      !envelope.Check(event) ||
      (row.integrity_mode !== 'anchor' && row.integrity_mode !== 'chain') ||
      typeof row.integrity_digest !== 'string' ||
      (row.integrity_prev !== null && typeof row.integrity_prev !== 'string')
    )
      integrity('original RunBinding ledger envelope invalid')
    const mode: 'anchor' | 'chain' = row.integrity_mode
    return {
      sessionKey: sessionId,
      event,
      integrity: {
        mode,
        previousDigest: row.integrity_prev,
        digest: row.integrity_digest,
      },
    }
  })
  verifyIntegrityRows(rows)
  const event = rows.at(-1)?.event
  if (
    !event ||
    event.seq !== proof.ledger_seq ||
    event.type !== STATE_COMMIT_EVENT ||
    !commitCodec.Check(event.data) ||
    event.data.commitId !== commitId ||
    event.data.runId !== runId ||
    event.data.authorityEpoch !== owner.value.authority.authorityEpoch ||
    event.data.mutationCount !== manifests.length ||
    event.data.mutationsDigest !== mutationDigest(manifests)
  )
    integrity('original RunBinding ledger commit differs')
  const sidesStatement = db.prepare(
    'SELECT entry_json FROM runtime_side_entries WHERE commit_id=$commitId ORDER BY kind,identity',
  )
  const readSides = sidesStatement.all.bind(sidesStatement, { commitId })
  const sides = readSides().map((row) => {
    const parsed = validateRuntime('CommitSideEntry', { ...objectJson(row.entry_json), commitId })
    if (!parsed.ok) integrity('original Binding side member invalid')
    return parsed.value
  })
  if (
    !commitCodec.Check(event.data) ||
    event.data.sideListsDigest !== sideListsDigest(sides) ||
    !sameJson(event.data.counts, sideCounts(sides))
  )
    integrity('original Binding side proof differs')
  const admissionStatement = db.prepare(
    'SELECT * FROM runtime_admissions WHERE ticket_id=$ticketId AND run_id=$runId',
  )
  const readAdmission = admissionStatement.all.bind(admissionStatement, { ticketId, runId })
  const admission = readAdmission()[0]
  const admitted = validateRuntime('AdmissionProbe', json(admission?.probe_json))
  if (
    !admitted.ok ||
    admitted.value.state !== 'created' ||
    admitted.value.runId !== runId ||
    admitted.value.commit.sessionId !== sessionId ||
    admitted.value.commit.commitId !== commitId ||
    admitted.value.commit.lastSeq !== proof.ledger_seq ||
    admitted.value.commit.headDigest !== rows.at(-1)?.integrity.digest ||
    admitted.value.commit.transactionFingerprint !== event.data.transactionFingerprint
  )
    integrity('original Binding admission receipt differs')
  const sourceStatement = db.prepare(
    'SELECT * FROM runtime_admission_source_proofs WHERE ticket_id=$ticketId',
  )
  const readSource = sourceStatement.all.bind(sourceStatement, { ticketId })
  const source = readSource()[0]
  if (!source || source.commit_id !== commitId || digestOf(json(source.proof_json)) !== source.proof_digest)
    integrity('original Binding admission source proof missing')
  const checks = [
    readHead,
    readVersion,
    readProof,
    readManifests,
    readEvents,
    readSides,
    readAdmission,
    readSource,
  ].map(frozenRows)
  return Object.freeze({
    original,
    staticCheck() {
      for (const check of checks) check()
    },
  })
}
