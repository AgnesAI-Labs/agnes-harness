import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { DataRef, RuntimeError, RuntimeWireTypes } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export class MigrationRefusal extends Error {
  constructor(
    readonly detailCode: string,
    readonly code: RuntimeError['code'] = 'conflict',
  ) {
    super(detailCode)
  }
}
export function requireMigration(
  condition: unknown,
  detailCode: string,
  code: RuntimeError['code'] = 'conflict',
): asserts condition {
  if (!condition) throw new MigrationRefusal(detailCode, code)
}
export function decode<K extends keyof RuntimeWireTypes>(kind: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(kind, value)
  requireMigration(result.ok, 'schema_invalid', 'invalid_input')
  return result.value
}
export const hash = (value: unknown): string => canonicalJsonDigest(decode('JsonValue', value))
export const same = (left: unknown, right: unknown): boolean => hash(left) === hash(right)
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(immutable)
    Object.freeze(value)
  }
  return value
}
export function failure(detailCode: string, code: RuntimeError['code'] = 'conflict'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: `Migration refused: ${detailCode}`,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'migration',
    },
  }
}
export function attempt<T>(body: () => T): Outcome<T> {
  try {
    return { ok: true, value: body() }
  } catch (error) {
    return error instanceof MigrationRefusal
      ? failure(error.detailCode, error.code)
      : failure('schema_invalid', 'invalid_input')
  }
}
export function verifyData(ref: DataRef): void {
  decode('DataRef', ref)
  if (ref.kind === 'inline')
    requireMigration(
      ref.digest === hash(ref.value) && ref.bytes === Buffer.byteLength(jcs(ref.value)),
      'content_identity_mismatch',
    )
}
