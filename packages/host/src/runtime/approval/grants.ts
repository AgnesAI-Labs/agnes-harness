import { type ApprovalGrantQuery, type ApprovalGrantsPort, canonicalJson } from '@agnes/core'
import type {
  PersistenceMetadataNamespace,
  PersistenceSqliteTableHandle as TableHandle,
  PersistenceSqliteTableStore as TableStore,
} from '@agnes/extension-api'
import { type ApprovalGrant, isDateTime, validateActor } from '@agnes/protocol'

const POLICY_DIGEST = /^sha256-[a-f0-9]{64}$/
const STORE_VERSION = 3
const BINDING_KEYS = new Set(['policyDigest', 'actorId', 'actorOrg', 'toolId', 'scope', 'policyVersion'])
const GRANT_KEYS = new Set([
  'grantId',
  'policyDigest',
  'actorId',
  'actorOrg',
  'toolId',
  'scope',
  'policyVersion',
  'createdAt',
  'sourceDecisionId',
  'issuer',
  'definitionFingerprint',
  'policyBinding',
  'revokedAt',
])
const REQUIRED_GRANT_KEYS = [...GRANT_KEYS].filter((key) => key !== 'revokedAt')
const META_DDL =
  'CREATE TABLE approval_grant_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const GRANTS_DDL =
  'CREATE TABLE approval_grants (' +
  'grant_id TEXT PRIMARY KEY, policy_digest TEXT NOT NULL, actor_id TEXT NOT NULL, actor_org TEXT NOT NULL, ' +
  'tool_id TEXT NOT NULL, scope TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, source_decision_id TEXT NOT NULL, issuer TEXT NOT NULL, definition_fingerprint TEXT NOT NULL, policy_binding TEXT NOT NULL)'
const BINDING_INDEX_DDL =
  'CREATE INDEX approval_grants_binding ON approval_grants ' +
  '(policy_digest, actor_id, actor_org, tool_id, scope, policy_version, revoked_at)'

type GrantRow = {
  grant_id: string
  policy_digest: string
  actor_id: string
  actor_org: string
  tool_id: string
  scope: string
  policy_version: string
  created_at: string
  revoked_at: string | null
  source_decision_id: string
  issuer: string
  definition_fingerprint: string
  policy_binding: string
}

export type ApprovalGrantBinding = ApprovalGrantQuery

/** Safe management surface. Grant activation remains private to the Core seam adapter below. */
/** Whose grants, under which policy: everything a grant is bound to except the tool it names. */
export type ApprovalGrantHolder = Pick<ApprovalGrantBinding, 'policyDigest' | 'actorId' | 'actorOrg'>

export interface ApprovalGrantStore {
  list(binding: ApprovalGrantBinding): ApprovalGrant[]
  /** Every active grant one actor holds under one policy, so a client need not probe tool by tool. */
  listHolder(holder: ApprovalGrantHolder): ApprovalGrant[]
  /** Authenticated management path: every security binding is required and matched before revoke. */
  revoke(binding: ApprovalGrantBinding, grantId: string, revokedAt: string): ApprovalGrant | null
}

export interface ApprovalGrantManagement extends ApprovalGrantStore {
  /** In-process invalidation fan-out. Durable readers still re-check durable storage on every authorization. */
  onRevoked(listener: (grant: ApprovalGrant) => void): () => void
}

export type ApprovalGrantControlPlane = Readonly<{
  management: ApprovalGrantManagement
  /** What Core reads and writes permanent grants through. */
  port: ApprovalGrantsPort
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
  const policyDigest = text(value.policyDigest, 'policyDigest', 71)
  if (!POLICY_DIGEST.test(policyDigest)) throw new TypeError('invalid approval grant policyDigest')
  return {
    policyDigest,
    actorId: text(value.actorId, 'actorId', 256),
    actorOrg: text(value.actorOrg, 'actorOrg', 256),
    toolId: text(value.toolId, 'toolId', 128),
    scope: text(value.scope, 'scope', 256),
    policyVersion: text(value.policyVersion, 'policyVersion', 64),
  }
}

function holder(input: ApprovalGrantHolder): ApprovalGrantHolder {
  const policyDigest = text(input.policyDigest, 'policyDigest', 71)
  if (!POLICY_DIGEST.test(policyDigest)) throw new TypeError('invalid approval grant policyDigest')
  return {
    policyDigest,
    actorId: text(input.actorId, 'actorId', 256),
    actorOrg: text(input.actorOrg, 'actorOrg', 256),
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
    policyDigest: grant.policyDigest,
    actorId: grant.actorId,
    actorOrg: grant.actorOrg,
    toolId: grant.toolId,
    scope: grant.scope,
    policyVersion: grant.policyVersion,
  })
  if (!validateActor(grant.issuer).ok || (grant.issuer as ApprovalGrant['issuer']).role === 'agent')
    throw new TypeError('invalid approval grant issuer')
  for (const field of ['definitionFingerprint', 'policyBinding'] as const)
    if (typeof grant[field] !== 'string' || !/^[0-9a-f]{64}$/.test(grant[field]))
      throw new TypeError(`invalid approval grant ${field}`)
  const hasRevokedAt = Object.hasOwn(grant, 'revokedAt')
  return {
    grantId,
    ...bound,
    createdAt: instant(grant.createdAt, 'createdAt'),
    sourceDecisionId: text(grant.sourceDecisionId, 'sourceDecisionId', 256),
    issuer: structuredClone(grant.issuer) as ApprovalGrant['issuer'],
    definitionFingerprint: grant.definitionFingerprint as string,
    policyBinding: grant.policyBinding as string,
    ...(hasRevokedAt ? { revokedAt: instant(grant.revokedAt, 'revokedAt') } : {}),
  }
}

function fromRow(row: GrantRow): ApprovalGrant {
  return checked({
    grantId: row.grant_id,
    policyDigest: row.policy_digest,
    actorId: row.actor_id,
    actorOrg: row.actor_org,
    toolId: row.tool_id,
    scope: row.scope,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    sourceDecisionId: row.source_decision_id,
    issuer: JSON.parse(row.issuer),
    definitionFingerprint: row.definition_fingerprint,
    policyBinding: row.policy_binding,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  })
}

const selectById = (table: TableHandle, grantId: string): GrantRow | undefined =>
  table.get<GrantRow>(
    'SELECT grant_id, policy_digest, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at, source_decision_id, issuer, definition_fingerprint, policy_binding FROM approval_grants WHERE grant_id = ?',
    [grantId],
  )

const sameGrant = (left: ApprovalGrant, right: ApprovalGrant): boolean =>
  left.grantId === right.grantId &&
  left.policyDigest === right.policyDigest &&
  left.actorId === right.actorId &&
  left.actorOrg === right.actorOrg &&
  left.toolId === right.toolId &&
  left.scope === right.scope &&
  left.policyVersion === right.policyVersion &&
  left.createdAt === right.createdAt &&
  left.sourceDecisionId === right.sourceDecisionId &&
  canonicalJson(left.issuer) === canonicalJson(right.issuer) &&
  left.definitionFingerprint === right.definitionFingerprint &&
  left.policyBinding === right.policyBinding &&
  left.revokedAt === right.revokedAt

const matches = (grant: ApprovalGrant, query: ApprovalGrantBinding): boolean =>
  grant.policyDigest === query.policyDigest &&
  grant.actorId === query.actorId &&
  grant.actorOrg === query.actorOrg &&
  grant.toolId === query.toolId &&
  grant.scope === query.scope &&
  grant.policyVersion === query.policyVersion

function tableExists(table: TableHandle, name: string): boolean {
  return table.schema().some((row) => row.type === 'table' && row.name === name)
}

function normalizedDdl(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .toLowerCase()
}

function schemaSql(table: TableHandle, type: 'table' | 'index', name: string): string | undefined {
  const row = table.schema().find((row) => row.type === type && row.name === name)
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

  const rows = table.schema()
  if (rows.length !== allowed.size)
    throw new Error(
      `reset-required: unexpected approval grant schema objects: ${rows
        .map((row) => String(row.name))
        .join(',')}`,
    )
  for (const row of rows) {
    if (typeof row.name !== 'string')
      throw new Error('reset-required: malformed approval grant schema object')
    const wanted = allowed.get(row.name)
    if (
      !wanted ||
      row.type !== wanted.type ||
      row.table !== wanted.table ||
      (wanted.ddl === null
        ? row.sql !== null
        : typeof row.sql !== 'string' || normalizedDdl(row.sql) !== normalizedDdl(wanted.ddl))
    )
      throw new Error(`reset-required: incompatible schema object ${row.name}`)
  }
}

function validateRows(table: TableHandle): void {
  let rows: GrantRow[]
  try {
    rows = table.all<GrantRow>(
      'SELECT grant_id, policy_digest, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at, source_decision_id, issuer, definition_fingerprint, policy_binding FROM approval_grants ORDER BY grant_id',
    )
  } catch (cause) {
    throw new Error('reset-required: unreadable approval grant rows', { cause })
  }
  const ids = new Set<string>()
  try {
    for (const row of rows) {
      const grant = fromRow(row)
      if (ids.has(grant.grantId)) throw new Error(`duplicate approval grant id ${grant.grantId}`)
      ids.add(grant.grantId)
    }
  } catch (cause) {
    throw new Error('reset-required: invalid approval grant rows', { cause })
  }
}

function initialize(table: TableHandle): void {
  table.transaction(() => {
    const hadMeta = tableExists(table, 'approval_grant_meta')
    const hadGrants = tableExists(table, 'approval_grants')
    if (hadMeta) {
      requireSchemaInventory(table, { meta: true, grants: true, bindingIndex: true })
      const versions = table.all<{ id: unknown; version: unknown }>(
        'SELECT id, version FROM approval_grant_meta ORDER BY id',
      )
      const version = versions[0]
      if (!version || versions.length !== 1 || version.id !== 1)
        throw new Error('reset-required: grant metadata has no sole version row')
      if (version.version !== STORE_VERSION)
        throw new Error(
          `reset-required: E_APPROVAL_GRANT_SCHEMA_VERSION: store ${String(version.version)} is incompatible with runtime ${STORE_VERSION}`,
        )
      if (!hadGrants) throw new Error('reset-required: versioned store has no grant table')
      validateRows(table)
    } else {
      if (hadGrants) throw new Error('reset-required: unversioned approval grant store')
      requireSchemaInventory(table, { meta: false, grants: false, bindingIndex: false })
      table.exec(GRANTS_DDL)
      table.exec(META_DDL)
      table.run('INSERT INTO approval_grant_meta (id, version) VALUES (1, ?)', [STORE_VERSION])
      table.exec(`CREATE INDEX IF NOT EXISTS ${BINDING_INDEX_DDL.slice('CREATE INDEX '.length)}`)
      requireSchemaInventory(table, { meta: true, grants: true, bindingIndex: true })
    }
  })
}

function createSqlApprovalGrantRuntimeStore(tables: TableStore): ApprovalGrantRuntimeStore {
  let opened: TableHandle | undefined
  const table = (): TableHandle => {
    if (!opened) {
      const candidate = tables.table('approval_grants')
      initialize(candidate)
      opened = candidate
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
          'SELECT grant_id, policy_digest, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at, source_decision_id, issuer, definition_fingerprint, policy_binding FROM approval_grants WHERE policy_digest = ? AND actor_id = ? AND actor_org = ? AND tool_id = ? AND scope = ? AND policy_version = ? AND revoked_at IS NULL ORDER BY created_at, grant_id',
          [query.policyDigest, query.actorId, query.actorOrg, query.toolId, query.scope, query.policyVersion],
        )
        .map(fromRow)
    },
    listHolder(input) {
      const query = holder(input)
      return table()
        .all<GrantRow>(
          'SELECT grant_id, policy_digest, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at, source_decision_id, issuer, definition_fingerprint, policy_binding FROM approval_grants WHERE policy_digest = ? AND actor_id = ? AND actor_org = ? AND revoked_at IS NULL ORDER BY created_at, grant_id',
          [query.policyDigest, query.actorId, query.actorOrg],
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
          'INSERT INTO approval_grants (grant_id, policy_digest, actor_id, actor_org, tool_id, scope, policy_version, created_at, revoked_at, source_decision_id, issuer, definition_fingerprint, policy_binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
          [
            grant.grantId,
            grant.policyDigest,
            grant.actorId,
            grant.actorOrg,
            grant.toolId,
            grant.scope,
            grant.policyVersion,
            grant.createdAt,
            grant.sourceDecisionId,
            canonicalJson(grant.issuer),
            grant.definitionFingerprint,
            grant.policyBinding,
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

type GrantStorage = TableStore | PersistenceMetadataNamespace

function createApprovalGrantRuntimeStore(storage: GrantStorage): ApprovalGrantRuntimeStore {
  if ('table' in storage) return createSqlApprovalGrantRuntimeStore(storage)
  const ns = storage
  const initialize = (): void => {
    const version = ns.get('version')
    if (version !== undefined && version !== STORE_VERSION)
      throw new Error('reset-required: E_APPROVAL_GRANT_SCHEMA_VERSION: incompatible metadata version')
    if (version === undefined && ns.entries().length)
      throw new Error('reset-required: unversioned approval grant metadata')
    for (const { key, value } of ns.entries()) {
      if (key === 'version') continue
      const grant = checked(value)
      if (key !== `grant:${grant.grantId}`) throw new Error('reset-required: invalid metadata grant identity')
    }
    if (version === undefined) ns.set('version', STORE_VERSION)
  }
  const transaction = <T>(fn: () => T): T =>
    ns.transaction(() => {
      initialize()
      return fn()
    })
  const read = (id: string): ApprovalGrant | undefined => {
    const value = ns.get(`grant:${id}`)
    return value === undefined ? undefined : checked(value)
  }
  const revoke = (id: string, at: string, query?: ApprovalGrantBinding) =>
    transaction(() => {
      const grant = read(id)
      if (!grant || (query && !matches(grant, query))) return { grant: null, changed: false }
      if (grant.revokedAt !== undefined) return { grant, changed: false }
      const revoked = { ...grant, revokedAt: at }
      ns.set(`grant:${id}`, revoked)
      return { grant: revoked, changed: true }
    })
  return {
    list(input) {
      const query = binding(input)
      return transaction(() =>
        ns
          .entries()
          .filter(({ key }) => key.startsWith('grant:'))
          .map(({ value }) => checked(value))
          .filter((grant) => grant.revokedAt === undefined && matches(grant, query))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.grantId.localeCompare(b.grantId)),
      )
    },
    listHolder(input) {
      const query = holder(input)
      return transaction(() =>
        ns
          .entries()
          .filter(({ key }) => key.startsWith('grant:'))
          .map(({ value }) => checked(value))
          .filter(
            (grant) =>
              grant.revokedAt === undefined &&
              grant.policyDigest === query.policyDigest &&
              grant.actorId === query.actorId &&
              grant.actorOrg === query.actorOrg,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.grantId.localeCompare(b.grantId)),
      )
    },
    put(input) {
      const grant = checked(input)
      if (grant.revokedAt !== undefined)
        throw new TypeError('cannot insert an already revoked approval grant')
      transaction(() => {
        const prior = read(grant.grantId)
        if (prior && !sameGrant(prior, grant)) throw new Error('approval grant id collision')
        if (!prior) ns.set(`grant:${grant.grantId}`, grant)
      })
    },
    revokeBound(input, grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'), binding(input))
    },
    revoke(input, grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'), binding(input)).grant
    },
    revokeByIdWithState(grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt'))
    },
    revokeById(grantId, revokedAt) {
      return revoke(text(grantId, 'grantId', 128), instant(revokedAt, 'revokedAt')).grant
    },
  }
}

/** Copy only after the legacy schema and every grant row pass the existing fail-closed gate. */
export function migrateApprovalGrants(tables: TableStore, ns: PersistenceMetadataNamespace): void {
  if (ns.get('version') !== undefined) return
  const table = tables.table('approval_grants')
  initialize(table)
  ns.transaction(() => {
    if (ns.get('version') !== undefined) return
    for (const row of table.all<GrantRow>('SELECT * FROM approval_grants')) {
      const grant = fromRow(row)
      ns.set(`grant:${grant.grantId}`, grant)
    }
    ns.set('version', STORE_VERSION)
  })
}

/** Opens only the fully-bound management surface; activation and id-only revoke stay in Host/Core. */
export function createApprovalGrantStore(tables: GrantStorage): ApprovalGrantStore {
  const backend = createApprovalGrantRuntimeStore(tables)
  return Object.freeze({ list: backend.list, listHolder: backend.listHolder, revoke: backend.revoke })
}

export function createApprovalGrantControlPlane(
  tables: GrantStorage,
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
    listHolder: store.listHolder,
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
  // Permanent grants are not cached today: every authorization reads durable storage. Revocation
  // emits through `management.onRevoked`, the explicit invalidation port for any future cache.
  const port: ApprovalGrantsPort = Object.freeze({
    list: async (query: ApprovalGrantQuery) => store.list(query),
    put: async (grant: ApprovalGrant) => {
      bindTicket?.(grant.grantId)
      store.put(grant)
    },
  })
  return Object.freeze({ management, port })
}
