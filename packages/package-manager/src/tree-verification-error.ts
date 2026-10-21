import { PackageError, packageSourceError } from './errors.js'

export type TreeVerificationFailure = 'integrity' | 'unstable' | 'unavailable'

/** Only explicit byte/structure evidence can revoke trust. Errnos (including wrapped causes)
 * describe availability or a torn traversal, never proof of malicious package bytes. */
export function treeVerificationFailure(error: unknown): TreeVerificationFailure {
  const seen = new Set<unknown>()
  let result: TreeVerificationFailure = 'unavailable'
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    if (typeof code === 'string' && !code.startsWith('E_PACKAGE_'))
      return ['ENOENT', 'ENOTDIR', 'ESTALE', 'ELOOP'].includes(code) ? 'unstable' : 'unavailable'
    if (error instanceof PackageError) {
      if (['symlink', 'special-entry', 'not-directory', 'path-escape'].includes(String(error.detail.reason)))
        result = 'integrity'
      else if (error.detail.reason === 'tree-changed') result = 'unstable'
    }
    error = 'cause' in error ? error.cause : undefined
  }
  return result
}

export function treeVerificationError(reason: string): PackageError {
  return packageSourceError('package file identity is invalid or changed', reason)
}
