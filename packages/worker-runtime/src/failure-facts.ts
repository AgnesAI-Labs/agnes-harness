// Node fs, libuv and the Windows addon's codes an operator can act on; anything else is UNKNOWN.
const CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EFBIG',
  'EINVAL',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
  'ETIMEDOUT',
  'EXDEV',
])
const SYSCALLS = new Set([
  'access',
  'chmod',
  'close',
  'copyfile',
  'fdatasync',
  'fstat',
  'fsync',
  'ftruncate',
  'futime',
  'link',
  'lstat',
  'mkdir',
  'mkdtemp',
  'open',
  'opendir',
  'read',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'scandir',
  'spawn',
  'spawnSync',
  'stat',
  'symlink',
  'unlink',
  'utime',
  'watch',
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
const NAMED_KINDS = new Set([...KINDS.map(([, kind]) => kind), 'other'])

export type FailureFacts = { errorCode: string; syscall?: string; fileKind?: string; destKind?: string }

const own = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

// A raw error carries a path; a worker reply already carries the kind it was reduced to.
function kind(error: unknown, path: string, named: string): string | undefined {
  const raw = own(error, path)
  if (typeof raw === 'string') return KINDS.find(([pattern]) => pattern.test(raw))?.[1] ?? 'other'
  const reduced = own(error, named)
  return typeof reduced === 'string' && NAMED_KINDS.has(reduced) ? reduced : undefined
}

function factsOf(error: unknown): FailureFacts {
  const code = own(error, 'code')
  // Node names a spawn failure `spawn <file>`; only the call itself is kept.
  const call = own(error, 'syscall')
  const syscall = typeof call === 'string' ? call.split(' ')[0] : undefined
  const fileKind = kind(error, 'path', 'fileKind')
  const destKind = kind(error, 'dest', 'destKind')
  return {
    errorCode: typeof code === 'string' && CODES.has(code) ? code : 'UNKNOWN',
    ...(syscall && SYSCALLS.has(syscall) ? { syscall } : {}),
    ...(fileKind ? { fileKind } : {}),
    ...(destKind ? { destKind } : {}),
  }
}

/**
 * What an operator may learn from an unexpected failure: the error code, the failing system call and
 * the kind of file (and, for a rename, of its destination) from closed vocabularies. Never a path, a
 * file name, a message or a stack, which can carry workspace or account details. A domain error that
 * wraps a file error is read through its `cause`.
 */
export function failureFacts(error: unknown): FailureFacts {
  try {
    const facts = factsOf(error)
    if (facts.errorCode !== 'UNKNOWN' || facts.syscall) return facts
    const cause = own(error, 'cause')
    return cause === undefined ? facts : factsOf(cause)
  } catch {
    // A hostile exception (a throwing proxy trap) stays a plain unknown failure.
    return { errorCode: 'UNKNOWN' }
  }
}
