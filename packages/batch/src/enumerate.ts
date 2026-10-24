import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BatchError, type Input, type InputReference } from './contracts.js'

export interface SnapshotArtifacts {
  /** Captures original bytes in owned files or in a real scoped attachment artifact store. */
  put(bytes: Uint8Array, metadata: { batch: string; digest: string; name: string }): Promise<InputReference>
  discard?(input: InputReference): Promise<void>
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
const identity = (s: Awaited<ReturnType<typeof lstat>>) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
/** Check every ancestor, not merely the final file. Recheck after reading before publishing bytes. */
async function ancestry(root: string, path: string): Promise<string> {
  if (!inside(root, path)) throw new BatchError('E_BATCH_PATH')
  let current = root
  const parts = relative(root, path).split(sep).filter(Boolean)
  const ids: string[] = []
  for (let n = 0; n <= parts.length; n++) {
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BatchError('E_BATCH_SYMLINK')
    ids.push(`${stat.dev}:${stat.ino}`)
    const part = parts[n]
    if (part) current = join(current, part)
  }
  return ids.join('/')
}
/** Captures sorted immutable file content; later file edits cannot change a dispatched item. */
export async function snapshotFolder(input: {
  id: string
  root: string
  dir: string
  artifacts: SnapshotArtifacts
  signal?: AbortSignal
  extensions?: readonly string[]
  maxFiles?: number
  maxTotalBytes?: number
}): Promise<Input[]> {
  const root = resolve(input.root),
    dir = resolve(root, input.dir)
  if (!inside(root, dir) || (await realpath(root)) !== root) throw new BatchError('E_BATCH_PATH')
  const maxFiles = input.maxFiles ?? 100_000,
    maxTotalBytes = input.maxTotalBytes ?? 256 * 1024 * 1024
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 100_000 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < 1 ||
    maxTotalBytes > 2 ** 32
  )
    throw new BatchError('E_BATCH_INPUTS')
  if (input.extensions?.some((v) => !/^[a-z0-9]{1,10}$/u.test(v))) throw new BatchError('E_BATCH_INPUTS')
  const accepted = new Set(
    input.extensions ?? [
      'txt',
      'md',
      'csv',
      'tsv',
      'json',
      'jsonl',
      'log',
      'xml',
      'yaml',
      'yml',
      'png',
      'jpg',
      'jpeg',
    ],
  )
  const files: Input[] = []
  let total = 0,
    entries = 0
  async function walk(folder: string, depth: number): Promise<void> {
    input.signal?.throwIfAborted()
    if (depth > 32) throw new BatchError('E_BATCH_DEPTH')
    const parent = await ancestry(root, folder)
    const directoryBefore = identity(await lstat(folder))
    const children: string[] = []
    for await (const entry of await opendir(folder)) {
      if (++entries > 200_000) throw new BatchError('E_BATCH_INPUTS')
      children.push(entry.name)
    }
    children.sort()
    for (const name of children) {
      input.signal?.throwIfAborted()
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || name.includes('\\'))
        throw new BatchError('E_BATCH_PATH')
      const path = join(folder, name),
        before = await lstat(path)
      if (before.isSymbolicLink()) throw new BatchError('E_BATCH_SYMLINK')
      if (name.startsWith('.') || name === 'agh-batch') continue
      if (before.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      if (!before.isFile()) throw new BatchError('E_BATCH_FILE')
      if (files.length >= maxFiles) throw new BatchError('E_BATCH_INPUT_LIMIT')
      const extension = name.split('.').at(-1)!.toLowerCase()
      const supported = new Set([
        'txt',
        'md',
        'csv',
        'tsv',
        'json',
        'jsonl',
        'log',
        'xml',
        'yaml',
        'yml',
        'png',
        'jpg',
        'jpeg',
      ])
      const image = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)
      if (input.extensions?.length && !accepted.has(extension)) continue
      const skip = !supported.has(extension)
        ? 'unsupported_type'
        : before.size > (image ? 20 : 1) * 1024 * 1024
          ? 'too_large'
          : undefined
      if (skip) {
        files.push({
          name: relative(dir, path).split(sep).join('/'),
          size: before.size,
          digest: '0'.repeat(64),
          skip,
        })
        continue
      }
      if (total + before.size > maxTotalBytes) throw new BatchError('E_BATCH_INPUT_LIMIT')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || identity(before) !== identity(opened)) throw new BatchError('E_BATCH_CHANGED')
        bytes = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          input.signal?.throwIfAborted()
          const result = await handle.read(bytes, offset, bytes.length - offset, null)
          if (!result.bytesRead) break
          offset += result.bytesRead
        }
        if (
          offset !== before.size ||
          identity(before) !== identity(await handle.stat()) ||
          identity(before) !== identity(await lstat(path)) ||
          parent !== (await ancestry(root, folder))
        )
          throw new BatchError('E_BATCH_CHANGED')
        bytes = bytes.subarray(0, offset)
      } finally {
        await handle.close()
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      const itemName = relative(dir, path).split(sep).join('/')
      const reference = await input.artifacts.put(bytes, { batch: input.id, digest, name: itemName })
      files.push({ name: itemName, size: bytes.length, digest, ...reference })
      total += bytes.length
    }
    if (directoryBefore !== identity(await lstat(folder)) || parent !== (await ancestry(root, folder)))
      throw new BatchError('E_BATCH_CHANGED')
  }
  try {
    await walk(dir, 0)
  } catch (error) {
    await Promise.allSettled(files.map((file) => input.artifacts.discard?.(file)))
    throw error
  }
  if (!files.length) throw new BatchError('E_BATCH_EMPTY')
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
