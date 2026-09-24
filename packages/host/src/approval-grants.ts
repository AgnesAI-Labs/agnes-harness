import type { ApprovalGrantQuery, ApprovalSeam } from '@agnes/core'
import { type ApprovalGrant, isDateTime } from '@agnes/protocol'
import type { TableHandle, TableStore } from './adapters/storage-sqlite.js'

const PROFILE_HASH = /^sha256-[a-f0-9]{64}$/
const STORE_VERSION = 1
const BINDING_KEYS = new Set(['profileHash', 'actorId', 'actorOrg', 'toolId', 'scope', 'policyVersion'])
const GRANT_KEYS = new Set([
  'grantId',
  'profileHash',
  'actorId',
  'actorOrg',
  'toolId',
  'scope',
  'policyVersion',
  'createdAt',
  'revokedAt',
])
const REQUIRED_GRANT_KEYS = [...GRANT_KEYS].filter((key) => key !== 'revokedAt')
const META_DDL =
  'CREATE TABLE approval_grant_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const GRANTS_DDL =
  'CREATE TABLE approval_grants (' +
  'grant_id TEXT PRIMARY KEY, profile_hash TEXT NOT NULL, actor_id TEXT NOT NULL, actor_org TEXT NOT NULL, ' +
  'tool_id TEXT NOT NULL, scope TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)'
const BINDING_INDEX_DDL =
  'CREATE INDEX approval_grants_binding ON approval_grants ' +
  '(profile_hash, actor_id, actor_org, tool_id, scope, policy_version, revoked_at)'

type GrantRow = {
  grant_id: string
  profile_hash: string
  actor_id: string
  actor_org: string
  tool_id: string
  scope: string
  policy_version: string
  created_at: string
  revoked_at: string | null
}

type SchemaRow = {
  type: unknown
  name: unknown
  tbl_name: unknown
  sql: unknown
}

export type ApprovalGrantBinding = ApprovalGrantQuery

/** Safe management surface. Grant activation remains private to the Core seam adapter below. */
export interface ApprovalGrantStore {
  list(binding: ApprovalGrantBinding): ApprovalGrant[]
  /** Authenticated management path: every security binding is required and matched before revoke. */
  revoke(binding: ApprovalGrantBinding, grantId: string, revokedAt: string): ApprovalGrant | null
}

export interface ApprovalGrantManagement extends ApprovalGrantStore {
  /** In-process invalidation fan-out. Durable readers still re-check SQLite on every authorization. */
  onRevoked(listener: (grant: ApprovalGrant) => void): () => void
}

export type ApprovalGrantControlPlane = Readonly<{
  management: ApprovalGrantManagement
  bind(seam: ApprovalSeam): ApprovalSeam
}>

type ApprovalGrantRuntimeStore = ApprovalGrantStore & {
  /** Activates only the grant identity already persisted by Core's approval ledger. */
  put(grant: ApprovalGrant): void
  /** Core-private compatibility path; deliberately absent from ApprovalGrantStore and Host exports. */
  revokeById(grantId: string, revokedAt: string): ApprovalGrant | null
  revokeBound(
    binding: ApprovalGrantBinding,
    grantId: string,
    revokedAt: string,
  ): { grant: ApprovalGrant | null; changed: boolean }
  revokeByIdWithState(grantId: string, revokedAt: string): { grant: ApprovalGrant | null; changed: boolean }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000'))
    throw new TypeError(`invalid approval grant ${field}`)
  return value
}

function instant(value: unknown, field: string): string {
  const result = text(value, field, 64)
  // This is the generated Protocol date-time rule, including real month/leap-day bounds. Date.parse
  // alone normalizes impossible dates such as 2026-02-30 and would silently accept a different day.
  if (!isDateTime(result)) throw new TypeError(`invalid approval grant ${field}`)
  return result
}

function binding(input: unknown): ApprovalGrantBinding {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('invalid approval grant binding object')
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.some((key) => typeof key !== 'string' || !BINDING_KEYS.has(key)) ||
    [...BINDING_KEYS].some((key) => !Object.hasOwn(input, key))
  )
    throw new TypeError('invalid approval grant binding fields')
  const value = input as Record<string, unknown>
  const profileHash = text(value.profileHash, 'profileHash', 71)
  if (!PROFILE_HASH.test(profileHash)) throw new TypeError('invalid approval grant profileHash')
  return {
    profileHash,
    actorId: text(value.actorId, 'actorId', 256),
    actorOrg: text(value.actorOrg, 'actorOrg', 256),
    toolId: text(value.toolId, 'toolId', 128),
    scope: text(value.scope, 'scope', 256),
    policyVersion: text(value.policyVersion, 'policyVersion', 64),
  }
}

function checked(input: unknown): ApprovalGrant {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('invalid approval grant object')
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.some((key) => typeof key !== 'string' || !GRANT_KEYS.has(key)) ||
    REQUIRED_GRANT_KEYS.some((key) => !Object.hasOwn(input, key))
  )
    throw new TypeError('invalid approval grant fields')
  const grant = input as Record<string, unknown>
  const grantId = text(grant.grantId, 'grantId', 128)
  const bound = binding({
    profileHash: grant.profileHash,
    actorId: grant.actorId,
    actorOrg: grant.actorOrg,
    toolId: grant.toolId,
    scope: grant.scope,
    policyVersion: grant.policyVersion,
  })
  const hasRevokedAt = Object.hasOwn(grant, 'revokedAt')
  return {
    grantId,
    ...bound,
    createdAt: instant(grant.createdAt, 'createdAt'),
    ...(hasRevokedAt ? { revokedAt: instant(grant.revokedAt, 'revokedAt') } : {}),
  }
}

function fromRow(row: GrantRow): ApprovalGrant {
  return checked({
    grantId: row.grant_id,
    profileHash: row.profile_hash,
    actorId: row.actor_id,
    actorOrg: row.actor_org,
    toolId: row.tool_id,
    scope: row.scope,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  })
}

const selectById = (table: TableHandle, grantId: string): GrantRow | undefined =>
  table.get<GrantRow>(
    'SELECT grant_id, profile_hash, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at FROM approval_grants WHERE grant_id = ?',
    [grantId],
  )

const sameGrant = (left: ApprovalGrant, right: ApprovalGrant): boolean =>
  left.grantId === right.grantId &&
  left.profileHash === right.profileHash &&
  left.actorId === right.actorId &&
  left.actorOrg === right.actorOrg &&
  left.toolId === right.toolId &&
  left.scope === right.scope &&
  left.policyVersion === right.policyVersion &&
  left.createdAt === right.createdAt &&
  left.revokedAt === right.revokedAt

const matches = (grant: ApprovalGrant, query: ApprovalGrantBinding): boolean =>
  grant.profileHash === query.profileHash &&
  grant.actorId === query.actorId &&
  grant.actorOrg === query.actorOrg &&
  grant.toolId === query.toolId &&
  grant.scope === query.scope &&
  grant.policyVersion === query.policyVersion

function tableExists(table: TableHandle, name: string): boolean {
  return (
    table.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
      name,
    ]) !== undefined
  )
}

function normalizedDdl(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .toLowerCase()
}

function schemaSql(table: TableHandle, type: 'table' | 'index', name: string): string | undefined {
  // TableHandle deliberately refuses PRAGMA and pragma_* so package code cannot recover its backing
  // path or mutate SQLite internals. The Host-owned grant schema therefore compares sqlite_master's
  // normalized canonical DDL instead; semantically equivalent but unreviewed DDL fails closed.
  const row = table.get<{ sql: unknown }>('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', [
    type,
    name,
  ])
  return typeof row?.sql === 'string' ? row.sql : undefined
}

function requireSchemaInventory(
  table: TableHandle,
  expected: Readonly<{ meta: boolean; grants: boolean; bindingIndex: boolean }>,
): void {
  const allowed = new Map<string, { type: 'table' | 'index'; table: string; ddl: string | null }>()
  if (expected.meta)
    allowed.set('approval_grant_meta', {
      type: 'table',
      table: 'approval_grant_meta',
      ddl: META_DDL,
    })
  if (expected.grants) {
    allowed.set('approval_grants', { type: 'table', table: 'approval_grants', ddl: GRANTS_DDL })
    // SQLite owns this null-SQL index for the TEXT PRIMARY KEY. It is the only implicit schema
    // object admitted; triggers, views, shadow tables and extra indexes all fail closed.
    allowed.set('sqlite_autoindex_approval_grants_1', {
      type: 'index',
      table: 'approval_grants',
      ddl: null,
    })
  }
  if (expected.bindingIndex)
    allowed.set('approval_grants_binding', {
      type: 'index',
      table: 'approval_grants',
      ddl: BINDING_INDEX_DDL,
    })

  const rows = table.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
  if (rows.length !== allowed.size)
    throw new Error(
      `E_APPROVAL_GRANT_MIGRATION_REQUIRED: unexpected approval grant schema objects: ${rows
        .map((row) => String(row.name))
        .join(',')}`,
    )
  for (const row of rows) {
    if (typeof row.name !== 'string')
      throw new Error('E_APPROVAL_GRANT_MIGRATION_REQUIRED: malformed approval grant schema object')
    const wanted = allowed.get(row.name)
    if (
      !wanted ||
      row.type !== wanted.type ||
      row.tbl_name !== wanted.table ||
      (wanted.ddl === null
        ? row.sql !== null
        : typeof row.sql !== 'string' || normalizedDdl(row.sql) !== normalizedDdl(wanted.ddl))
    )
      throw new Error(`E_APPROVAL_GRANT_MIGRATION_REQUIRED: incompatible schema object ${row.name}`)
  }
}

function validateRows(table: TableHandle): void {
  let rows: GrantRow[]
  try {
    rows = table.all<GrantRow>(
      'SELECT grant_id, profile_hash, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at FROM approval_grants ORDER BY grant_id',
    )
  } catch (cause) {
    throw new Error('E_APPROVAL_GRANT_MIGRATION_REQUIRED: unreadable approval grant rows', { cause })
  }
  const ids = new Set<string>()
  try {
    for (const row of rows) {
      const grant = fromRow(row)
      if (ids.has(grant.grantId)) throw new Error(`duplicate approval grant id ${grant.grantId}`)
      ids.add(grant.grantId)
    }
  } catch (cause) {
    throw new Error('E_APPROVAL_GRANT_MIGRATION_REQUIRED: invalid approval grant rows', { cause })
  }
}

function initialize(table: TableHandle): void {
  table.transaction(() => {
    const hadMeta = tableExists(table, 'approval_grant_meta')
    const hadGrants = tableExists(table, 'approval_grants')
    const hadIndex = schemaSql(table, 'index', 'approval_grants_binding') !== undefined
    if (hadMeta) {
      requireSchemaInventory(table, { meta: true, grants: true, bindingIndex: true })
      const versions = table.all<{ id: unknown; version: unknown }>(
        'SELECT id, version FROM approval_grant_meta ORDER BY id',
      )
      const version = versions[0]
      if (!version || versions.length !== 1 || version.id !== 1)
        throw new Error('E_APPROVAL_GRANT_MIGRATION_REQUIRED: grant metadata has no sole version row')
      if (version.version !== STORE_VERSION)
        throw new Error(
          `E_APPROVAL_GRANT_SCHEMA_VERSION: store ${String(version.version)} is incompatible with runtime ${STORE_VERSION}`,
        )
      if (!hadGrants)
        throw new Error('E_APPROVAL_GRANT_MIGRATION_REQUIRED: versioned store has no grant table')
      validateRows(table)
    } else {
      if (hadGrants) {
        requireSchemaInventory(table, { meta: false, grants: true, bindingIndex: hadIndex })
        validateRows(table)
      } else {
        requireSchemaInventory(table, { meta: false, grants: false, bindingIndex: false })
        table.exec(GRANTS_DDL)
      }
      table.exec(META_DDL)
      table.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, ?)', [STORE_VERSION])
      table.exec(`CREATE INDEX IF NOT EXISTS ${BINDING_INDEX_DDL.slice('CREATE INDEX '.length)}`)
      requireSchemaInventory(table, { meta: true, grants: true, bindingIndex: true })
    }
  })
}

function createApprovalGrantRuntimeStore(tables: TableStore): ApprovalGrantRuntimeStore {
  let opened: TableHandle | undefined
  const table = (): TableHandle => {
    if (!opened) {
      opened = tables.table('approval_grants')
      initialize(opened)
    }
    return opened
  }

  const revokeRow = (row: GrantRow, at: string): { grant: ApprovalGrant; changed: boolean } => {
    const current = fromRow(row)
    if (current.revokedAt !== undefined) return { grant: current, changed: false }
    const changed = table().run(
      'UPDATE approval_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
      [at, current.grantId],
    ).changes
    if (changed !== 1) throw new Error('approval grant revoke lost its row')
    return { grant: { ...current, revokedAt: at }, changed: true }
  }

  const revokeBound = (
    input: ApprovalGrantBinding,
    grantId: string,
    revokedAt: string,
  ): { grant: ApprovalGrant | null; changed: boolean } => {
    const query = binding(input)
    const id = text(grantId, 'grantId', 128)
    const at = instant(revokedAt, 'revokedAt')
    return table().transaction(() => {
      const row = selectById(table(), id)
      if (!row || !matches(fromRow(row), query)) return { grant: null, changed: false }
      return revokeRow(row, at)
    })
  }

  const revokeByIdWithState = (
    grantId: string,
    revokedAt: string,
  ): { grant: ApprovalGrant | null; changed: boolean } => {
    const id = text(grantId, 'grantId', 128)
    const at = instant(revokedAt, 'revokedAt')
    return table().transaction(() => {
      const row = selectById(table(), id)
      return row ? revokeRow(row, at) : { grant: null, changed: false }
    })
  }

  return {
    list(input) {
      const query = binding(input)
      return table()
        .all<GrantRow>(
          'SELECT grant_id, profile_hash, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at FROM approval_grants WHERE profile_hash = ? AND actor_id = ? AND actor_org = ? AND tool_id = ? AND scope = ? AND policy_version = ? AND revoked_at IS NULL ORDER BY created_at, grant_id',
          [query.profileHash, query.actorId, query.actorOrg, query.toolId, query.scope, query.policyVersion],
        )
        .map(fromRow)
    },
    put(input) {
      const grant = checked(input)
      if (grant.revokedAt !== undefined)
        throw new TypeError('cannot insert an already revoked approval grant')
      table().transaction(() => {
        const prior = selectById(table(), grant.grantId)
        if (prior) {
          if (!sameGrant(fromRow(prior), grant)) throw new Error('approval grant id collision')
          return
        }
        table().run(
          'INSERT INTO approval_grants (grant_id, profile_hash, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          [
            grant.grantId,
            grant.profileHash,
            grant.actorId,
            grant.actorOrg,
            grant.toolId,
            grant.scope,
            grant.policyVersion,
            grant.createdAt,
          ],
        )
      })
    },
    revoke(input, grantId, revokedAt) {
      return revokeBound(input, grantId, revokedAt).grant
    },
    revokeBound,
    revokeByIdWithState,
    revokeById(grantId, revokedAt) {
      return revokeByIdWithState(grantId, revokedAt).grant
    },
  }
}

/** Opens only the fully-bound management surface; activation and id-only revoke stay in Host/Core. */
export function createApprovalGrantStore(tables: TableStore): ApprovalGrantStore {
  const backend = createApprovalGrantRuntimeStore(tables)
  return Object.freeze({ list: backend.list, revoke: backend.revoke })
}

export function createApprovalGrantControlPlane(
  tables: TableStore,
  bindTicket?: (grantId: string) => void,
): ApprovalGrantControlPlane {
  const store = createApprovalGrantRuntimeStore(tables)
  const listeners = new Set<(grant: ApprovalGrant) => void>()
  const emit = (grant: ApprovalGrant): void => {
    // Revocation is already durable. A broken observer cannot roll it back or prevent the remaining
    // active-session/cache listeners from seeing the invalidation. Snapshotting also makes one
    // durable transition exactly-once for the listeners present at emit start: a callback may
    // unsubscribe/re-subscribe without being visited again by the live Set iterator.
    for (const listener of [...listeners])
      try {
        listener(structuredClone(grant))
      } catch {}
  }
  const management: ApprovalGrantManagement = Object.freeze({
    list: store.list,
    revoke(input: ApprovalGrantBinding, grantId: string, revokedAt: string) {
      const result = store.revokeBound(input, grantId, revokedAt)
      if (result.changed && result.grant) emit(result.grant)
      return result.grant
    },
    onRevoked(listener: (grant: ApprovalGrant) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const bind = (seam: ApprovalSeam): ApprovalSeam => {
    const bound: ApprovalSeam = {
      ...(seam.forWorkspace
        ? {
            forWorkspace: async (workspace) => {
              const fitted = await seam.forWorkspace?.(workspace)
              if (!fitted) throw new Error('approval workspace fitting is unavailable')
              return bind(fitted)
            },
          }
        : {}),
      ask: (request) => seam.ask(request),
      resume: (ticket, verdict) => seam.resume(ticket, verdict),
      guard: (request) =>
        seam.guard
          ? seam.guard(request)
          : Promise.resolve({
              decision: 'escalate' as const,
              ruleVersion: 'missing',
              reasons: ['guardian unavailable'],
            }),
      // Permanent grants are not cached today: every authorization reads SQLite. This listener
      // remains the explicit active-session/cache invalidation port so a future cache cannot make
      // revocation eventually consistent by accident.
      listGrants: async (query) => store.list(query),
      putGrant: async (grant) => {
        bindTicket?.(grant.grantId)
        store.put(grant)
      },
      revokeGrant: async (grantId, revokedAt) => {
        const result = store.revokeByIdWithState(grantId, revokedAt)
        if (result.changed && result.grant) emit(result.grant)
        return result.grant
      },
      onGrantRevoked(listener) {
        const offHost = management.onRevoked((grant) => listener(grant.grantId))
        const offPackage = seam.onGrantRevoked?.(listener)
        return () => {
          offHost()
          offPackage?.()
        }
      },
    }
    return bound
  }
  return Object.freeze({ management, bind })
}

/** Compatibility helper for callers that need only the fitted Core seam. */
export function bindApprovalGrantStore(seam: ApprovalSeam, tables: TableStore): ApprovalSeam {
  return createApprovalGrantControlPlane(tables).bind(seam)
}
