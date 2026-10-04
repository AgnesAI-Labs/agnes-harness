import { createHash } from 'node:crypto'
import type { Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { DataRef, JsonValue, RuntimeWireTypes } from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'

export class ReleaseRefusal extends Error {
  constructor(
    readonly detailCode: string,
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `Release planning refused ${path}; supply a new, complete locked plan`)
  }
}
export function requireRelease(
  condition: unknown,
  detailCode: string,
  path: string,
  message?: string,
): asserts condition {
  if (!condition) throw new ReleaseRefusal(detailCode, path, message)
}
// Only this decoder's detached, deeply frozen results are trusted. A caller's
// frozen object (which may have mutable children or accessors) never earns a cache hit.
const wireTypes = new WeakMap<object, Map<keyof RuntimeWireTypes, unknown>>()
const jsonSnapshots = new WeakSet<object>()
const canonicalSnapshots = new WeakMap<object, string>()
const digestSnapshots = new WeakMap<object, string>()
const frozenSnapshots = new WeakSet<object>()
function rememberSnapshot(value: unknown, json: boolean): void {
  if (value === null || typeof value !== 'object' || frozenSnapshots.has(value)) return
  for (const child of Object.values(value)) rememberSnapshot(child, json)
  Object.freeze(value)
  if (json) jsonSnapshots.add(value)
  frozenSnapshots.add(value)
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object' || !frozenSnapshots.has(value)) return jcs(value)
  let encoded = canonicalSnapshots.get(value)
  if (encoded === undefined) {
    encoded = jcs(value)
    canonicalSnapshots.set(value, encoded)
  }
  return encoded
}
export function readWire<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  if (value !== null && typeof value === 'object') {
    if (name === 'JsonValue' && jsonSnapshots.has(value)) return value as RuntimeWireTypes[K]
    const cached = wireTypes.get(value)?.get(name)
    if (cached !== undefined) return cached as RuntimeWireTypes[K]
  }
  const parsed = validateRuntime(name, value)
  requireRelease(parsed.ok, 'schema_invalid', `/${name}`)
  rememberSnapshot(parsed.value, name === 'JsonValue')
  const cache = (key: object) => {
    const schemas = wireTypes.get(key) ?? new Map<keyof RuntimeWireTypes, unknown>()
    schemas.set(name, parsed.value)
    wireTypes.set(key, schemas)
  }
  if (parsed.value !== null && typeof parsed.value === 'object') cache(parsed.value)
  if (value !== null && typeof value === 'object' && frozenSnapshots.has(value)) cache(value)
  return parsed.value
}
export function digest(value: unknown): string {
  const json = readWire('JsonValue', value)
  if (json !== null && typeof json === 'object') {
    const cached = digestSnapshots.get(json)
    if (cached !== undefined) return cached
    const hash = createHash('sha256').update(canonical(json)).digest('hex')
    digestSnapshots.set(json, hash)
    return hash
  }
  return createHash('sha256').update(canonical(json)).digest('hex')
}
export function equal(left: unknown, right: unknown): boolean {
  // Inputs have crossed the bounded wire decoder; compare their exact canonical bytes.
  return canonical(left as JsonValue) === canonical(right as JsonValue)
}
export function fields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  requireRelease(value !== null && typeof value === 'object' && !Array.isArray(value), 'schema_invalid', path)
  const object = value as Record<string, unknown>
  requireRelease(
    Object.keys(object).length === names.length && names.every((name) => Object.hasOwn(object, name)),
    'schema_invalid',
    path,
  )
  return object
}
export function array(value: unknown, path: string): unknown[] {
  requireRelease(Array.isArray(value), 'schema_invalid', path)
  return value
}
export interface FixtureContent {
  readonly ref: DataRef
  readonly value: JsonValue
}
export function readContent(ref: DataRef, path: string, snapshots: readonly FixtureContent[]): JsonValue {
  if (ref.kind === 'inline') {
    requireRelease(
      ref.digest === digest(ref.value) && ref.bytes === Buffer.byteLength(jcs(ref.value)),
      'content_identity_mismatch',
      path,
    )
    return ref.value
  }
  const candidates = snapshots.filter((item) => equal(item.ref, ref))
  requireRelease(candidates.length === 1, 'content_unavailable', path)
  const content = candidates[0]
  requireRelease(
    content &&
      ref.blob.digest === digest(content.value) &&
      ref.blob.bytes === Buffer.byteLength(jcs(content.value)),
    'content_identity_mismatch',
    path,
  )
  return content.value
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !frozenSnapshots.has(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
    frozenSnapshots.add(value)
  }
  return value
}
export function releaseError(detailCode: string, path = '/assembly', message?: string): RuntimeError {
  return {
    code:
      detailCode === 'schema_invalid'
        ? 'invalid_input'
        : detailCode.includes('unimplemented')
          ? 'incompatible'
          : 'conflict',
    detailCode,
    message: message ?? `Release planning refused ${path}; supply a new, complete locked plan`,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'assembly-release-set',
  }
}
export function attempt<T>(work: () => T): Outcome<T> {
  try {
    return { ok: true, value: work() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ReleaseRefusal
          ? releaseError(error.detailCode, error.path, error.message)
          : releaseError('schema_invalid'),
    }
  }
}
