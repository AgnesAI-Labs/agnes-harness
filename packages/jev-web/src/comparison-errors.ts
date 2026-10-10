import { JsonRpcError } from '@agnes/sdk/browser'
import type { Translate } from './jev-locale.js'

const reasons: Readonly<Record<string, string>> = {
  COMPARISON_PREPARATION_BUSY: 'err.comparison-preparation-busy',
  WORKSPACE_SYMLINK_UNSUPPORTED: 'err.workspace-symlink-unsupported',
  WORKSPACE_SYMLINK_UNRESOLVED: 'err.workspace-symlink-unresolved',
  WORKSPACE_SYMLINK_EXCLUDED_TARGET: 'err.workspace-symlink-excluded-target',
  WORKSPACE_EXTERNAL_REFERENCE_DENIED: 'err.workspace-external-reference-denied',
  WORKSPACE_EXTERNAL_REFERENCE_UNSUPPORTED: 'err.workspace-external-reference-unsupported',
  WORKSPACE_EXTERNAL_REFERENCE_CHANGED: 'err.workspace-external-reference-changed',
  WORKSPACE_MANIFEST_INVALID: 'err.workspace-manifest-invalid',
  WORKSPACE_SNAPSHOT_LIMIT: 'err.workspace-snapshot-limit',
  WORKSPACE_SOURCE_CHANGED: 'err.workspace-source-changed',
  WORKSPACE_READ_DENIED: 'err.workspace-read-denied',
  WORKSPACE_SPECIAL_FILE_UNSUPPORTED: 'err.workspace-special-file-unsupported',
  WORKSPACE_WORKSPACE_OVERLAP: 'err.workspace-workspace-overlap',
  WORKSPACE_INVALID_SOURCE: 'err.workspace-invalid-source',
  WORKSPACE_INVALID_STORAGE: 'err.workspace-invalid-storage',
  WORKSPACE_INVALID_CONFIGURATION: 'err.workspace-invalid-configuration',
  WORKSPACE_INVALID_LIMIT: 'err.workspace-invalid-limit',
  WORKSPACE_INVALID_ID: 'err.workspace-invalid-id',
  WORKSPACE_SNAPSHOT_EXISTS: 'err.workspace-snapshot-exists',
  WORKSPACE_COPY_FAILED: 'err.workspace-copy-failed',
  WORKSPACE_CLEANUP_FAILED: 'err.workspace-cleanup-failed',
  WORKSPACE_SNAPSHOT_FAILED: 'err.workspace-snapshot-failed',
  COMPARISON_ISOLATION_REQUIRED: 'err.comparison-isolation-required',
  COMPARISON_WRITABLE_OVERLAP: 'err.comparison-writable-overlap',
}
const generic = 'err.generic'

/** Decode only public creation codes; remote messages, paths and unknown workspace codes stay hidden. */
export function comparisonCreationMessage(error: unknown, t: Translate): string | undefined {
  if (!(error instanceof JsonRpcError)) return undefined
  const code = error.data.code
  if (typeof code !== 'string') return undefined
  const reason = reasons[code]
  if (reason !== undefined) return `${t(reason)}（${code}）`
  if (code === 'COMPARISON_CREATE_FAILED' || code.startsWith('WORKSPACE_')) return t(generic)
  return undefined
}
