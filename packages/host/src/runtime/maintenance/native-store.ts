import { DatabaseSync, type SQLInputValue, StatementSync } from 'node:sqlite'
import { types } from 'node:util'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type MaintenanceEnvelopeJsonValue,
  type MaintenanceStoreCommitRequest,
  type MaintenanceStoreCommitResult,
  type ScopeRef,
  type StateAuthorityRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type LocalDeploymentIdentity,
  localDeploymentIdentityBinding,
} from '../identity/local-deployment-identity.js'

const ownKeys = Object.keys
const ownDescriptor = Object.getOwnPropertyDescriptor
const nativePrepare = DatabaseSync.prototype.prepare
const nativeExec = DatabaseSync.prototype.exec
const nativeGet: (...parameters: SQLInputValue[]) => ReturnType<StatementSync['get']> =
  StatementSync.prototype.get
const nativeAll: (...parameters: SQLInputValue[]) => ReturnType<StatementSync['all']> =
  StatementSync.prototype.all
const nativeRun: (...parameters: SQLInputValue[]) => ReturnType<StatementSync['run']> =
  StatementSync.prototype.run
function sql(database: DatabaseSync, query: string) {
  const statement = nativePrepare.call(database, query)
  return { get: nativeGet.bind(statement), all: nativeAll.bind(statement), run: nativeRun.bind(statement) }
}

const tables = [
  'runtime_native_maintenance_installation',
  'runtime_native_maintenance_commits',
  'runtime_native_maintenance_versions',
] as const
const schema = [
  'CREATE TABLE runtime_native_maintenance_installation (id TEXT PRIMARY KEY,body_json TEXT NOT NULL,head_json TEXT NOT NULL)',
  'CREATE TABLE runtime_native_maintenance_commits (id TEXT PRIMARY KEY,request_json TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL)',
  'CREATE TABLE runtime_native_maintenance_versions (record_id TEXT NOT NULL,revision INTEGER NOT NULL,commit_id TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(record_id,revision))',
] as const
const owners = new WeakSet<object>()
export type NativeMaintenanceOwner = ReturnType<typeof createNativeMaintenanceOwner>
export function isNativeMaintenanceOwner(value: unknown): value is NativeMaintenanceOwner {
  return typeof value === 'object' && value !== null && owners.has(value)
}
function wire<T>(
  name: 'MaintenanceStoreCommitRequest' | 'MaintenanceStoreCommitResult' | 'MaintenanceEnvelopeJsonValue',
  value: T,
): T {
  if (!validateRuntime(name, value).ok) throw new Error('Native maintenance schema is invalid')
  return value
}
function fixed<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) fixed(child)
    Object.freeze(value)
  }
  return value
}
function originalMethod(object: object, name: string): void {
  const slot = Object.getOwnPropertyDescriptor(object, name)
  if (!slot || !('value' in slot) || typeof slot.value !== 'function' || !Object.isFrozen(object))
    throw new Error('Original maintenance identity method is required')
}

function retainedReader(
  db: DatabaseSync,
  identityInstallationId: string,
  config: Readonly<{
    authority: StateAuthorityRef
    scope: ScopeRef
    writerEpoch: number
  }>,
) {
  const configJson = jcs(config),
    id = canonicalJsonDigest(config),
    epoch = config.writerEpoch
  const anchor = jcs({ phase: 'installed', id, config, structures: schema })
  const slotStatement = sql(db, 'SELECT maintenance_json FROM runtime_local_identity_installation WHERE id=?')
  const slotGet = slotStatement.get.bind(slotStatement)
  for (let index = 0; index < tables.length; index++) {
    const name = tables[index]
    if (!name) throw new Error('Original maintenance table is missing')
    const row = sql(db, 'SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)
    if (row?.sql !== schema[index]) throw new Error('Original maintenance structure changed')
  }
  const installation = sql(db, 'SELECT * FROM runtime_native_maintenance_installation WHERE id=?')
  const installationGet = installation.get.bind(installation)
  function installed(): void {
    if (
      slotGet(identityInstallationId)?.maintenance_json !== anchor ||
      installationGet(id)?.body_json !== configJson
    )
      throw new Error('Original maintenance installation evidence is missing')
  }
  installed()
  const commitStatement = sql(db, 'SELECT * FROM runtime_native_maintenance_commits WHERE id=?')
  const commitGet = commitStatement.get.bind(commitStatement)
  const versionStatement = sql(
    db,
    'SELECT body_json,commit_id FROM runtime_native_maintenance_versions WHERE record_id=? ORDER BY revision DESC LIMIT 1',
  )
  const versionGet = versionStatement.get.bind(versionStatement)
  const allVersions = sql(db, 'SELECT * FROM runtime_native_maintenance_versions ORDER BY record_id,revision')
  const allVersionsGet = allVersions.all.bind(allVersions)
  const allCommits = sql(db, 'SELECT * FROM runtime_native_maintenance_commits ORDER BY id')
  const allCommitsGet = allCommits.all.bind(allCommits)
  const structural = sql(db, 'SELECT name,sql FROM sqlite_master WHERE name IN (?,?,?) ORDER BY name')
  const structuralGet = structural.all.bind(structural, ...tables)
  type Rows = ReturnType<StatementSync['all']>
  function sameRows(actual: Rows, expected: Rows): void {
    if (actual.length !== expected.length) throw new Error('Original maintenance native rows changed')
    for (let i = 0; i < actual.length; i++) {
      const left = actual[i],
        right = expected[i]
      if (!left || !right) throw new Error('Original maintenance row is missing')
      const keys = ownKeys(right)
      if (ownKeys(left).length !== keys.length) throw new Error('Original maintenance columns changed')
      for (let column = 0; column < keys.length; column++) {
        const key = keys[column]
        if (key === undefined) throw new Error('Original maintenance column is missing')
        const a = ownDescriptor(left, key),
          b = ownDescriptor(right, key)
        if (!a || !b || !('value' in a) || !('value' in b) || a.value !== b.value)
          throw new Error('Original maintenance native row changed')
      }
    }
  }
  function nativeFence() {
    const versions = allVersionsGet(),
      commits = allCommitsGet(),
      structure = structuralGet(),
      head = installationGet(id)?.head_json
    return () => {
      installed()
      if (installationGet(id)?.head_json !== head) throw new Error('Original maintenance commit head changed')
      sameRows(allVersionsGet(), versions)
      sameRows(allCommitsGet(), commits)
      sameRows(structuralGet(), structure)
    }
  }
  function readCommit(transactionId: string) {
    installed()
    const row = commitGet(transactionId)
    if (!row || typeof row.request_json !== 'string' || typeof row.result_json !== 'string')
      throw new Error('Original maintenance commit is missing')
    const request = wire(
      'MaintenanceStoreCommitRequest',
      JSON.parse(row.request_json) as MaintenanceStoreCommitRequest,
    )
    const result = wire(
      'MaintenanceStoreCommitResult',
      JSON.parse(row.result_json) as MaintenanceStoreCommitResult,
    )
    if (
      request.transactionId !== transactionId ||
      result.transactionId !== transactionId ||
      jcs(request.authority) !== jcs(config.authority) ||
      request.expectedWriterEpoch !== epoch ||
      request.outbox.length !== 0 ||
      row.fingerprint !== canonicalJsonDigest(request) ||
      result.revisions.length !== request.mutations.length
    )
      throw new Error('Original maintenance commit proof is invalid')
    const records = request.mutations.map((mutation, index) => {
      const original = sql(
        db,
        'SELECT body_json FROM runtime_native_maintenance_versions WHERE record_id=? AND revision=? AND commit_id=?',
      ).get(mutation.recordId, mutation.next.revision, transactionId)
      const previousRow =
        mutation.expectedRevision === null
          ? undefined
          : sql(
              db,
              'SELECT body_json FROM runtime_native_maintenance_versions WHERE record_id=? AND revision=?',
            ).get(mutation.recordId, mutation.expectedRevision)
      const previous = previousRow
        ? wire(
            'MaintenanceEnvelopeJsonValue',
            JSON.parse(String(previousRow.body_json)) as MaintenanceEnvelopeJsonValue,
          )
        : null
      if (
        (previous?.revision ?? null) !== mutation.expectedRevision ||
        mutation.next.recordId !== mutation.recordId ||
        mutation.next.revision !== (previous?.revision ?? 0) + 1 ||
        mutation.next.writerEpoch !== epoch ||
        (previous &&
          (previous.writerEpoch !== epoch ||
            previous.createdAt !== mutation.next.createdAt ||
            Date.parse(previous.updatedAt) > Date.parse(mutation.next.updatedAt)))
      )
        throw new Error('Original maintenance CAS history is invalid')
      const revision = result.revisions[index]
      if (
        !original ||
        original.body_json !== jcs(mutation.next) ||
        revision?.recordId !== mutation.recordId ||
        revision.revision !== mutation.next.revision ||
        mutation.next.fingerprint !== canonicalJsonDigest(mutation.next.payload)
      )
        throw new Error('Original maintenance member proof is invalid')
      return mutation.next
    })
    return fixed({ request, result, records, staticCheck: nativeFence() })
  }
  function completeHistory(): void {
    const headJson = installationGet(id)?.head_json
    if (typeof headJson !== 'string') throw new Error('Original maintenance commit head is missing')
    const head: unknown = JSON.parse(headJson)
    const rows = allCommitsGet()
    if (!Array.isArray(head) || head.length !== rows.length)
      throw new Error('Original maintenance commits are incomplete')
    const actual = rows.map((row) => ({ id: row.id, fingerprint: row.fingerprint }))
    if (jcs(head) !== jcs(actual)) throw new Error('Original maintenance commit association changed')
    for (const row of rows) readCommit(String(row.id))
    for (const row of allVersionsGet()) {
      if (
        typeof row.commit_id !== 'string' ||
        !readCommit(row.commit_id).records.some(
          (record) =>
            record.recordId === row.record_id &&
            record.revision === row.revision &&
            jcs(record) === row.body_json,
        )
      )
        throw new Error('Original maintenance version has no commit')
    }
  }
  completeHistory()
  function history(transactionId: string) {
    installed()
    completeHistory()
    return readCommit(transactionId)
  }
  return { installed, completeHistory, history, nativeFence, commitGet, allCommitsGet, versionGet }
}

/** Original technical history only. It never constructs C14, resolves, clocks, creates tables or issues evidence. */
export function openNativeMaintenanceHistory(
  input: Readonly<{
    database: DatabaseSync
    identityInstallationId: string
  }>,
) {
  const row = sql(
    input.database,
    'SELECT body_json,maintenance_json FROM runtime_local_identity_installation WHERE id=?',
  ).get(input.identityInstallationId)
  if (!row || typeof row.body_json !== 'string' || typeof row.maintenance_json !== 'string')
    throw new Error('Original maintenance identity anchor is missing')
  const identityConfig = JSON.parse(row.body_json)
  if (canonicalJsonDigest(identityConfig) !== input.identityInstallationId)
    throw new Error('Original identity configuration digest changed')
  const original = JSON.parse(row.maintenance_json)
  if (
    original?.phase !== 'installed' ||
    !original.config ||
    !validateRuntime('StateAuthorityRef', original.config.authority).ok ||
    !validateRuntime('ScopeRef', original.config.scope).ok ||
    !validateRuntime('UInt53', original.config.writerEpoch).ok ||
    original.config.writerEpoch === 0 ||
    jcs(original.config.authority) !== jcs(identityConfig.authority) ||
    jcs(original.config.scope) !== jcs(identityConfig.scope) ||
    jcs(original) !==
      jcs({
        phase: 'installed',
        id: canonicalJsonDigest(original.config),
        config: original.config,
        structures: schema,
      })
  )
    throw new Error('Original maintenance configuration proof changed')
  const config = fixed(
    original.config as { authority: StateAuthorityRef; scope: ScopeRef; writerEpoch: number },
  )
  const reader = retainedReader(input.database, input.identityInstallationId, config)
  return Object.freeze({ readHistorical: reader.history })
}

/** Technical same-connection owner. This does not certify a publication payload or issue admission tickets. */
export function createNativeMaintenanceOwner(
  input: Readonly<{
    database: DatabaseSync
    identity: LocalDeploymentIdentity
    writerEpoch: number
  }>,
) {
  const db = input.database,
    identity = input.identity
  const exec = nativeExec.bind(db)
  const binding = localDeploymentIdentityBinding(identity, db)
  if (!binding || !validateRuntime('UInt53', input.writerEpoch).ok || input.writerEpoch === 0)
    throw new Error('Original native maintenance binding is required')
  originalMethod(identity, 'capture')
  const capture = identity.capture.bind(identity)
  const epoch = input.writerEpoch
  const config = fixed({ authority: binding.authority, scope: binding.scope, writerEpoch: epoch })
  const configJson = jcs(config),
    id = canonicalJsonDigest(config)
  const slotStatement = sql(db, 'SELECT maintenance_json FROM runtime_local_identity_installation WHERE id=?')
  const slotGet = slotStatement.get.bind(slotStatement)
  const priorSlot = slotGet(binding.installationId)
  if (!priorSlot || !Object.hasOwn(priorSlot, 'maintenance_json'))
    throw new Error('Original maintenance installation slot is missing')
  const anchor = jcs({ phase: 'installed', id, config, structures: schema })
  function structures(): void {
    for (let i = 0; i < tables.length; i++) {
      const name = tables[i]
      if (!name) throw new Error('Original maintenance table is missing')
      const row = sql(db, 'SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', name)
      if (row?.sql !== schema[i]) throw new Error('Original maintenance structure is missing or changed')
    }
  }
  if (priorSlot.maintenance_json === null) {
    if (tables.some((name) => sql(db, 'SELECT 1 FROM sqlite_master WHERE name=?').get(name)))
      throw new Error('Partial maintenance history cannot be bootstrapped')
    exec('SAVEPOINT native_maintenance_installation')
    try {
      for (const statement of schema) exec(statement)
      sql(db, 'INSERT INTO runtime_native_maintenance_installation VALUES(?,?,?)').run(id, configJson, '[]')
      const changed = sql(
        db,
        'UPDATE runtime_local_identity_installation SET maintenance_json=? WHERE id=? AND maintenance_json IS NULL',
      ).run(anchor, binding.installationId)
      if (changed.changes !== 1) throw new Error('Original maintenance installation already changed')
      exec('RELEASE native_maintenance_installation')
    } catch (error) {
      exec('ROLLBACK TO native_maintenance_installation')
      exec('RELEASE native_maintenance_installation')
      throw error
    }
  } else if (priorSlot.maintenance_json !== anchor) {
    throw new Error('Original maintenance installation does not match')
  }
  structures()
  const { installed, completeHistory, history, nativeFence, commitGet, allCommitsGet, versionGet } =
    retainedReader(db, binding.installationId, config)
  const receipts = new WeakMap<object, string>()
  const retainReceipt = receipts.set.bind(receipts)
  let closed = false,
    active = false
  function commit(raw: MaintenanceStoreCommitRequest, context: CallContext): MaintenanceStoreCommitResult {
    if (closed || active || types.isProxy(raw)) throw new Error('Native maintenance operation is unavailable')
    const cap = capture(context)
    cap.dynamicCheck()
    const bounded = wire('MaintenanceStoreCommitRequest', raw)
    const request = fixed(structuredClone(bounded))
    if (
      jcs(request.authority) !== jcs(config.authority) ||
      request.expectedWriterEpoch !== epoch ||
      request.outbox.length
    )
      throw new Error('Native maintenance authority, epoch or outbox is unsupported')
    const fingerprint = canonicalJsonDigest(request)
    active = true
    let began = false
    try {
      exec('BEGIN IMMEDIATE')
      began = true
      installed()
      completeHistory()
      const prior = commitGet(request.transactionId)
      let result: MaintenanceStoreCommitResult
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Native maintenance transaction conflict')
        result = history(request.transactionId).result
      } else {
        if (new Set(request.mutations.map((m) => m.recordId)).size !== request.mutations.length)
          throw new Error('Native maintenance mutation is duplicated')
        for (const mutation of request.mutations) {
          const row = versionGet(mutation.recordId)
          const old = row
            ? wire(
                'MaintenanceEnvelopeJsonValue',
                JSON.parse(String(row.body_json)) as MaintenanceEnvelopeJsonValue,
              )
            : null
          const next = mutation.next
          if (
            (old?.revision ?? null) !== mutation.expectedRevision ||
            next.recordId !== mutation.recordId ||
            next.revision !== (old?.revision ?? 0) + 1 ||
            next.writerEpoch !== epoch ||
            (old &&
              (old.writerEpoch !== epoch ||
                next.createdAt !== old.createdAt ||
                Date.parse(next.updatedAt) < Date.parse(old.updatedAt))) ||
            next.fingerprint !== canonicalJsonDigest(next.payload)
          )
            throw new Error('Native maintenance revision conflict')
          sql(db, 'INSERT INTO runtime_native_maintenance_versions VALUES(?,?,?,?)').run(
            mutation.recordId,
            next.revision,
            request.transactionId,
            jcs(next),
          )
        }
        result = fixed(
          wire('MaintenanceStoreCommitResult', {
            transactionId: request.transactionId,
            revisions: request.mutations.map((m) => ({ recordId: m.recordId, revision: m.next.revision })),
          }),
        )
        sql(db, 'INSERT INTO runtime_native_maintenance_commits VALUES(?,?,?,?)').run(
          request.transactionId,
          jcs(request),
          fingerprint,
          jcs(result),
        )
        const head = allCommitsGet().map((row) => ({ id: row.id, fingerprint: row.fingerprint }))
        sql(db, 'UPDATE runtime_native_maintenance_installation SET head_json=? WHERE id=?').run(
          jcs(head),
          id,
        )
      }
      cap.dynamicCheck()
      completeHistory()
      history(request.transactionId)
      const check = nativeFence()
      cap.finalCheck()
      check()
      exec('COMMIT')
      retainReceipt(result, result.transactionId)
      return result
    } catch (error) {
      if (began) exec('ROLLBACK')
      throw error
    } finally {
      active = false
    }
  }
  const api = Object.freeze({
    commit,
    readOriginalReceipt(result: MaintenanceStoreCommitResult) {
      const transactionId = receipts.get(result)
      if (!transactionId) throw new Error('Original native maintenance receipt is required')
      return history(transactionId)
    },
    readHistorical: history,
    close() {
      closed = true
    },
  })
  owners.add(api)
  return api
}
