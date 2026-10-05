import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type SignalRecordValue,
  type SnapshotRef,
  type StateScanRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type LocalDeploymentIdentity,
  localDeploymentIdentityBinding,
} from '../identity/local-deployment-identity.js'
import { canonicalJson } from './canonical-json.js'
import {
  ACTION_SCHEMA,
  actionRecordId,
  compareUtf8,
  RUN_BINDING_SCHEMA,
  RUN_RECORD_SCHEMA,
  runBindingRecordId,
  runRecordId,
  SIGNAL_SCHEMA,
  sameJson,
  signalRecordId,
} from './records.js'
import { refuse } from './refusal.js'
import {
  captureNativeStateReadPort,
  type NativeStateRecordFact,
  type RuntimeStateDatabase,
  runtimeStateUsesDatabase,
} from './transactions.js'

type SnapshotEntry = {
  original: SnapshotRef
  bytes: string
  context: CallContext
  principalRef: string
  deadline: number
}
type CursorEntry = {
  snapshotId: string
  query: string
  after: string
  deadline: number
}
const SNAPSHOT_CAP = 128
const CURSOR_CAP = 1024

function refuseRead(): never {
  refuse('denied', 'native_read', 'original State read authority is unavailable')
}

/** A Host-only source of authenticated historical facts. It does not issue public scan items. */
export function createNativeStateReadOwner(
  input: Readonly<{
    originalState: RuntimeStateDatabase
    originalIdentity: LocalDeploymentIdentity
    originalDatabase: DatabaseSync
  }>,
) {
  const { originalState: state, originalIdentity: identity, originalDatabase: database } = input
  const selectedBinding = localDeploymentIdentityBinding(identity, database)
  const selectedPort = captureNativeStateReadPort(state, identity, database)
  if (!selectedBinding || !selectedPort || !runtimeStateUsesDatabase(state, database)) refuseRead()
  const selectedScope = selectedBinding.scope
  if (selectedScope.kind !== 'runtime') refuseRead()
  const binding = selectedBinding
  const port = selectedPort
  const runtimeScope = selectedScope
  const snapshots = new Map<string, SnapshotEntry>()
  const cursors = new Map<string, CursorEntry>()
  let closed = false
  let pendingSnapshots = 0

  function current(context: CallContext, sessionId: string): number {
    if (closed || !runtimeStateUsesDatabase(state, database)) refuseRead()
    const selected = localDeploymentIdentityBinding(identity, database)
    if (
      !selected ||
      !sameJson(selected.scope, binding.scope) ||
      !sameJson(selected.authority, port.authority)
    )
      refuseRead()
    if (!sameJson(context.scope, binding.scope) || context.principalRef !== binding.owner.facts.principalRef)
      refuseRead()
    if (context.signal.aborted) refuseRead()
    const capture = identity.capture(context)
    capture.dynamicCheck()
    if (!sessionId) refuseRead()
    const deadline = Date.parse(capture.deadline)
    if (!Number.isFinite(deadline) || deadline <= port.now()) refuseRead()
    return deadline
  }

  function prune(): void {
    const now = port.now()
    for (const [id, entry] of snapshots) if (entry.deadline <= now) snapshots.delete(id)
    for (const [id, entry] of cursors)
      if (entry.deadline <= now || !snapshots.has(entry.snapshotId)) cursors.delete(id)
  }

  function entryFor(snapshot: SnapshotRef, context: CallContext): SnapshotEntry {
    prune()
    const entry = snapshots.get(snapshot.snapshotId)
    if (
      !entry ||
      entry.original !== snapshot ||
      entry.context !== context ||
      entry.bytes !== canonicalJson(snapshot) ||
      entry.principalRef !== context.principalRef ||
      entry.deadline <= port.now()
    )
      refuseRead()
    current(context, snapshot.sessionId)
    return entry
  }

  function safeFilter(request: StateScanRequest): void {
    const keys = Object.keys(request.filter)
    const allowed =
      request.collection === 'records'
        ? ['typeIds']
        : request.collection === 'actions'
          ? ['runId', 'parentActionId', 'states']
          : request.collection === 'signals'
            ? ['runId', 'targetActionId', 'typeIds', 'fromSeq', 'toSeq']
            : []
    if (
      !['records', 'actions', 'signals'].includes(request.collection) ||
      keys.some((key) => !allowed.includes(key)) ||
      request.limit < 1 ||
      request.limit > 500 ||
      ((request.collection === 'actions' || request.collection === 'signals') && !request.filter.runId) ||
      (request.filter.fromSeq !== undefined &&
        request.filter.toSeq !== undefined &&
        request.filter.fromSeq > request.filter.toSeq)
    )
      refuseRead()
  }

  function visible(
    facts: readonly NativeStateRecordFact[],
    snapshot: SnapshotRef,
    request: StateScanRequest,
  ) {
    const runs = new Map<string, string>()
    for (const fact of facts) {
      if (!sameJson(fact.schema, RUN_RECORD_SCHEMA)) continue
      const parsed = validateRuntime('RunRecordValue', fact.value)
      if (
        !parsed.ok ||
        parsed.value.sessionId !== snapshot.sessionId ||
        fact.recordId !== runRecordId(parsed.value.runId)
      )
        refuseRead()
      runs.set(parsed.value.runId, parsed.value.bindingId)
    }
    return facts.filter((fact) => {
      const owner = validateRuntime('RecordOwner', fact.owner)
      if (
        !owner.ok ||
        !sameJson(owner.value.authority, port.authority) ||
        !scopeCovers(runtimeScope, owner.value.scope, snapshot.sessionId)
      )
        refuseRead()
      let runId: string
      if (sameJson(fact.schema, RUN_RECORD_SCHEMA)) {
        const run = validateRuntime('RunRecordValue', fact.value)
        if (!run.ok || run.value.sessionId !== snapshot.sessionId) refuseRead()
        runId = run.value.runId
      } else if (sameJson(fact.schema, RUN_BINDING_SCHEMA)) {
        const matching = [...runs.keys()].find((id) => runBindingRecordId(id) === fact.recordId)
        const value = validateRuntime('RunBinding', fact.value)
        if (!matching || !value.ok || value.value.bindingId !== runs.get(matching)) refuseRead()
        runId = matching
      } else if (sameJson(fact.schema, ACTION_SCHEMA)) {
        const action = validateRuntime('ActionRecordValue', fact.value)
        if (
          !action.ok ||
          !runs.has(action.value.runId) ||
          fact.recordId !== actionRecordId(action.value.actionId)
        )
          refuseRead()
        runId = action.value.runId
      } else {
        const signal = validateRuntime('SignalRecordValue', fact.value)
        if (
          !signal.ok ||
          !runs.has(signal.value.signal.runId) ||
          fact.recordId !== signalRecordId(signal.value.signal.signalId)
        )
          refuseRead()
        runId = signal.value.signal.runId
      }
      const { filter } = request
      if (request.collection === 'records') {
        if (
          ![RUN_RECORD_SCHEMA, RUN_BINDING_SCHEMA, ACTION_SCHEMA, SIGNAL_SCHEMA].some((schema) =>
            sameJson(schema, fact.schema),
          )
        )
          return false
        if (filter.typeIds && !filter.typeIds.includes(fact.schema.typeId)) return false
        return true
      }
      if (request.collection === 'actions') {
        if (!sameJson(fact.schema, ACTION_SCHEMA)) return false
        const action = validateRuntime('ActionRecordValue', fact.value)
        if (!action.ok) refuseRead()
        return (
          action.value.runId === filter.runId &&
          runs.has(runId) &&
          (filter.parentActionId === undefined || action.value.parentActionId === filter.parentActionId) &&
          (!filter.states || filter.states.includes(action.value.state))
        )
      }
      if (!sameJson(fact.schema, SIGNAL_SCHEMA)) return false
      const signal = validateRuntime('SignalRecordValue', fact.value)
      if (!signal.ok) refuseRead()
      const value: SignalRecordValue = signal.value
      return (
        value.signal.runId === filter.runId &&
        runs.has(runId) &&
        (filter.targetActionId === undefined || value.signal.targetActionId === filter.targetActionId) &&
        (!filter.typeIds || filter.typeIds.includes(value.signal.typeId)) &&
        (filter.fromSeq === undefined || value.signal.seq >= filter.fromSeq) &&
        (filter.toSeq === undefined || value.signal.seq <= filter.toSeq)
      )
    })
  }

  function keyFor(fact: NativeStateRecordFact, collection: StateScanRequest['collection']): string {
    if (collection === 'actions') {
      const parsed = validateRuntime('ActionRecordValue', fact.value)
      if (!parsed.ok) refuseRead()
      return `${parsed.value.runId}\0${parsed.value.parentActionId ?? ''}\0${parsed.value.key}\0${parsed.value.actionId}`
    }
    if (collection === 'signals') {
      const parsed = validateRuntime('SignalRecordValue', fact.value)
      if (!parsed.ok) refuseRead()
      const signal = parsed.value.signal
      return `${signal.runId}\0${signal.targetActionId ?? ''}\0${String(signal.seq).padStart(16, '0')}\0${signal.signalId}`
    }
    return fact.recordId
  }

  return Object.freeze({
    async openVerifiedSnapshot(sessionId: string, context: CallContext): Promise<SnapshotRef> {
      const identityDeadline = current(context, sessionId)
      prune()
      if (snapshots.size + pendingSnapshots >= SNAPSHOT_CAP) refuseRead()
      pendingSnapshots++
      try {
        const result = await port.open(sessionId)
        const afterIdentityDeadline = current(context, sessionId)
        const snapshot = result.snapshot
        const deadline = Math.min(
          Date.parse(snapshot.expiresAt),
          Date.parse(context.deadline),
          identityDeadline,
          afterIdentityDeadline,
        )
        if (
          !validateRuntime('SnapshotRef', snapshot).ok ||
          result.claim !== null ||
          snapshot.sessionId !== sessionId ||
          !sameJson(snapshot.authority, port.authority) ||
          !Number.isFinite(deadline) ||
          deadline <= port.now() ||
          snapshots.has(snapshot.snapshotId)
        )
          refuseRead()
        snapshots.set(snapshot.snapshotId, {
          original: snapshot,
          bytes: canonicalJson(snapshot),
          context,
          principalRef: context.principalRef,
          deadline,
        })
        return snapshot
      } finally {
        pendingSnapshots--
      }
    },
    async scanVerifiedPage(snapshot: SnapshotRef, request: StateScanRequest, context: CallContext) {
      if (!validateRuntime('StateScanRequest', request).ok || request.snapshot !== snapshot) refuseRead()
      safeFilter(request)
      const entry = entryFor(snapshot, context)
      const query = canonicalJson({
        collection: request.collection,
        filter: request.filter,
        order: request.order,
      })
      let after: string | null = null
      if (request.cursor !== null) {
        const cursor = cursors.get(request.cursor)
        if (
          !cursor ||
          cursor.snapshotId !== snapshot.snapshotId ||
          cursor.query !== query ||
          cursor.deadline !== entry.deadline
        )
          refuseRead()
        after = cursor.after
      }
      const facts = await port.facts(snapshot)
      entryFor(snapshot, context)
      const filtered = visible(facts, snapshot, request).map((fact) => ({
        fact,
        key: keyFor(fact, request.collection),
      }))
      filtered.sort((a, b) => compareUtf8(a.key, b.key))
      if (request.order === 'desc') filtered.reverse()
      const remaining =
        after === null
          ? filtered
          : filtered.filter((item) =>
              request.order === 'asc' ? compareUtf8(item.key, after) > 0 : compareUtf8(item.key, after) < 0,
            )
      const page = remaining.slice(0, request.limit)
      const items = page.map((item) => item.fact)
      let nextCursor: string | null = null
      if (remaining.length > items.length) {
        prune()
        const last = page.at(-1)
        if (!last) refuseRead()
        for (const [token, position] of cursors) {
          if (
            position.snapshotId === snapshot.snapshotId &&
            position.query === query &&
            position.after === last.key &&
            position.deadline === entry.deadline
          ) {
            nextCursor = token
            break
          }
        }
        if (nextCursor === null) {
          if (cursors.size >= CURSOR_CAP) refuseRead()
          nextCursor = randomUUID()
          cursors.set(nextCursor, {
            snapshotId: snapshot.snapshotId,
            query,
            after: last.key,
            deadline: entry.deadline,
          })
        }
      }
      entryFor(snapshot, context)
      return Object.freeze({ items, nextCursor, complete: nextCursor === null })
    },
    close() {
      closed = true
      snapshots.clear()
      cursors.clear()
    },
  })
}

function scopeCovers(
  runtime: { installationId: string; runtimeId: string },
  scope: unknown,
  sessionId: string,
) {
  const parsed = validateRuntime('ScopeRef', scope)
  return (
    parsed.ok &&
    parsed.value.installationId === runtime.installationId &&
    'runtimeId' in parsed.value &&
    parsed.value.runtimeId === runtime.runtimeId &&
    (!('sessionId' in parsed.value) || parsed.value.sessionId === sessionId)
  )
}
