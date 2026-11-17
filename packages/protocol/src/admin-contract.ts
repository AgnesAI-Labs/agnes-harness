import type { TSchema } from '@sinclair/typebox'
import { inspectJsonData } from './json-data.js'
import { type ValidationResult, validateAgainst } from './validate.js'

/** Per-contract read budgets; effect parameters and ordinary responses stay at 1 MiB. */
export function adminPayloadBudget(name: string, side: 'params' | 'result' = 'result'): number {
  if (side === 'params') return 1048576
  if (name === 'PackageCatalogPage' || name === '_agnes/v1/packages.catalog.list') return 8 * 1024 * 1024
  if (name === '_agnes/v1/clientModules.read') return 44739244 + 1024
  return 1048576
}

export function checkAdminData(
  schema: TSchema,
  value: unknown,
  maxBytes = 1048576,
): ValidationResult<unknown> {
  const inspected = inspectJsonData(value, maxBytes)
  if (!inspected.ok)
    return { ok: false, errors: [{ path: '', code: 'TYPE', message: 'expected bounded strict JSON data' }] }
  return validateAgainst(schema, inspected.value)
}

import type * as P from '../gen/ts/package-admin.js'

export const contract = (
  params: TSchema,
  result: TSchema,
  execution: 'read' | 'effect' | 'unblock',
  permission: P.PackageAdminPermission,
) =>
  Object.freeze({
    kind: 'request' as const,
    direction: 'c2s' as const,
    params,
    result,
    administration: Object.freeze({
      execution,
      permission,
      identity: execution === 'read' ? ('none' as const) : ('principal-client-command' as const),
    }),
  })
