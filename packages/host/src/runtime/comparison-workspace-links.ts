import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class WorkspaceLinkError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface ComparisonExternalReference {
  path: string
  target: string
  identity: string
  size: number
  digest: string
}
export const pathInside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
export const fileIdentity = (stat: BigIntStats): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':')

/** Resolve links without traversing their directory contents or preserving aliases outside the source. */
export async function captureLink(
  source: string,
  path: string,
  excluded: ReadonlySet<string>,
): Promise<{ target: string; externalTarget?: string }> {
  const absolute = resolve(source, path)
  if ((await realpath(dirname(absolute))) !== dirname(absolute))
    throw new WorkspaceLinkError('SOURCE_CHANGED')
  const raw = await readlink(absolute)
  const direct = resolve(dirname(absolute), raw)
  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch {
    throw new WorkspaceLinkError('SYMLINK_UNRESOLVED')
  }
  const internal = pathInside(source, canonical)
  const directInternal = pathInside(source, direct)
  if (
    [canonical, ...(directInternal ? [direct] : [])].some(
      (target) =>
        pathInside(source, target) &&
        relative(source, target)
          .split(sep)
          .some((part) => excluded.has(part)),
    )
  )
    throw new WorkspaceLinkError('SYMLINK_EXCLUDED_TARGET')
  if (internal) return { target: relative(dirname(absolute), directInternal ? direct : canonical) || '.' }
  return {
    target: directInternal ? relative(dirname(absolute), direct) || '.' : canonical,
    externalTarget: canonical,
  }
}

/** Hash an explicitly authorized canonical external regular file using a pinned no-follow descriptor. */
export async function externalReference(
  path: string,
  target: string,
  maxBytes: number,
): Promise<ComparisonExternalReference> {
  if ((await realpath(target)) !== target) throw new WorkspaceLinkError('EXTERNAL_REFERENCE_CHANGED')
  const stat = await lstat(target, { bigint: true })
  if (!stat.isFile() || (stat.mode & 0o6000n) !== 0n)
    throw new WorkspaceLinkError('EXTERNAL_REFERENCE_UNSUPPORTED')
  if (stat.size > BigInt(maxBytes)) throw new WorkspaceLinkError('SNAPSHOT_LIMIT')
  const identity = fileIdentity(stat)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (fileIdentity(await handle.stat({ bigint: true })) !== identity)
      throw new WorkspaceLinkError('EXTERNAL_REFERENCE_CHANGED')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > maxBytes || BigInt(size) > stat.size)
        throw new WorkspaceLinkError('EXTERNAL_REFERENCE_CHANGED')
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (
      BigInt(size) !== stat.size ||
      fileIdentity(await handle.stat({ bigint: true })) !== identity ||
      fileIdentity(await lstat(target, { bigint: true })) !== identity ||
      (await realpath(target)) !== target
    )
      throw new WorkspaceLinkError('EXTERNAL_REFERENCE_CHANGED')
    return { path, target, identity, size, digest: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}
