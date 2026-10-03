import type { DatabaseSync } from 'node:sqlite'
import { type ActionRecordValue, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { canonicalJson } from './canonical-json.js'
import {
  bodyDigest,
  emptyIntegrity,
  isSideEntry,
  mutationDigest,
  protectEvent,
  sideListsDigest,
} from './records.js'

function refuse(): never {
  throw new Error('Original parent accounting membership is unavailable')
}
function text(value: unknown): string {
  if (typeof value !== 'string') refuse()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) refuse()
  return value
}

function nativeEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const left = Object.getOwnPropertyDescriptors(a),
    right = Object.getOwnPropertyDescriptors(b)
  const keys = Reflect.ownKeys(left)
  if (keys.length !== Reflect.ownKeys(right).length) return false
  return keys.every((key) => {
    const x = Object.getOwnPropertyDescriptor(a, key),
      y = Object.getOwnPropertyDescriptor(b, key)
    return x !== undefined && y !== undefined && 'value' in x && 'value' in y && nativeEqual(x.value, y.value)
  })
}

/** Native membership only; selected Usage/settlement issuance must still be verified separately. */
export function createParentMembershipReader(database: DatabaseSync) {
  const head = database.prepare('SELECT * FROM runtime_records WHERE record_id=?')
  const version = database.prepare(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND record_revision=1',
  )
  const proof = database.prepare('SELECT * FROM runtime_commit_proofs WHERE commit_id=?')
  const children = database.prepare(
    "SELECT identity FROM runtime_side_entries WHERE kind='action-created' ORDER BY identity",
  )
  const runAt = database.prepare(
    'SELECT v.* FROM runtime_record_versions v JOIN runtime_commit_proofs p ON p.commit_id=v.commit_id WHERE v.record_id=? AND p.ledger_seq<=? ORDER BY p.ledger_seq DESC LIMIT 1',
  )
  const revision = database.prepare(
    'SELECT * FROM runtime_record_versions WHERE record_id=? AND record_revision=?',
  )
  const ledger = database.prepare(
    "SELECT * FROM events WHERE type='runtime/state-commit' AND json_extract(data,'$.commitId')=?",
  )
  const prefix = database.prepare('SELECT * FROM events WHERE session_key=? AND seq<=? ORDER BY seq')
  const allPrefix = prefix.all.bind(prefix)
  const getRevision = revision.get.bind(revision),
    allLedger = ledger.all.bind(ledger)
  const getHead = head.get.bind(head),
    getVersion = version.get.bind(version),
    getProof = proof.get.bind(proof),
    allChildren = children.all.bind(children),
    getRun = runAt.get.bind(runAt)
  function read<
    K extends 'ActionRecordValue' | 'RunRecordValue' | 'ReceiptRecordValue' | 'AttemptRecordValue',
  >(name: K, id: string, row: ReturnType<typeof getHead>) {
    if (!row || row.record_id !== id) refuse()
    const schema = validateRuntime('SchemaRef', JSON.parse(text(row.schema_json)))
    const expected = RuntimeSchemaRefs[name]
    if (!schema.ok || !expected || canonicalJson(schema.value) !== canonicalJson(expected)) refuse()
    const owner = JSON.parse(text(row.owner_json)),
      raw = JSON.parse(text(row.value_json))
    const value = validateRuntime(name, raw)
    if (!value.ok || bodyDigest(owner, raw) !== (row.body_digest ?? row.digest)) refuse()
    const recordRevision = integer(row.record_revision)
    if (row.min_reader !== undefined && integer(row.min_reader) > 2) refuse()
    const originalVersion = getRevision(id, recordRevision)
    if (
      !originalVersion ||
      originalVersion.value_json !== row.value_json ||
      originalVersion.owner_json !== row.owner_json ||
      originalVersion.schema_json !== row.schema_json ||
      originalVersion.digest !== (row.body_digest ?? row.digest) ||
      originalVersion.commit_id !== (row.last_commit_id ?? row.commit_id)
    )
      refuse()
    const commitId = text(originalVersion.commit_id),
      nativeProof = getProof(commitId),
      events = allLedger(commitId)
    if (!nativeProof || events.length !== 1 || events[0]?.seq !== nativeProof.ledger_seq) refuse()
    const session = text(events[0]?.session_key),
      ledgerRows = allPrefix(session, integer(nativeProof.ledger_seq))
    const commitData = JSON.parse(text(events[0]?.data))
    const nativeRunId = text(commitData.runId),
      namespaceRow = getHead(`run:${nativeRunId}`)
    if (!namespaceRow) refuse()
    const namespaceValue = validateRuntime('RunRecordValue', JSON.parse(text(namespaceRow.value_json)))
    const namespaceOwner = JSON.parse(text(namespaceRow.owner_json))
    if (
      !namespaceValue.ok ||
      namespaceValue.value.runId !== nativeRunId ||
      namespaceValue.value.sessionId !== session ||
      namespaceRow.schema_json !== canonicalJson(RuntimeSchemaRefs.RunRecordValue) ||
      bodyDigest(namespaceOwner, namespaceValue.value) !== namespaceRow.body_digest ||
      canonicalJson(namespaceOwner.authority) !== canonicalJson(owner.authority) ||
      namespaceOwner.scope.installationId !== owner.scope.installationId
    )
      refuse()
    if (
      owner.scope.sessionId !== undefined
        ? owner.scope.sessionId !== session
        : owner.scope.kind !== 'installation'
    )
      refuse()

    let integrity = emptyIntegrity()
    for (const eventRow of ledgerRows) {
      const seq = integer(eventRow.seq)
      if (
        eventRow.integrity_mode === null &&
        eventRow.integrity_prev === null &&
        eventRow.integrity_digest === null
      ) {
        if (integrity.headDigest !== null || seq !== integrity.lastSeq + 1) refuse()
        integrity = { lastSeq: seq, legacyThroughSeq: seq, headDigest: null }
        continue
      }
      const event = {
        seq,
        ts: text(eventRow.ts),
        id: text(eventRow.id),
        type: text(eventRow.type),
        lane: eventRow.lane instanceof Uint8Array ? Buffer.from(eventRow.lane).toString('utf8') : refuse(),
        v: integer(eventRow.v),
        actor: JSON.parse(text(eventRow.actor)),
        origin: text(eventRow.origin),
        trust: text(eventRow.trust),
        data: JSON.parse(text(eventRow.data)),
      }
      const checked = protectEvent(session, event, integrity)
      if (
        checked.integrity.mode !== eventRow.integrity_mode ||
        checked.integrity.previousDigest !== eventRow.integrity_prev ||
        checked.integrity.digest !== eventRow.integrity_digest
      )
        refuse()
      integrity = checked.state
    }
    if (integrity.lastSeq !== nativeProof.ledger_seq || integrity.headDigest === null) refuse()
    const versions = JSON.parse(text(nativeProof.versions_json)),
      packed = Array.isArray(versions)
        ? versions.filter((v) => v.recordId === id && v.recordRevision === recordRevision)
        : []
    const v = packed[0]
    if (
      packed.length !== 1 ||
      !v ||
      v.schemaJson !== row.schema_json ||
      v.ownerJson !== row.owner_json ||
      v.digest !== originalVersion.digest ||
      v.hasBody !== true
    )
      refuse()
    const data = JSON.parse(text(events[0]?.data)),
      manifests = JSON.parse(text(nativeProof.manifests_json)),
      sides = JSON.parse(text(nativeProof.sides_json))
    if (
      !Array.isArray(manifests) ||
      !Array.isArray(sides) ||
      !sides.every((s) => isSideEntry(JSON.parse(text(s.entryJson))))
    )
      refuse()
    const decodedManifests = manifests.map((m) => ({
      commitId,
      recordId: m.recordId,
      previousRevision: m.previousRevision,
      next: m.nextJson === null ? null : JSON.parse(text(m.nextJson)),
    }))
    const ownManifest = decodedManifests.filter((m) => m.recordId === id)
    const next = ownManifest[0]?.next
    if (
      ownManifest.length !== 1 ||
      !next ||
      next.recordRevision !== recordRevision ||
      next.digest !== originalVersion.digest ||
      canonicalJson(next.schema) !== canonicalJson(schema.value)
    )
      refuse()
    if (
      data.commitId !== commitId ||
      data.mutationCount !== manifests.length ||
      data.mutationsDigest !== mutationDigest(decodedManifests) ||
      data.sideListsDigest !== sideListsDigest(sides.map((s) => JSON.parse(text(s.entryJson))))
    )
      refuse()
    return {
      value: value.value,
      owner,
      row,
      finalCheck() {
        if (
          !nativeEqual(getHead(`run:${nativeRunId}`), namespaceRow) ||
          !nativeEqual(getRevision(id, recordRevision), originalVersion) ||
          !nativeEqual(getProof(commitId), nativeProof) ||
          !nativeEqual(allLedger(commitId), events) ||
          !nativeEqual(allPrefix(session, integer(nativeProof.ledger_seq)), ledgerRows)
        )
          refuse()
      },
    }
  }
  function snapshot(parentId: string) {
    const watched: { read: () => unknown; value: unknown }[] = []
    function watch<T>(read: () => T): T {
      const value = read()
      watched.push({ read, value })
      return value
    }
    const parent = read(
      'ActionRecordValue',
      `action:${parentId}`,
      watch(() => getHead(`action:${parentId}`)),
    )
    const run = read(
      'RunRecordValue',
      `run:${parent.value.runId}`,
      watch(() => getHead(`run:${parent.value.runId}`)),
    )
    const gates = [parent.finalCheck, run.finalCheck]
    const ids = watch(() => allChildren())
    const members = ids.flatMap((item) => {
      const id = `action:${text(item.identity)}`,
        current = read(
          'ActionRecordValue',
          id,
          watch(() => getHead(id)),
        )
      const original = read(
        'ActionRecordValue',
        id,
        watch(() => getVersion(id)),
      )
      gates.push(current.finalCheck, original.finalCheck)
      if (original.value.parentActionId !== parentId) return []
      const commit = watch(() => getProof(original.value.createdByCommitId))
      if (!commit || original.row.commit_id !== original.value.createdByCommitId) refuse()
      const manifests = JSON.parse(text(commit.manifests_json)),
        sides = JSON.parse(text(commit.sides_json))
      if (!Array.isArray(manifests) || !Array.isArray(sides)) refuse()
      const entry = manifests.filter((m) => m.recordId === id)
      if (entry.length !== 1 || entry[0].previousRevision !== null) refuse()
      const next = JSON.parse(text(entry[0].nextJson))
      if (
        next.recordRevision !== 1 ||
        next.digest !== original.row.digest ||
        canonicalJson(next.schema) !== canonicalJson(RuntimeSchemaRefs.ActionRecordValue)
      )
        refuse()
      const created = sides.filter(
        (s) => s.kind === 'action-created' && s.identity === original.value.actionId,
      )
      if (created.length !== 1) refuse()
      const historicalRun = read(
        'RunRecordValue',
        `run:${parent.value.runId}`,
        watch(() => getRun(`run:${parent.value.runId}`, integer(commit.ledger_seq))),
      )
      gates.push(historicalRun.finalCheck)
      if (
        original.value.parentActionId !== parentId ||
        current.value.parentActionId !== parentId ||
        original.value.runId !== run.value.runId ||
        current.value.runId !== run.value.runId ||
        historicalRun.value.sessionId !== run.value.sessionId ||
        current.value.createdByCommitId !== original.value.createdByCommitId ||
        current.value.intentFingerprint !== original.value.intentFingerprint ||
        canonicalJson(current.value.intent) !== canonicalJson(original.value.intent) ||
        current.value.key !== original.value.key ||
        canonicalJson(current.owner) !== canonicalJson(original.owner)
      )
        refuse()
      // Run has its own owner binding; only the actual authority and namespace are shared.
      if (
        canonicalJson(parent.owner.authority) !== canonicalJson(original.owner.authority) ||
        canonicalJson(parent.owner.scope) !== canonicalJson(original.owner.scope) ||
        canonicalJson(run.owner.authority) !== canonicalJson(original.owner.authority)
      )
        refuse()
      return [{ action: current.value, originalAction: original.value, historicalRun: historicalRun.value }]
    })
    return {
      parent: parent.value,
      run: run.value,
      children: members,
      finalCheck() {
        for (const gate of gates) gate()
        for (const item of watched) if (!nativeEqual(item.read(), item.value)) refuse()
      },
    }
  }
  function usageReferences(parentId: string, supplied: readonly string[]) {
    const membership = snapshot(parentId),
      refs: string[] = [],
      gates: (() => void)[] = [],
      watched: { id: string; value: unknown }[] = []
    if (membership.children.length === 0) refuse()
    for (const child of membership.children) {
      const action: ActionRecordValue = child.action
      if (!action.resolvedReceiptId || !action.currentAttemptId) refuse()
      const receiptId = `receipt:${action.resolvedReceiptId}`,
        attemptId = `attempt:${action.currentAttemptId}`
      const receipt = read('ReceiptRecordValue', receiptId, getHead(receiptId)),
        attempt = read('AttemptRecordValue', attemptId, getHead(attemptId))
      gates.push(receipt.finalCheck, attempt.finalCheck)
      if (
        action.state !== 'settled' ||
        attempt.value.state !== 'settled' ||
        attempt.value.attemptId !== action.currentAttemptId ||
        !attempt.value.receiptIds.includes(receipt.value.receipt.receiptId) ||
        receipt.value.receipt.inputDigest !== attempt.value.inputDigest ||
        canonicalJson(receipt.value.receipt.externalRequests) !==
          canonicalJson(attempt.value.externalRequests) ||
        receipt.value.receipt.actionId !== action.actionId ||
        receipt.value.receipt.attemptId !== attempt.value.attemptId ||
        attempt.value.actionId !== action.actionId ||
        receipt.value.receipt.bindingId !== action.intent.target.bindingId ||
        canonicalJson(receipt.owner) !== canonicalJson(attempt.owner)
      )
        refuse()
      refs.push(...receipt.value.receipt.usageRefs)
      watched.push({ id: receiptId, value: receipt.row }, { id: attemptId, value: attempt.row })
    }
    if (
      new Set(refs).size !== refs.length ||
      new Set(supplied).size !== supplied.length ||
      canonicalJson([...supplied].sort()) !== canonicalJson([...refs].sort())
    )
      refuse()
    return {
      ...membership,
      usageRefs: Object.freeze(refs),
      finalCheck() {
        membership.finalCheck()
        for (const gate of gates) gate()
        for (const item of watched) if (!nativeEqual(getHead(item.id), item.value)) refuse()
      },
    }
  }
  return Object.freeze({ readChildren: snapshot, readUsageReferences: usageReferences })
}
