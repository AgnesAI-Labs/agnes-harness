/**
 * A session's shell command for this platform: `posix` for `sh`, `powershell` for Windows PowerShell, which a session
 * runs on Windows (no `&&`, no `touch`, variables as `$env:NAME`).
 */
export const byShell = (posix: string, powershell: string): string =>
  process.platform === 'win32' ? powershell : posix
