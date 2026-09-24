import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { TableHandle, TableStore } from '../adapters/storage-sqlite.js'
import type { ComputerUseEffectBinding, ComputerUseEffectStore } from './host-enforcement.js'

const STORE_VERSION = 1
const SHA256 = /^[0-9a-f]{64}$/
const MODES = new Set(['standard', 'bounded', 'unrestricted'])
const AUTHORIZATIONS = new Set([
  'driver-standard',
  'reviewed-manifest',
  'session-yolo',
  'trusted-profile-off',
])
const PHASES = new Set(['dispatching', 'responded', 'not_sent', 'unknown'])
const REQUIRED_BINDING_FIELDS = new Set([
  'effectId',
  'sessionKey',
  'lane',
  'ownerId',
  'profileHash',
  'callId',
  'argsHash',
  'action',
  'deliveryMode',
  'bringToFront',
  'definitionFingerprint',
  'policyHash',
  'generation',
  'mode',
  'authorization',
])
const ALLOWED_BINDING_FIELDS = new Set([...REQUIRED_BINDING_FIELDS, 'capabilityManifestDigest'])

const META_DDL =
  'CREATE TABLE computer_use_effect_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)'
const EFFECTS_DDL =
  'CREATE TABLE computer_use_effects (' +
  'lookup_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, phase TEXT NOT NULL, ' +
  'dispatch_ordinal INTEGER NOT NULL CHECK (dispatch_ordinal IN (1,2)), ' +
  "CHECK (phase IN ('dispatching','responded','not_sent','unknown')))"

type EffectPhase = 'dispatching' | 'responded' | 'not_sent' | 'unknown'
type EffectRow = {
  lookup_hash: unknown
  binding_hash: unknown
  phase: unknown
  dispatch_ordinal: unknown
}
type BindingDigests = Readonly<{ lookup: string; binding: string }>
type SchemaRow = { type: unknown; name: unknown; tbl_name: unknown; sql: unknown }

function boundedIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function checkedBinding(value: unknown): ComputerUseEffectBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
    throw new TypeError('invalid Computer Use effect binding')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('invalid Computer Use effect binding')
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.some((key) => typeof key !== 'string' || !ALLOWED_BINDING_FIELDS.has(key)) ||
    [...REQUIRED_BINDING_FIELDS].some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => {
      const descriptor = typeof key === 'string' ? descriptors[key] : undefined
      return !descriptor?.enumerable || !('value' in descriptor)
    })
  )
    throw new TypeError('invalid Computer Use effect binding')
  const field = (name: string): unknown => descriptors[name]?.value
  const capabilityManifestDigest = field('capabilityManifestDigest')
  if (
    (Object.hasOwn(descriptors, 'capabilityManifestDigest') && capabilityManifestDigest === undefined) ||
    !boundedIdentity(field('effectId'), 256) ||
    !boundedIdentity(field('sessionKey'), 512) ||
    !boundedIdentity(field('lane'), 64) ||
    !boundedIdentity(field('ownerId'), 256) ||
    typeof field('profileHash') !== 'string' ||
    !SHA256.test(field('profileHash') as string) ||
    !boundedIdentity(field('callId'), 256) ||
    typeof field('argsHash') !== 'string' ||
    !SHA256.test(field('argsHash') as string) ||
    !boundedIdentity(field('action'), 64) ||
    (field('deliveryMode') !== 'background' && field('deliveryMode') !== 'foreground') ||
    typeof field('bringToFront') !== 'boolean' ||
    typeof field('definitionFingerprint') !== 'string' ||
    !SHA256.test(field('definitionFingerprint') as string) ||
    typeof field('policyHash') !== 'string' ||
    !SHA256.test(field('policyHash') as string) ||
    !Number.isSafeInteger(field('generation')) ||
    (field('generation') as number) < 1 ||
    typeof field('mode') !== 'string' ||
    !MODES.has(field('mode') as string) ||
    typeof field('authorization') !== 'string' ||
    !AUTHORIZATIONS.has(field('authorization') as string) ||
    (capabilityManifestDigest !== undefined &&
      (typeof capabilityManifestDigest !== 'string' || !SHA256.test(capabilityManifestDigest)))
  )
    throw new TypeError('invalid Computer Use effect binding')
  return Object.freeze({
    effectId: field('effectId'),
    sessionKey: field('sessionKey'),
    lane: field('lane'),
    ownerId: field('ownerId'),
    profileHash: field('profileHash'),
    callId: field('callId'),
    argsHash: field('argsHash'),
    action: field('action'),
    deliveryMode: field('deliveryMode'),
    bringToFront: field('bringToFront'),
    definitionFingerprint: field('definitionFingerprint'),
    policyHash: field('policyHash'),
    generation: field('generation'),
    mode: field('mode'),
    authorization: field('authorization'),
    ...(capabilityManifestDigest === undefined ? {} : { capabilityManifestDigest }),
  }) as ComputerUseEffectBinding
}

function digest(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function bindingDigests(value: unknown): BindingDigests {
  const binding = checkedBinding(value)
  const lookup = digest([binding.sessionKey, binding.lane, binding.ownerId, binding.effectId])
  return Object.freeze({
    lookup,
    binding: digest([
      binding.effectId,
      binding.sessionKey,
      binding.lane,
      binding.ownerId,
      binding.profileHash,
      binding.callId,
      binding.argsHash,
      binding.action,
      binding.deliveryMode,
      binding.bringToFront,
      binding.definitionFingerprint,
      binding.policyHash,
      binding.generation,
      binding.mode,
      binding.authorization,
      binding.capabilityManifestDigest ?? null,
    ]),
  })
}

function normalizedDdl(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .toLowerCase()
}

function requireSchema(table: TableHandle): void {
  const allowed = new Map<string, Readonly<{ type: 'table' | 'index'; table: string; ddl: string | null }>>([
    ['computer_use_effect_meta', { type: 'table', table: 'computer_use_effect_meta', ddl: META_DDL }],
    ['computer_use_effects', { type: 'table', table: 'computer_use_effects', ddl: EFFECTS_DDL }],
    ['sqlite_autoindex_computer_use_effects_1', { type: 'index', table: 'computer_use_effects', ddl: null }],
  ])
  const rows = table.all<SchemaRow>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
  if (rows.length !== allowed.size) throw new Error('E_COMPUTER_USE_EFFECT_SCHEMA: unexpected schema')
  for (const row of rows) {
    if (typeof row.name !== 'string') throw new Error('E_COMPUTER_USE_EFFECT_SCHEMA: malformed schema')
    const expected = allowed.get(row.name)
    if (
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.table ||
      (expected.ddl === null
        ? row.sql !== null
        : typeof row.sql !== 'string' || normalizedDdl(row.sql) !== normalizedDdl(expected.ddl))
    )
      throw new Error('E_COMPUTER_USE_EFFECT_SCHEMA: incompatible schema')
  }
}

function checkedRow(row: EffectRow | undefined):
  | Readonly<{
      lookupHash: string
      bindingHash: string
      phase: EffectPhase
      dispatchOrdinal: 1 | 2
    }>
  | undefined {
  if (!row) return undefined
  if (
    typeof row.lookup_hash !== 'string' ||
    !SHA256.test(row.lookup_hash) ||
    typeof row.binding_hash !== 'string' ||
    !SHA256.test(row.binding_hash) ||
    typeof row.phase !== 'string' ||
    !PHASES.has(row.phase) ||
    (row.dispatch_ordinal !== 1 && row.dispatch_ordinal !== 2)
  )
    throw new Error('E_COMPUTER_USE_EFFECT_STORE: invalid durable row')
  return Object.freeze({
    lookupHash: row.lookup_hash,
    bindingHash: row.binding_hash,
    phase: row.phase as EffectPhase,
    dispatchOrdinal: row.dispatch_ordinal,
  })
}

function initialize(table: TableHandle): void {
  table.transaction(() => {
    const objects = table.all<{ name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
    )
    if (objects.length === 0) {
      table.exec(META_DDL)
      table.exec(EFFECTS_DDL)
      table.run('INSERT INTO computer_use_effect_meta (id, version) VALUES (1, ?)', [STORE_VERSION])
    }
    requireSchema(table)
    const versions = table.all<{ id: unknown; version: unknown }>(
      'SELECT id, version FROM computer_use_effect_meta ORDER BY id',
    )
    if (versions.length !== 1 || versions[0]?.id !== 1 || versions[0].version !== STORE_VERSION)
      throw new Error('E_COMPUTER_USE_EFFECT_SCHEMA: incompatible version')
    for (const row of table.all<EffectRow>(
      'SELECT lookup_hash, binding_hash, phase, dispatch_ordinal FROM computer_use_effects ORDER BY lookup_hash',
    ))
      checkedRow(row)
  })
}

function read(table: TableHandle, lookupHash: string): ReturnType<typeof checkedRow> {
  return checkedRow(
    table.get<EffectRow>(
      'SELECT lookup_hash, binding_hash, phase, dispatch_ordinal FROM computer_use_effects WHERE lookup_hash = ?',
      [lookupHash],
    ),
  )
}

/**
 * Creates a durable mutation state machine on a dedicated Host-owned TableStore. The database only
 * receives SHA-256 identities and a closed phase; caller identifiers and transport errors never do.
 */
export function createSqliteComputerUseEffectStore(tables: TableStore): ComputerUseEffectStore {
  const table = tables.table('computer_use_effects')
  initialize(table)
  return Object.freeze({
    async claim(value) {
      const hashes = bindingDigests(value)
      return table.transaction(() => {
        const existing = read(table, hashes.lookup)
        if (!existing) {
          const changed = table.run(
            'INSERT INTO computer_use_effects (lookup_hash, binding_hash, phase, dispatch_ordinal) VALUES (?, ?, ?, 1)',
            [hashes.lookup, hashes.binding, 'dispatching'],
          ).changes
          if (changed !== 1) throw new Error('E_COMPUTER_USE_EFFECT_STORE: claim insert failed')
          return Object.freeze({ status: 'claimed' as const })
        }
        if (existing.bindingHash !== hashes.binding) return Object.freeze({ status: 'conflict' as const })
        if (existing.phase === 'not_sent') {
          if (existing.dispatchOrdinal === 2) {
            const changed = table.run(
              "UPDATE computer_use_effects SET phase = 'unknown' WHERE lookup_hash = ? AND binding_hash = ? AND phase = 'not_sent' AND dispatch_ordinal = 2",
              [hashes.lookup, hashes.binding],
            ).changes
            if (changed !== 1) throw new Error('E_COMPUTER_USE_EFFECT_STORE: retry exhaustion lost')
            return Object.freeze({ status: 'terminal' as const, phase: 'unknown' as const })
          }
          const changed = table.run(
            "UPDATE computer_use_effects SET phase = 'dispatching', dispatch_ordinal = 2 WHERE lookup_hash = ? AND binding_hash = ? AND phase = 'not_sent' AND dispatch_ordinal = 1",
            [hashes.lookup, hashes.binding],
          ).changes
          if (changed !== 1) throw new Error('E_COMPUTER_USE_EFFECT_STORE: retry claim lost')
          return Object.freeze({ status: 'claimed' as const })
        }
        if (existing.phase === 'dispatching') {
          const changed = table.run(
            "UPDATE computer_use_effects SET phase = 'unknown' WHERE lookup_hash = ? AND binding_hash = ? AND phase = 'dispatching'",
            [hashes.lookup, hashes.binding],
          ).changes
          if (changed !== 1) throw new Error('E_COMPUTER_USE_EFFECT_STORE: recovery claim lost')
          return Object.freeze({ status: 'terminal' as const, phase: 'unknown' as const })
        }
        return Object.freeze({
          status: 'terminal' as const,
          phase: existing.phase as 'responded' | 'unknown',
        })
      })
    },
    async finish(value, phase) {
      const hashes = bindingDigests(value)
      if (phase !== 'responded' && phase !== 'not_sent' && phase !== 'unknown')
        throw new TypeError('invalid Computer Use terminal phase')
      table.transaction(() => {
        const existing = read(table, hashes.lookup)
        if (!existing || existing.bindingHash !== hashes.binding)
          throw new Error('E_COMPUTER_USE_EFFECT_STORE: effect identity mismatch')
        if (existing.phase === phase) return
        if (existing.phase !== 'dispatching')
          throw new Error('E_COMPUTER_USE_EFFECT_STORE: terminal effect cannot transition')
        const changed = table.run(
          'UPDATE computer_use_effects SET phase = ? WHERE lookup_hash = ? AND binding_hash = ? AND phase = ?',
          [phase, hashes.lookup, hashes.binding, 'dispatching'],
        ).changes
        if (changed !== 1) throw new Error('E_COMPUTER_USE_EFFECT_STORE: terminal transition lost')
      })
    },
  })
}
