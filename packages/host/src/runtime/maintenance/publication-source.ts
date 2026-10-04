import { DatabaseSync, type SQLInputValue, StatementSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import {
  type LocalDeploymentIdentity,
  localDeploymentIdentityBinding,
} from '../identity/local-deployment-identity.js'
import { openBootstrapAnchor } from './bootstrap-locator.js'
import {
  isNativeMaintenanceOwner,
  type NativeMaintenanceOwner,
  nativeMaintenanceOwnerUsesDatabase,
  openNativeMaintenanceHistory,
} from './native-store.js'
import { publicationSchemaRefs } from './publication-codecs.js'

const prepare = DatabaseSync.prototype.prepare
const exec = DatabaseSync.prototype.exec
const nativeGet: (...args: SQLInputValue[]) => ReturnType<StatementSync['get']> = StatementSync.prototype.get
const nativeAll: (...args: SQLInputValue[]) => ReturnType<StatementSync['all']> = StatementSync.prototype.all
const nativeRun: (...args: SQLInputValue[]) => ReturnType<StatementSync['run']> = StatementSync.prototype.run
const names = ['runtime_publication_contents', 'runtime_publication_sources'] as const
const structures = [
  "CREATE TABLE runtime_publication_contents (kind TEXT NOT NULL CHECK(kind IN ('json','bytes')),digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),bytes INTEGER NOT NULL CHECK(bytes>=0),body BLOB NOT NULL,PRIMARY KEY(kind,digest))",
  'CREATE TABLE runtime_publication_sources (transaction_id TEXT PRIMARY KEY NOT NULL,source_digest TEXT UNIQUE NOT NULL,source_json TEXT NOT NULL,request_fingerprint TEXT NOT NULL,receipt_json TEXT NOT NULL,issuer_json TEXT NOT NULL,committed_at TEXT NOT NULL)',
] as const
function sql(database: DatabaseSync, text: string) {
  const statement = prepare.call(database, text)
  return { get: nativeGet.bind(statement), all: nativeAll.bind(statement), run: nativeRun.bind(statement) }
}
const owners = new WeakMap<object, Readonly<{ database: DatabaseSync; current(): boolean }>>()
export type NativePublicationSource = ReturnType<typeof createNativePublicationSource>
/** Original installation membership only. No selected assembly role is issued by this component. */
export function nativePublicationSourceUsesDatabase(
  source: unknown,
  database: DatabaseSync,
): source is NativePublicationSource {
  if (typeof source !== 'object' || source === null) return false
  const original = owners.get(source)
  return original !== undefined && original.database === database && original.current()
}

/** Installs technical storage against the original C14 and maintenance connection. */
export function createNativePublicationSource(
  input: Readonly<{
    database: DatabaseSync
    identity: LocalDeploymentIdentity
    maintenance: NativeMaintenanceOwner
  }>,
) {
  const database = input.database
  const maintenance = input.maintenance
  if (!isNativeMaintenanceOwner(maintenance) || !nativeMaintenanceOwnerUsesDatabase(maintenance, database))
    throw new Error('Original same-connection maintenance owner is required')
  const binding = localDeploymentIdentityBinding(input.identity, database)
  if (!binding) throw new Error('Original same-connection local identity is required')
  const identityInstallationId = binding.installationId
  const originalSlot = sql(
    database,
    'SELECT body_json,revoked,maintenance_json,publication_json FROM runtime_local_identity_installation WHERE id=?',
  )
  const slot = originalSlot.get(identityInstallationId)
  if (
    !slot ||
    typeof slot.body_json !== 'string' ||
    slot.revoked !== 0 ||
    typeof slot.maintenance_json !== 'string' ||
    !Object.hasOwn(slot, 'publication_json')
  )
    throw new Error('Original publication installation slot is required')
  const identityBody = slot.body_json
  const maintenanceAnchor = slot.maintenance_json
  const original: unknown = JSON.parse(maintenanceAnchor)
  if (
    original === null ||
    typeof original !== 'object' ||
    !('id' in original) ||
    typeof original.id !== 'string'
  )
    throw new Error('Original maintenance installation is invalid')
  // The existing reader authenticates the entire original maintenance history and metadata.
  openNativeMaintenanceHistory({ database, identityInstallationId: identityInstallationId })
  const config = {
    kind: 'technical-storage',
    identityInstallationId: identityInstallationId,
    maintenanceInstallationId: original.id,
    maintenanceAnchorDigest: canonicalJsonDigest(JSON.parse(maintenanceAnchor)),
    authority: binding.authority,
    scope: binding.scope,
    codecs: publicationSchemaRefs,
  }
  if (
    !validateRuntime('StateAuthorityRef', config.authority).ok ||
    !validateRuntime('ScopeRef', config.scope).ok
  )
    throw new Error('Original publication installation namespace is invalid')
  const installationDigest = canonicalJsonDigest(config)
  const anchor = jcs({ phase: 'installed', formatVersion: 1, installationDigest, config, structures })
  const structure = sql(database, 'SELECT sql FROM sqlite_master WHERE name=? AND type=?')
  if (slot.publication_json === null) {
    for (const name of names) {
      if (structure.get(name, 'table') || sql(database, 'SELECT 1 FROM sqlite_master WHERE name=?').get(name))
        throw new Error('Residual publication storage cannot be installed')
    }
    const commits = sql(
      database,
      "SELECT 1 FROM runtime_native_maintenance_commits WHERE substr(id,1,8)='publish:' LIMIT 1",
    ).get()
    const members = sql(
      database,
      `SELECT 1 FROM runtime_native_maintenance_versions WHERE
      substr(record_id,1,14)='release-route:' OR substr(record_id,1,8)='release:' OR
      json_extract(body_json,'$.schema.typeId') IN (?,?,?,?,?,?) LIMIT 1`,
    ).get(
      publicationSchemaRefs.head.typeId,
      publicationSchemaRefs.route.typeId,
      publicationSchemaRefs.release.typeId,
      'agh.assembly/current-head@1',
      'agh.assembly/release-route@1',
      'agh.assembly/release-snapshot@1',
    )
    if (commits || members) throw new Error('Original publication history has no source installation')
    exec.call(database, 'SAVEPOINT native_publication_installation')
    try {
      for (const ddl of structures) exec.call(database, ddl)
      const changed = sql(
        database,
        'UPDATE runtime_local_identity_installation SET publication_json=? WHERE id=? AND publication_json IS NULL AND maintenance_json=? AND body_json=? AND revoked=0',
      ).run(anchor, identityInstallationId, maintenanceAnchor, slot.body_json)
      if (changed.changes !== 1) throw new Error('Original publication installation changed')
      binding.check()
      exec.call(database, 'RELEASE native_publication_installation')
    } catch (error) {
      exec.call(database, 'ROLLBACK TO native_publication_installation')
      exec.call(database, 'RELEASE native_publication_installation')
      throw error
    }
  } else if (slot.publication_json !== anchor)
    throw new Error('Original publication installation does not match')
  const generation = sql(database, 'SELECT 1 AS native_generation')
  let closed = false
  function installed(): void {
    if (
      !nativeMaintenanceOwnerUsesDatabase(maintenance, database) ||
      !localDeploymentIdentityBinding(input.identity, database)
    )
      throw new Error('Original publication owner is closed or no longer current')
    const actual = originalSlot.get(identityInstallationId)
    if (
      closed ||
      actual?.body_json !== identityBody ||
      actual.maintenance_json !== maintenanceAnchor ||
      actual.publication_json !== anchor ||
      generation.get()?.native_generation !== 1
    )
      throw new Error('Original publication installation is unavailable')
    for (let index = 0; index < names.length; index++) {
      const name = names[index]
      if (!name || structure.get(name, 'table')?.sql !== structures[index])
        throw new Error('Original publication structure changed')
    }
  }
  installed()
  // No publication is issued here. Nonempty history is authenticated by the later atomic source bridge.
  if (
    sql(database, 'SELECT 1 FROM runtime_publication_sources LIMIT 1').get() ||
    sql(database, 'SELECT 1 FROM runtime_publication_contents LIMIT 1').get()
  )
    throw new Error('Complete original publication history reader is required')
  const api = Object.freeze({
    readInstallation() {
      installed()
      openNativeMaintenanceHistory({ database, identityInstallationId: identityInstallationId })
      return Object.freeze({ installationDigest, identityInstallationId: identityInstallationId })
    },
    close() {
      closed = true
    },
  })
  owners.set(
    api,
    Object.freeze({
      database,
      current() {
        try {
          installed()
          return true
        } catch {
          return false
        }
      },
    }),
  )
  return api
}

/** Pure empty installation history. It does not install, issue, authorize or certify a release. */
export function openNativePublicationInstallationHistory(
  input: Readonly<{
    database: DatabaseSync
    identityInstallationId: string
    deploymentDirectory: string
  }>,
) {
  const database = input.database
  const generation = sql(database, 'SELECT 1 AS native_generation')
  const slotRead = sql(
    database,
    'SELECT body_json,maintenance_json,publication_json FROM runtime_local_identity_installation WHERE id=?',
  )
  const slot = slotRead.get(input.identityInstallationId)
  if (
    !slot ||
    typeof slot.body_json !== 'string' ||
    typeof slot.maintenance_json !== 'string' ||
    typeof slot.publication_json !== 'string'
  )
    throw new Error('Original publication installation is missing')
  const originalIdentityBody = slot.body_json
  const originalMaintenanceAnchor = slot.maintenance_json
  const identityConfig = JSON.parse(originalIdentityBody)
  if (
    canonicalJsonDigest(identityConfig) !== input.identityInstallationId ||
    !validateRuntime('StateAuthorityRef', identityConfig.authority).ok ||
    !validateRuntime('ScopeRef', identityConfig.scope).ok
  )
    throw new Error('Original publication identity configuration changed')
  const config = {
    kind: 'technical-storage',
    identityInstallationId: input.identityInstallationId,
    maintenanceInstallationId: JSON.parse(slot.maintenance_json).id,
    maintenanceAnchorDigest: canonicalJsonDigest(JSON.parse(slot.maintenance_json)),
    authority: identityConfig.authority,
    scope: identityConfig.scope,
    codecs: publicationSchemaRefs,
  }
  const installationDigest = canonicalJsonDigest(config)
  const expected = jcs({ phase: 'installed', formatVersion: 1, installationDigest, config, structures })
  if (slot.publication_json !== expected) throw new Error('Original publication anchor changed')
  const identityNames = [
    'runtime_local_identity_installation',
    'runtime_local_identity_connections',
    'runtime_local_identity_claims',
    'runtime_identity_instances',
    'auth_nonces',
  ]
  const structure = sql(database, 'SELECT sql FROM sqlite_master WHERE name=? AND type=?')
  const opened = openBootstrapAnchor(input.deploymentDirectory)
  if (!opened.ok) throw new Error('Original deployment anchor is unavailable')
  const originalAnchor = opened.value
  const journalId = `local-identity:${input.identityInstallationId}`
  function check() {
    if (generation.get()?.native_generation !== 1) throw new Error('Original native generation is closed')
    const current = slotRead.get(input.identityInstallationId)
    if (
      !current ||
      current.body_json !== originalIdentityBody ||
      current.maintenance_json !== originalMaintenanceAnchor ||
      current.publication_json !== expected
    )
      throw new Error('Original publication installation changed')
    const identityStructures = identityNames.map((name) => {
      const row = structure.get(name, 'table')
      if (typeof row?.sql !== 'string') throw new Error('Original identity structure is missing')
      return { name, sql: row.sql }
    })
    const journal = originalAnchor.readJournal(journalId)
    if (
      !journal.ok ||
      jcs(journal.value) !==
        jcs({ phase: 'installed', config: identityConfig, structures: identityStructures })
    )
      throw new Error('Original identity installation journal changed')
    openNativeMaintenanceHistory({ database, identityInstallationId: input.identityInstallationId })
    for (let index = 0; index < names.length; index++) {
      const name = names[index]
      if (!name || structure.get(name, 'table')?.sql !== structures[index])
        throw new Error('Original publication structure changed')
    }
    if (
      sql(database, 'SELECT 1 FROM runtime_publication_sources LIMIT 1').get() ||
      sql(database, 'SELECT 1 FROM runtime_publication_contents LIMIT 1').get() ||
      sql(
        database,
        "SELECT 1 FROM runtime_native_maintenance_commits WHERE substr(id,1,8)='publish:' LIMIT 1",
      ).get()
    )
      throw new Error('Nonempty publication history requires its original source bridge')
  }
  check()
  return Object.freeze({
    readInstallation() {
      check()
      return Object.freeze({ installationDigest, identityInstallationId: input.identityInstallationId })
    },
  })
}
