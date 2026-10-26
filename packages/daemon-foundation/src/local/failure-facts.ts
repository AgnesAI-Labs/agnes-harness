const CODES = ['EPERM', 'EACCES', 'ENOENT', 'EBUSY', 'ENOSPC', 'ETIMEDOUT', 'EIO'] as const
const SYSCALLS = new Set([
  'access',
  'chmod',
  'copyfile',
  'fstat',
  'fsync',
  'ftruncate',
  'link',
  'lstat',
  'mkdir',
  'open',
  'read',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'scandir',
  'spawn',
  'stat',
  'symlink',
  'unlink',
  'utime',
  'write',
])
// Checked in order: a published file's temporary name ends in `.tmp` whatever it replaces.
const KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.tmp$/i, 'temp'],
  [/\.db(?:-wal|-shm|-journal)?$/i, 'database'],
  [/\.jsonl$/i, 'log'],
  [/\.json$/i, 'json'],
  [/\.lock$/i, 'lock'],
  [/\.(?:owner|pid)$/i, 'marker'],
]
const kindOf = (path: unknown): string | undefined =>
  typeof path === 'string' ? (KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? 'other') : undefined

/**
 * What an operator may learn from an unexpected request failure: the error code, the failing system
 * call and the kind of file (and, for a rename, of its destination) from closed vocabularies. Never a
 * path, a file name, a message or a stack, which can carry workspace or account details.
 */
export function failureFacts(error: unknown): {
  errorCode: string
  syscall?: string
  fileKind?: string
  destKind?: string
} {
  const own = (key: string): unknown =>
    error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined
  const syscall = own('syscall')
  const fileKind = kindOf(own('path'))
  const destKind = kindOf(own('dest'))
  return {
    errorCode: CODES.find((known) => known === own('code')) ?? 'UNKNOWN',
    ...(typeof syscall === 'string' && SYSCALLS.has(syscall) ? { syscall } : {}),
    ...(fileKind ? { fileKind } : {}),
    ...(destKind ? { destKind } : {}),
  }
}
