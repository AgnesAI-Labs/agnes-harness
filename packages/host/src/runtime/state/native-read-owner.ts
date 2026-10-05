import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type SchemaRef,
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
import { DEFAULT_READABLE, type ReadableSchema, type StateReadWindow } from './read-scope.js'
import {
  ACTION_SCHEMA,
  actionRecordId,
  attemptRecordId,
  compareUtf8,
  RUN_RECORD_SCHEMA,
  runBindingRecordId,
  runRecordId,
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
const SESSION_WINDOW: StateReadWindow = Object.freeze({ kind: 'session' })

export type ScanOptions = Readonly<{
  window?: StateReadWindow
  /** How many of the wanted facts fit the page; at least one, at most all of them. */
  pack?: (facts: readonly NativeStateRecordFact[]) => number
}>

type Relation = Readonly<{
  runId: string
  actionId: string | null
  target: string | null
  kind: ReadableSchema['kind']
}>

/** Whether one record belongs to the caller's window. */
export function inWindow(window: StateReadWindow, rel: Relation): boolean {
  if (window.kind === 'session') return true
  if (rel.runId !== window.runId) return false
  if (window.kind === 'run') return true
  if (rel.kind === 'run' || rel.kind === 'binding') return true
  if (rel.kind === 'signal') return rel.target === window.actionId
  return rel.actionId === window.actionId
}

function refuseRead(): never {
  refuse('denied', 'native_read', 'original State read authority is unavailable')
}

/** A Host-only source of authenticated historical facts. It does not issue public scan items. */
export function createNativeStateReadOwner(
  input: Readonly<{
    originalState: RuntimeStateDatabase
    originalIdentity: LocalDeploymentIdentity
    originalDatabase: DatabaseSync
    readable?: readonly ReadableSchema[]
  }>,
) {
  const { originalState: state, originalIdentity: identity, originalDatabase: database } = input
  const readable = input.readable ?? DEFAULT_READABLE
  const selectedBinding = localDeploymentIdentityBinding(identity, database)
  const selectedPort = captureNativeStateReadPort(
    state,
    identity,
    database,
    readable.map((entry) => entry.schema),
  )
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
    window: StateReadWindow,
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
    const actions = new Map<string, string>()
    for (const fact of facts) {
      if (!sameJson(fact.schema, ACTION_SCHEMA)) continue
      const parsed = validateRuntime('ActionRecordValue', fact.value)
      if (
        !parsed.ok ||
        !runs.has(parsed.value.runId) ||
        fact.recordId !== actionRecordId(parsed.value.actionId)
      )
        refuseRead()
      actions.set(parsed.value.actionId, parsed.value.runId)
    }
    if (
      window.kind !== 'session' &&
      request.filter.runId !== undefined &&
      request.filter.runId !== window.runId
    )
      refuseRead()
    return facts.filter((fact) => {
      const owner = validateRuntime('RecordOwner', fact.owner)
      if (
        !owner.ok ||
        !sameJson(owner.value.authority, port.authority) ||
        !scopeCovers(runtimeScope, owner.value.scope, snapshot.sessionId)
      )
        refuseRead()
      const entry = readable.find((candidate) => sameJson(candidate.schema, fact.schema))
      const kind = entry?.kind
      let rel: Relation
      if (kind === 'run') {
        const run = validateRuntime('RunRecordValue', fact.value)
        if (!run.ok || run.value.sessionId !== snapshot.sessionId) refuseRead()
        rel = { runId: run.value.runId, actionId: null, target: null, kind }
      } else if (kind === 'binding') {
        const matching = [...runs.keys()].find((id) => runBindingRecordId(id) === fact.recordId)
        const value = validateRuntime('RunBinding', fact.value)
        if (!matching || !value.ok || value.value.bindingId !== runs.get(matching)) refuseRead()
        rel = { runId: matching, actionId: null, target: null, kind }
      } else if (kind === 'action') {
        const action = validateRuntime('ActionRecordValue', fact.value)
        if (!action.ok) refuseRead()
        rel = { runId: action.value.runId, actionId: action.value.actionId, target: null, kind }
      } else if (kind === 'attempt') {
        const attempt = validateRuntime('AttemptRecordValue', fact.value)
        const runId = attempt.ok ? actions.get(attempt.value.actionId) : undefined
        if (!attempt.ok || runId === undefined || fact.recordId !== attemptRecordId(attempt.value.attemptId))
          refuseRead()
        rel = { runId, actionId: attempt.value.actionId, target: null, kind }
      } else if (kind === 'signal') {
        const signal = validateRuntime('SignalRecordValue', fact.value)
        if (
          !signal.ok ||
          !runs.has(signal.value.signal.runId) ||
          fact.recordId !== signalRecordId(signal.value.signal.signalId)
        )
          refuseRead()
        rel = {
          runId: signal.value.signal.runId,
          actionId: null,
          target: signal.value.signal.targetActionId,
          kind,
        }
      } else if (kind === 'issuance') {
        const related = entry?.relate?.(fact.value)
        if (!related || !runs.has(related.runId)) refuseRead()
        rel = { runId: related.runId, actionId: related.actionId, target: null, kind }
      } else refuseRead()
      if (!inWindow(window, rel)) return false
      const { filter } = request
      if (request.collection === 'records') {
        if (filter.typeIds && !filter.typeIds.includes(fact.schema.typeId)) return false
        return true
      }
      if (request.collection === 'actions') {
        if (kind !== 'action') return false
        const action = validateRuntime('ActionRecordValue', fact.value)
        if (!action.ok) refuseRead()
        return (
          action.value.runId === filter.runId &&
          runs.has(rel.runId) &&
          (filter.parentActionId === undefined || action.value.parentActionId === filter.parentActionId) &&
          (!filter.states || filter.states.includes(action.value.state))
        )
      }
      if (kind !== 'signal') return false
      const signal = validateRuntime('SignalRecordValue', fact.value)
      if (!signal.ok) refuseRead()
      const value: SignalRecordValue = signal.value
      return (
        value.signal.runId === filter.runId &&
        runs.has(rel.runId) &&
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

  async function openResult(sessionId: string, context: CallContext) {
    const identityDeadline = current(context, sessionId)
    prune()
    if (snapshots.size + pendingSnapshots >= SNAPSHOT_CAP) refuseRead()
    pendingSnapshots++
    try {
      const result = await port.open(sessionId)
      if (result.parent !== null)
        refuse(
          'incompatible',
          'state_session_parent',
          'a session with a parent prefix cannot be read natively',
        )
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
      return Object.freeze({
        snapshot,
        formatVersion: result.formatVersion,
        minReader: result.minReader,
        parent: null,
      })
    } finally {
      pendingSnapshots--
    }
  }

  return Object.freeze({
    openVerifiedResult: openResult,
    async openVerifiedSnapshot(sessionId: string, context: CallContext): Promise<SnapshotRef> {
      return (await openResult(sessionId, context)).snapshot
    },
    /** Frees the snapshot slot and every continuation of that snapshot immediately. */
    releaseSnapshot(snapshot: SnapshotRef, context: CallContext): void {
      const entry = snapshots.get(snapshot.snapshotId)
      if (!entry || entry.original !== snapshot || entry.context !== context) return
      snapshots.delete(snapshot.snapshotId)
      for (const [token, position] of cursors)
        if (position.snapshotId === snapshot.snapshotId) cursors.delete(token)
    },
    /** One record by id inside the window; absent and outside-the-window are the same null. */
    async readVerifiedRecord(
      snapshot: SnapshotRef,
      recordId: string,
      expected: SchemaRef,
      context: CallContext,
      window: StateReadWindow,
    ): Promise<NativeStateRecordFact | null> {
      if (!validateRuntime('SnapshotRef', snapshot).ok) refuseRead()
      entryFor(snapshot, context)
      const facts = await port.facts(snapshot)
      entryFor(snapshot, context)
      const shown = visible(
        facts,
        snapshot,
        { collection: 'records', filter: {}, order: 'asc', cursor: null, limit: 1, snapshot },
        window,
      )
      return shown.find((fact) => fact.recordId === recordId && sameJson(fact.schema, expected)) ?? null
    },
    async scanVerifiedPage(
      snapshot: SnapshotRef,
      request: StateScanRequest,
      context: CallContext,
      options: ScanOptions = {},
    ) {
      const window = options.window ?? SESSION_WINDOW
      if (!validateRuntime('StateScanRequest', request).ok || request.snapshot !== snapshot) refuseRead()
      safeFilter(request)
      const entry = entryFor(snapshot, context)
      const query = canonicalJson({
        collection: request.collection,
        filter: request.filter,
        order: request.order,
        window,
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
      const filtered = visible(facts, snapshot, request, window).map((fact) => ({
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
      const wanted = remaining.slice(0, request.limit)
      const fit = options.pack ? options.pack(wanted.map((item) => item.fact)) : wanted.length
      if (wanted.length > 0 && (!Number.isSafeInteger(fit) || fit < 1 || fit > wanted.length)) refuseRead()
      const page = wanted.slice(0, fit)
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
