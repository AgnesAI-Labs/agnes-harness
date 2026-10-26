import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, lstatSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { PackageError } from './errors.js'
import { hashFileReads, mapFileChecks, walkFileChecks } from './file-read-pool.js'
import { checkCancelled } from './ports.js'

export const DEFAULT_EXCLUDES = ['node_modules', '.git', 'fixtures/out'] as const

export const sourceError = (
  message: string,
  reason: string,
  extraDetail?: Record<string, unknown>,
): PackageError => new PackageError('E_DEP_MISSING', message, { detail: { reason, ...extraDetail } })

function normalizedExcludes(values: readonly string[]): string[] {
  return values.map((value) => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (
      normalized.length === 0 ||
      normalized.includes('\0') ||
      normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error('invalid hash exclusion')
    return normalized
  })
}

export function excluded(rel: string, rules: readonly string[]): boolean {
  const parts = rel.split('/')
  return rules.some((rule) => {
    if (!rule.includes('/') && parts.includes(rule)) return true
    return rel === rule || rel.startsWith(`${rule}/`)
  })
}

export function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Digests of trees this process already hashed, reused while nothing a writer changes looks
 * different: the root's dev/ino and every file's relative path, size, mtime and inode. ctime is left
 * out on purpose, because linking a file into a runtime generation moves its ctime and not its bytes.
 * Several readers in one start (package load, presets, preflight, session admission, generation
 * reuse) verify the same snapshot trees, up to 14 times each; reading every file each time is what
 * makes a worker start slow, most of all where reads are scanned. A tree with a file modified less
 * than RECENT_WRITE_MS before the hash began is not stored: file times advance in clock ticks of a few
 * milliseconds, so a same-size rewrite inside one tick would otherwise keep the old signature (git's
 * racily-clean rule). Gates and editable sources use this store too; performance was ranked above a
 * strict re-read. The cost: a same-size rewrite that restores mtime, whether by copy -p, a reproducible
 * build or deliberately, is not seen until the tree is replaced, the process restarts or a
 * verification refusal clears this store (`forgetDirectoryDigests`). A cache hit still walks the
 * tree and refuses links and special entries, but skips the per-file real-path containment check.
 */
type KnownTree = Readonly<{ dev: number; ino: number; signature: string; digest: string }>
const knownTrees = new Map<string, KnownTree>()
const KNOWN_TREE_LIMIT = 512
const RECENT_WRITE_MS = 2_000

export function forgetDirectoryDigests(): void {
  knownTrees.clear()
}

function treeKey(root: string, rules: readonly string[]): string {
  return `${root}\0${JSON.stringify(rules)}`
}

function treeSignature(
  files: ReadonlyArray<
    Readonly<{ rel: string; stat: Readonly<{ size: number; mtimeMs: number; ino: number }> }>
  >,
): string {
  const hash = createHash('sha256')
  for (const { rel, stat } of files) hash.update(`${rel}\0${stat.size}\0${stat.mtimeMs}\0${stat.ino}\n`)
  return hash.digest('hex')
}

const freshDigests = new AsyncLocalStorage<true>()

/**
 * Hash every tree in full for the duration of `action`, without consulting digests reused by file
 * metadata. Write gates (a new runtime generation archive) run here so their verdict never rests on
 * an earlier observation of the same metadata; what they hash may still be remembered for reads.
 */
export function withFreshDigests<T>(action: () => T): T {
  return freshDigests.run(true, action)
}

function knownDigest(key: string, root: Readonly<{ dev: number; ino: number }>, signature: string) {
  if (freshDigests.getStore()) return undefined
  const known = knownTrees.get(key)
  return known && known.dev === root.dev && known.ino === root.ino && known.signature === signature
    ? known.digest
    : undefined
}

function rememberDigest(
  key: string,
  root: Readonly<{ dev: number; ino: number }>,
  signature: string,
  digest: string,
  started: number,
  mtimes: Iterable<number>,
): void {
  for (const mtime of mtimes) if (mtime > started - RECENT_WRITE_MS) return
  knownTrees.delete(key)
  const oldest = knownTrees.keys().next().value
  if (knownTrees.size >= KNOWN_TREE_LIMIT && oldest !== undefined) knownTrees.delete(oldest)
  knownTrees.set(key, { dev: root.dev, ino: root.ino, signature, digest })
}

export function hashDirectory(dir: string, opts: { exclude?: string[]; signal?: AbortSignal } = {}): string {
  const started = Date.now()
  checkCancelled(opts.signal)
  let root: string
  try {
    if (lstatSync(dir).isSymbolicLink()) throw sourceError('package directory is a symbolic link', 'symlink')
    root = nativeRealpathSync(dir)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory is unavailable', 'directory-unavailable')
  }
  let rootStat: Stats
  try {
    rootStat = statSync(root)
    if (!rootStat.isDirectory()) throw sourceError('package source is not a directory', 'not-directory')
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory changed while hashing', 'tree-changed')
  }
  const rules = normalizedExcludes(opts.exclude ?? [...DEFAULT_EXCLUDES])
  const files: Array<{ rel: string; file: string; stat: Stats }> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      checkCancelled(opts.signal)
      const file = join(current, entry.name)
      const rel = relative(root, file).split(sep).join('/')
      if (excluded(rel, rules)) continue
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw sourceError('package tree contains a symbolic link', 'symlink')
      if (stat.isDirectory()) {
        walk(file)
        continue
      }
      if (!stat.isFile()) throw sourceError('package tree contains a special entry', 'special-entry')
      files.push({ rel, file, stat })
    }
  }
  walk(root)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const key = treeKey(root, rules),
    signature = treeSignature(files)
  const known = knownDigest(key, rootStat, signature)
  if (known !== undefined) return known
  const outer = createHash('sha256')
  // Unlike the async walk this read does not refuse a file that changes under it; it only declines
  // to store a digest that may mix two versions of a file.
  let unchanged = true
  for (const { rel, file, stat } of files) {
    checkCancelled(opts.signal)
    let actual: string
    try {
      actual = nativeRealpathSync(file)
    } catch {
      throw sourceError('package file changed while hashing', 'tree-changed')
    }
    if (!contained(root, actual)) throw sourceError('package file escapes its source tree', 'path-escape')
    const inner = createHash('sha256').update(rel).update('\0').update(readFileSync(file)).digest()
    outer.update(inner)
    const after = lstatSync(file)
    if (!sameFileObservation(after, stat)) unchanged = false
  }
  const digest = `sha256-${outer.digest('hex')}`
  if (unchanged)
    rememberDigest(
      key,
      rootStat,
      signature,
      digest,
      started,
      files.map(({ stat }) => stat.mtimeMs),
    )
  return digest
}

/** Same wire digest and exclusions as hashDirectory; yields for filesystem IO and streams file bytes. */
export async function hashDirectoryAsync(
  dir: string,
  opts: { exclude?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
  // A Host worker hard-links immutable snapshot files into each runtime generation without the
  // package lock, which moves their ctime but never their bytes. Walk again a few times so one such
  // link is not a changed tree; every digest still comes from a single unchanged traversal.
  for (let attempt = 1; ; attempt++) {
    try {
      return await hashDirectoryOnce(dir, opts)
    } catch (error) {
      if (attempt >= 4 || !(error instanceof PackageError) || error.detail.reason !== 'tree-changed')
        throw error
    }
    await delay(25 * 2 ** attempt)
  }
}

async function hashDirectoryOnce(
  dir: string,
  opts: { exclude?: string[]; signal?: AbortSignal },
): Promise<string> {
  const started = Date.now()
  checkCancelled(opts.signal)
  let root: string
  try {
    if ((await asyncFs.lstat(dir)).isSymbolicLink())
      throw sourceError('package directory is a symbolic link', 'symlink')
    root = await asyncFs.realpath(dir)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory is unavailable', 'directory-unavailable')
  }
  const rootStat = await asyncFs.stat(root)
  if (!rootStat.isDirectory()) throw sourceError('package source is not a directory', 'not-directory')
  const rules = normalizedExcludes(opts.exclude ?? [...DEFAULT_EXCLUDES])
  const files: { rel: string; file: string; observed: Stats }[] = []
  // Reuse the bounded metadata pool for sibling directories too. Nested entry checks stay
  // bounded (four directories, four checks each); file handles/scratch memory are unchanged.
  await walkFileChecks([root], async (current) => {
    const next: string[] = []
    checkCancelled(opts.signal)
    const entries = await asyncFs.readdir(current, { withFileTypes: true })
    const observed = await mapFileChecks(entries, async (entry) => {
      checkCancelled(opts.signal)
      const file = join(current, entry.name)
      const rel = relative(root, file).split(sep).join('/')
      if (excluded(rel, rules)) return undefined
      return { file, rel, stat: await asyncFs.lstat(file) }
    })
    for (const item of observed) {
      if (!item) continue
      const { file, rel, stat } = item
      if (stat.isSymbolicLink()) throw sourceError('package tree contains a symbolic link', 'symlink')
      if (stat.isDirectory()) next.push(file)
      else if (stat.isFile()) files.push({ rel, file, observed: stat })
      else throw sourceError('package tree contains a special entry', 'special-entry')
    }
    return next
  })
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const key = treeKey(root, rules),
    signature = treeSignature(files.map(({ rel, observed }) => ({ rel, stat: observed })))
  const known = knownDigest(key, rootStat, signature)
  if (known !== undefined) return known
  const hashFile = async ({ rel, file, observed }: (typeof files)[number], chunk: Uint8Array) => {
    checkCancelled(opts.signal)
    if (!contained(root, await asyncFs.realpath(file)))
      throw sourceError('package file escapes its source tree', 'path-escape')
    const handle = await asyncFs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const before = await handle.stat()
      if (!before.isFile() || !sameFileObservation(before, observed))
        throw sourceError('package file changed while hashing', 'tree-changed')
      const inner = createHash('sha256').update(rel).update('\0')
      for (;;) {
        checkCancelled(opts.signal)
        const { bytesRead } = await handle.read(chunk)
        if (!bytesRead) break
        inner.update(chunk.subarray(0, bytesRead))
      }
      const after = await handle.stat()
      const linked = await asyncFs.lstat(file)
      if (
        linked.isSymbolicLink() ||
        linked.ino !== before.ino ||
        linked.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw sourceError('package file changed while hashing', 'tree-changed')
      return inner.digest()
    } finally {
      await handle.close()
    }
  }
  const digests = await hashFileReads(files, hashFile)
  // A previously closed file can change while a later file yields. Recheck the entire observation,
  // including ctime: same-size writes with a restored mtime must still refuse this traversal.
  await mapFileChecks(files, async ({ file, observed }) => {
    checkCancelled(opts.signal)
    const current = await asyncFs.lstat(file)
    if (
      !current.isFile() ||
      !sameFileObservation(current, observed) ||
      !contained(root, await asyncFs.realpath(file))
    )
      throw sourceError('package file changed while hashing', 'tree-changed')
  })
  const finalRoot = await asyncFs.lstat(dir)
  if (
    finalRoot.isSymbolicLink() ||
    finalRoot.ino !== rootStat.ino ||
    finalRoot.dev !== rootStat.dev ||
    (await asyncFs.realpath(dir)) !== root
  )
    throw sourceError('package directory changed while hashing', 'tree-changed')
  checkCancelled(opts.signal)
  const outer = createHash('sha256')
  for (const digest of digests) outer.update(digest)
  const digest = `sha256-${outer.digest('hex')}`
  rememberDigest(
    key,
    rootStat,
    signature,
    digest,
    started,
    files.map(({ observed }) => observed.mtimeMs),
  )
  return digest
}

function sameFileObservation(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}
