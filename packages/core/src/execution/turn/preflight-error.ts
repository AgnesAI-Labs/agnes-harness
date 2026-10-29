/** Preflight failures never authorize execution and never expose exception text. */
export function preflightError(error: unknown): { code: string; message: string } {
  const cause = (error as { code?: unknown } | null)?.code
  if (cause === 'E_WORKSPACE_CLOSED')
    return { code: cause, message: 'Workspace is closed. Reopen it before requesting file operations.' }
  if (cause === 'E_FS_PREFLIGHT_UNAVAILABLE')
    return {
      code: cause,
      message: 'Filesystem checks are unavailable. Restore the workspace capability before retrying.',
    }
  if (
    ['E_FS_DENIED', 'FS_DENIED', 'EACCES', 'EPERM', 'MEMORY_SCOPE_DENIED', 'MEMORY_DISABLED'].includes(
      String(cause),
    )
  )
    return {
      code: 'E_FS_DENIED',
      message: 'E_FS_DENIED: Filesystem path denied by policy. Do not bypass this refusal with another tool.',
    }
  if (['EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC', 'ENOTDIR'].includes(String(cause)))
    return {
      code: 'E_FS_IO',
      message:
        'Filesystem inspection failed. Resolve the filesystem error before retrying; no tool operation ran.',
    }
  return {
    code: 'E_FS_CHECK_FAILED',
    message:
      'Filesystem inspection could not complete. Check the workspace diagnostics before retrying; no tool operation ran.',
  }
}
