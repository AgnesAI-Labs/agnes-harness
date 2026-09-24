import { createHash } from 'node:crypto'
import type { PluginRow } from './plugin-row.js'
import { isResourceOwnedRowId } from './resource-owned.js'

export const ROW_STATES = Object.freeze([
  'pending',
  'loading',
  'active',
  'failed',
  'disabled',
  'waiting-drain',
] as const)

export type RowState = (typeof ROW_STATES)[number]

export type RuntimeConvergenceRow = Readonly<{
  id: string
  state: RowState
  reason?: string
}>

/** The complete ordinary-tree result reported for one attempted tree hash. */
export type RuntimeConvergenceReport = Readonly<{
  hash: string
  ok: boolean
  rows: readonly RuntimeConvergenceRow[]
}>

/** Task 7's ordinary plugin tree. Resource generations are introduced separately in Task 8. */
export type TreeSnapshot = Readonly<{
  hash: string
  rows: readonly Readonly<PluginRow>[]
}>

function invalidTree(reason: string): never {
  throw new Error(`E_TREE_SNAPSHOT: ${reason}`)
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) invalidTree(`${field} must be a non-empty string`)
  return value
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]()
  const rightPoints = right[Symbol.iterator]()
  while (true) {
    const leftPoint = leftPoints.next()
    const rightPoint = rightPoints.next()
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0
      return leftPoint.done ? -1 : 1
    }
    const difference = (leftPoint.value.codePointAt(0) ?? 0) - (rightPoint.value.codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
}

function canonicalStringSet(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) invalidTree(`${field} must be a string array`)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string') {
      invalidTree(`${field} must be a string array`)
    }
  }
  return Object.freeze([...new Set(value as string[])].sort(compareCodePoints))
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidTree(`${field} must be a string record`)
  }
  const output: Record<string, string> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodePoints)) {
    const item = (value as Record<string, unknown>)[key]
    if (typeof item !== 'string') invalidTree(`${field}.${key} must be a string`)
    output[key] = item
  }
  return Object.freeze(output)
}

function snapshotJson(value: unknown, path = 'config'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidTree(`${path} must contain only finite numbers`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    const output = Array.from({ length: value.length }, (_, index) =>
      Object.hasOwn(value, index) ? snapshotJson(value[index], `${path}[${index}]`) : null,
    )
    return Object.freeze(output)
  }
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  if (!value || typeof value !== 'object' || (prototype !== Object.prototype && prototype !== null)) {
    invalidTree(`${path} must contain only JSON values`)
  }
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodePoints)) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) invalidTree(`${path}.${key} cannot be undefined`)
    output[key] = snapshotJson(item, `${path}.${key}`)
  }
  return Object.freeze(output)
}

export function canonicalizePluginRow(value: unknown): Readonly<PluginRow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidTree('row must be an object')
  const row = value as Record<string, unknown>
  if (typeof row.disabled !== 'boolean') invalidTree('row.disabled must be a boolean')
  if (row.runtime !== 'in-process' && row.runtime !== 'isolated') {
    invalidTree('row.runtime must be normalized')
  }
  const snapshot = {
    id: nonEmptyString(row.id, 'row.id'),
    plugin: nonEmptyString(row.plugin, 'row.plugin'),
    inject: canonicalStringSet(row.inject, 'row.inject'),
    disabled: row.disabled,
    isolate: stringRecord(row.isolate, 'row.isolate'),
    provides: canonicalStringSet(row.provides, 'row.provides'),
    runtime: row.runtime,
    mountIdentity: nonEmptyString(row.mountIdentity, 'row.mountIdentity') as PluginRow['mountIdentity'],
    mountRevision: nonEmptyString(row.mountRevision, 'row.mountRevision'),
    entryRevision: nonEmptyString(row.entryRevision, 'row.entryRevision'),
    extrasRevision: nonEmptyString(row.extrasRevision, 'row.extrasRevision'),
    ...(row.config === undefined ? {} : { config: snapshotJson(row.config) }),
  } satisfies PluginRow
  return Object.freeze(snapshot)
}

function canonicalRows(value: unknown): readonly Readonly<PluginRow>[] {
  if (!Array.isArray(value)) invalidTree('rows must be an array')
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidTree('rows must not be sparse')
  }
  const rows = value.map(canonicalizePluginRow).sort((left, right) => compareCodePoints(left.id, right.id))
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]?.id === rows[index]?.id) invalidTree(`duplicate row id: ${rows[index]?.id}`)
  }
  const resourceOwned = rows.find(({ id }) => isResourceOwnedRowId(id))
  if (resourceOwned) {
    throw new Error(`E_RESOURCE_OWNED_ROW: ordinary tree cannot contain ${resourceOwned.id}`)
  }
  return Object.freeze(rows)
}

function hashRows(rows: readonly Readonly<PluginRow>[]): string {
  return createHash('sha256').update(JSON.stringify({ rows })).digest('hex')
}

/** Copies, canonicalizes and freezes rows before deriving their identity. */
export function createTreeSnapshot(rows: readonly Readonly<PluginRow>[]): TreeSnapshot {
  const snapshotRows = canonicalRows(rows)
  return Object.freeze({ hash: hashRows(snapshotRows), rows: snapshotRows })
}

/** Rebuilds the canonical snapshot and refuses a caller-supplied hash that does not match it. */
export function verifyTreeSnapshot(value: unknown): TreeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidTree('snapshot must be an object')
  const candidate = value as Record<string, unknown>
  const suppliedHash = nonEmptyString(candidate.hash, 'hash')
  const snapshot = createTreeSnapshot(candidate.rows as readonly Readonly<PluginRow>[])
  if (snapshot.hash !== suppliedHash) throw new Error('E_TREE_HASH: snapshot content does not match hash')
  return snapshot
}
