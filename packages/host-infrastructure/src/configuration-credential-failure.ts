import { lstatSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileSecretsDir } from '@agnes/host-common/paths'
import { CredentialStoreError } from './adapters/credential-files.js'
import { createPlatform } from './adapters/platform.js'
import { createFileAudit } from './audit.js'
import { ConfigurationError, type CredentialDiagnostic } from './configuration-error.js'

export function configurationCredentialFailure(
  home: string,
  error: unknown,
  operation: 'read' | 'write',
): ConfigurationError {
  const failure = error instanceof CredentialStoreError ? error : undefined
  try {
    createFileAudit(join(home, 'data', 'audit', 'configuration.jsonl')).write({
      kind: 'daemon.request_failed',
      detail: {
        operation,
        errorClass: failure ? 'CredentialStoreError' : 'UnknownError',
        errorCode: failure?.code ?? 'UNKNOWN',
        reason: failure?.reason,
        osCode: failure?.osCode,
        path: failure?.path ?? fileSecretsDir(home),
      },
    })
  } catch {
    /* Audit failure must not replace the refusal. */
  }
  return new ConfigurationError(
    failure?.osCode === 'ENOSPC'
      ? 'CONFIG_CREDENTIAL_NO_SPACE'
      : failure?.osCode === 'EROFS'
        ? 'CONFIG_CREDENTIAL_READ_ONLY'
        : failure &&
            (['mode', 'owner'].includes(failure.reason) || ['EPERM', 'EACCES'].includes(failure.osCode ?? ''))
          ? 'CONFIG_CREDENTIAL_PERMISSIONS'
          : failure && !['io', 'enforcement-unavailable'].includes(failure.reason)
            ? 'CONFIG_CREDENTIAL_INVALID'
            : 'CONFIG_CREDENTIAL_STORE',
    undefined,
    credentialDiagnostic(home, failure),
  )
}

/** Only metadata from the failed target is eligible for an RPC hint. */
function credentialDiagnostic(
  home: string,
  error: CredentialStoreError | undefined,
): CredentialDiagnostic | undefined {
  if (!error) return undefined
  const part = !error.path
    ? 'store'
    : error.path === home
      ? 'home'
      : error.path.startsWith(fileSecretsDir(home) + sep) || error.path === fileSecretsDir(home)
        ? 'secrets'
        : error.path.startsWith(join(home, 'auth') + sep) || error.path === join(home, 'auth')
          ? 'auth'
          : error.path.startsWith(join(home, 'locks') + sep) || error.path === join(home, 'locks')
            ? 'locks'
            : 'store'
  let mode: string | undefined
  let expectedMode: string | undefined
  try {
    if (error.path) {
      const stat = lstatSync(error.path)
      mode = (stat.mode & 0o7777).toString(8).padStart(4, '0')
      if (!stat.isSymbolicLink() && createPlatform().os !== 'win32')
        expectedMode = stat.isDirectory() ? '0700' : stat.isFile() ? '0600' : undefined
    }
  } catch {
    /* The check may concern a missing target. */
  }
  return { part, check: error.reason, ...(mode ? { mode } : {}), ...(expectedMode ? { expectedMode } : {}) }
}
