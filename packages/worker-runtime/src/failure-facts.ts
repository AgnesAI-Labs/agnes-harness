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
// AGH's own error codes are constants in the source (E_HOST_CLOSED, E_GENERATION_PIN_BUSY, ...): they
// name what failed without carrying user content, so the audit keeps them instead of UNKNOWN.
const DOMAIN = /^E_[A-Z][A-Z0-9_]{1,62}$/

export type FailureFacts = {
  errorCode: string
  /** The file error a domain error wraps, when both are known. */
  causeCode?: string
  syscall?: string
  fileKind?: string
  destKind?: string
}

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
  const causeCode = own(error, 'causeCode')
  return {
    errorCode: typeof code === 'string' && (CODES.has(code) || DOMAIN.test(code)) ? code : 'UNKNOWN',
    ...(typeof causeCode === 'string' && CODES.has(causeCode) ? { causeCode } : {}),
    ...(syscall && SYSCALLS.has(syscall) ? { syscall } : {}),
    ...(fileKind ? { fileKind } : {}),
    ...(destKind ? { destKind } : {}),
  }
}

/**
 * What an operator may learn from an unexpected failure: the error code, the failing system call and
 * the kind of file (and, for a rename, of its destination) from closed vocabularies. Never a path, a
 * file name, a message or a stack, which can carry workspace or account details. AGH's own `E_` codes
 * are kept as they are; a domain error that wraps a file error keeps both codes, read through `cause`.
 */
export function failureFacts(error: unknown): FailureFacts {
  try {
    const facts = factsOf(error)
    const cause = facts.syscall ? undefined : own(error, 'cause')
    if (cause === undefined) return facts
    const { errorCode: inner, ...file } = factsOf(cause)
    if (facts.errorCode === 'UNKNOWN') return { errorCode: inner, ...file }
    return { ...facts, ...file, ...(inner === 'UNKNOWN' ? {} : { causeCode: inner }) }
  } catch {
    // A hostile exception (a throwing proxy trap) stays a plain unknown failure.
    return { errorCode: 'UNKNOWN' }
  }
}
