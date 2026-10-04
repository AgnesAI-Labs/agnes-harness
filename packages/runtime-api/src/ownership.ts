import type { RuntimeIdentity } from './types.js'

export const NATIVE_RUNTIME: RuntimeIdentity = Object.freeze({ id: 'native', version: '1' })

export type RuntimeErrorCode =
  | 'E_RUNTIME_OWNER'
  | 'E_RUNTIME_UNAVAILABLE'
  | 'E_RUNTIME_REGISTERED'
  | 'E_RUNTIME_API_VERSION'
  | 'E_RUNTIME_LEASE'

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

/** Decode a persisted owner before any runtime-specific replay or repair. Only absence is legacy. */
export function readRuntimeIdentity(value: unknown): RuntimeIdentity {
  if (value === undefined) return NATIVE_RUNTIME
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('E_RUNTIME_OWNER', 'runtime owner must be an object')
  const owner = value as Record<string, unknown>
  if (
    Object.keys(owner).length !== 2 ||
    typeof owner.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(owner.id) ||
    typeof owner.version !== 'string' ||
    owner.version.length === 0 ||
    owner.version.length > 64
  )
    throw new RuntimeError(
      'E_RUNTIME_OWNER',
      'runtime owner requires a valid id and a version of 1–64 characters',
    )
  return Object.freeze({ id: owner.id, version: owner.version })
}

/** Refuse cross-runtime resume before opening a writer or executing recovery. */
export function assertRuntimeOwner(value: unknown, expected: RuntimeIdentity): RuntimeIdentity {
  const actual = readRuntimeIdentity(value)
  if (actual.id !== expected.id || actual.version !== expected.version)
    throw new RuntimeError(
      'E_RUNTIME_OWNER',
      `session belongs to runtime ${actual.id}@${actual.version}; requested ${expected.id}@${expected.version}`,
    )
  return actual
}
