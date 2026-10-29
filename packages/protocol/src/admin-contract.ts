import type { TSchema } from '@sinclair/typebox'
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
