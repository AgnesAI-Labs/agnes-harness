import type { PackageAdminError } from '@agnes/protocol'

const reasons = {
  'package-json-missing': 'manifest-missing',
  'package-json': 'manifest-invalid',
  'package-name': 'manifest-invalid',
  'package-version': 'manifest-invalid',
  'package-license': 'manifest-invalid',
  'package-dependencies': 'manifest-invalid',
  'static-declaration-required': 'not-plugin',
  'git-ref': 'git-ref',
  'git-fetch': 'git-fetch',
} as const

/** Do not expose source locations, process output or exception messages to the browser. */
export function packageSourceFailure(code: string, reason: unknown): PackageAdminError['sourceFailure'] {
  return code === 'E_PACKAGE_SOURCE' && typeof reason === 'string' && Object.hasOwn(reasons, reason)
    ? reasons[reason as keyof typeof reasons]
    : undefined
}
