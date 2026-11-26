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
type KnownTree = Readonly<{ dev: number; ino: number; signature: string; digest: string; manifest?: Buffer }>
const knownTrees = new Map<string, KnownTree>()
const KNOWN_TREE_LIMIT = 512
const RECENT_WRITE_MS = 2_000
// The tree digest fixes the manifest leaf regardless of the tree's path.
const manifestDigests = new Map<string, Buffer>()

function rememberManifest(digest: string, manifest: Buffer | undefined): string {
  if (manifest && !manifestDigests.has(digest)) {
    const oldest = manifestDigests.keys().next().value
    if (manifestDigests.size >= KNOWN_TREE_LIMIT && oldest !== undefined) manifestDigests.delete(oldest)
    manifestDigests.set(digest, manifest)
  }
  return digest
}

/** Compare the inspected manifest to the exact leaf observed when the verifier hashed this tree. */
export function isVerifiedPackageManifest(
  directory: string,
  treeIntegrity: string,
  manifest: Buffer,
): boolean {
  let observed = manifestDigests.get(treeIntegrity)
  if (!observed) {
    // A runtime read can reuse a settled tree digest after its leaf proof has been evicted.
    if (hashDirectory(directory, { exclude: [] }) !== treeIntegrity) return false
    observed = manifestDigests.get(treeIntegrity)
  }
  return observed?.equals(leafHash('package.json').update(manifest).digest()) === true
}

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
    ? rememberManifest(known.digest, known.manifest)
    : undefined
}

function rememberDigest(
  key: string,
  root: Readonly<{ dev: number; ino: number }>,
  signature: string,
  digest: string,
  started: number,
  mtimes: Iterable<number>,
  manifest: Buffer | undefined,
): void {
  for (const mtime of mtimes) if (mtime > started - RECENT_WRITE_MS) return
  knownTrees.delete(key)
  const oldest = knownTrees.keys().next().value
  if (knownTrees.size >= KNOWN_TREE_LIMIT && oldest !== undefined) knownTrees.delete(oldest)
  knownTrees.set(key, { dev: root.dev, ino: root.ino, signature, digest, ...(manifest ? { manifest } : {}) })
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
  let manifest: Buffer | undefined
  for (const { rel, file, stat } of files) {
    checkCancelled(opts.signal)
    let actual: string
    try {
      actual = nativeRealpathSync(file)
    } catch {
      throw sourceError('package file changed while hashing', 'tree-changed')
    }
    if (!contained(root, actual)) throw sourceError('package file escapes its source tree', 'path-escape')
    const inner = leafHash(rel).update(readFileSync(file)).digest()
    if (rel === 'package.json') manifest = inner
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
      manifest,
    )
  return rememberManifest(digest, manifest)
}

type DigestOptions = {
  exclude?: string[]
  signal?: AbortSignal
  verifyFiles?: ReadonlyMap<string, Uint8Array>
}
type LeafCapture = {
  root: Stats
  paths: ReadonlySet<string>
  maxBytes: number
  bytes: Map<string, Buffer>
}
type LeafVerification = {
  remaining: Map<string, Buffer>
  capture?: LeafCapture
}

function leafHash(path: string) {
  return createHash('sha256').update(path).update('\0')
}

/** A single uncached traversal. Captures are inaccessible to the caller if verification fails. */
export async function captureDirectoryLeaves(
  root: string,
  options: {
    observedRoot: Stats
    manifest: Buffer
    paths: ReadonlySet<string>
    maxBytes: number
    signal?: AbortSignal
  },
): Promise<{ digest: string; bytes: ReadonlyMap<string, Buffer> }> {
  const capture: LeafCapture = {
    root: options.observedRoot,
    paths: options.paths,
    maxBytes: options.maxBytes,
    bytes: new Map(),
  }
  const digest = await hashDirectoryOnce(
    root,
    { exclude: [], ...(options.signal ? { signal: options.signal } : {}) },
    {
      remaining: new Map([['package.json', leafHash('package.json').update(options.manifest).digest()]]),
      capture,
    },
  )
  return { digest, bytes: capture.bytes }
}

export async function readBoundedPackageManifest(
  root: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  checkCancelled(signal)
  const file = join(root, 'package.json')
  const observed = await asyncFs.lstat(file)
  if (!observed.isFile() || observed.size < 1 || observed.size > maxBytes)
    throw sourceError('package file is unavailable or too large', 'file-size')
  return withObservedFile(root, file, observed, true, async (handle) =>
    readBoundedBytes(handle, observed.size, new Uint8Array(1), signal),
  )
}

async function readBoundedBytes(
  handle: asyncFs.FileHandle,
  size: number,
  scratch: Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    checkCancelled(signal)
    const { bytesRead } = await handle.read(bytes, offset, Math.min(size - offset, 256 * 1024))
    if (!bytesRead) throw sourceError('package file changed while hashing', 'tree-changed')
    offset += bytesRead
  }
  checkCancelled(signal)
  if ((await handle.read(scratch, 0, 1)).bytesRead)
    throw sourceError('package file changed while hashing', 'tree-changed')
  return bytes
}

async function withObservedFile<T>(
  root: string,
  file: string,
  observed: Stats,
  exactPath: boolean,
  read: (handle: asyncFs.FileHandle) => Promise<T>,
): Promise<T> {
  const actual = await asyncFs.realpath(file)
  if (exactPath ? actual !== file : !contained(root, actual))
    throw sourceError('package file escapes its source tree', 'path-escape')
  const handle = await asyncFs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || !sameFileObservation(before, observed))
      throw sourceError('package file changed while hashing', 'tree-changed')
    const result = await read(handle)
    const after = await handle.stat()
    const linked = await asyncFs.lstat(file)
    if (!linked.isFile() || !sameFileObservation(after, before) || !sameFileObservation(linked, before))
      throw sourceError('package file changed while hashing', 'tree-changed')
    return result
  } finally {
    await handle.close()
  }
}

/** Same wire digest and exclusions as hashDirectory; yields for filesystem IO and streams file bytes. */
export async function hashDirectoryAsync(dir: string, opts: DigestOptions = {}): Promise<string> {
  if (opts.verifyFiles) {
    const remaining = new Map<string, Buffer>()
    for (const [path, bytes] of opts.verifyFiles) {
      checkCancelled(opts.signal)
      remaining.set(path, leafHash(path).update(bytes).digest())
    }
    return hashDirectoryOnce(dir, opts, { remaining })
  }
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
  opts: DigestOptions,
  verification?: LeafVerification,
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
  const capture = verification?.capture
  if (capture && (root !== dir || !sameFileObservation(rootStat, capture.root)))
    throw sourceError('package directory changed while hashing', 'tree-changed')
  const directories = verification ? new Map([[root, rootStat]]) : undefined
  const rules = normalizedExcludes(opts.exclude ?? [...DEFAULT_EXCLUDES])
  const files: { rel: string; file: string; observed: Stats }[] = []
  // Reuse the bounded metadata pool for sibling directories too. Nested entry checks stay
  // bounded (four directories, four checks each); file handles/scratch memory are unchanged.
  await walkFileChecks([root], async (current) => {
    const next: string[] = []
    checkCancelled(opts.signal)
    if (directories) await verifyDirectory(current, directories.get(current))
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
      if (stat.isDirectory()) {
        directories?.set(file, stat)
        next.push(file)
      } else if (stat.isFile()) files.push({ rel, file, observed: stat })
      else throw sourceError('package tree contains a special entry', 'special-entry')
    }
    return next
  })
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const cache = verification
    ? undefined
    : {
        key: treeKey(root, rules),
        signature: treeSignature(files.map(({ rel, observed }) => ({ rel, stat: observed }))),
      }
  if (cache) {
    const known = knownDigest(cache.key, rootStat, cache.signature)
    if (known !== undefined) return known
  }
  const hashFile = async ({ rel, file, observed }: (typeof files)[number], chunk: Uint8Array) => {
    checkCancelled(opts.signal)
    return withObservedFile(root, file, observed, verification !== undefined, async (handle) => {
      const inner = leafHash(rel)
      if (capture?.paths.has(rel) && observed.size > 0 && observed.size <= capture.maxBytes) {
        const bytes = await readBoundedBytes(handle, observed.size, chunk, opts.signal)
        inner.update(bytes)
        capture.bytes.set(rel, bytes)
      } else {
        for (;;) {
          checkCancelled(opts.signal)
          const { bytesRead } = await handle.read(chunk)
          if (!bytesRead) break
          inner.update(chunk.subarray(0, bytesRead))
        }
      }
      const digest = inner.digest()
      if (verification) {
        const expected = verification.remaining.get(rel)
        if (expected) {
          if (!digest.equals(expected))
            throw sourceError('package file differs from observed bytes', 'tree-changed')
          verification.remaining.delete(rel)
        }
      }
      return digest
    })
  }
  const digests = await hashFileReads(files, hashFile)
  if (verification?.remaining.size)
    throw sourceError('package file differs from observed bytes', 'tree-changed')
  // A previously closed file can change while a later file yields. Recheck the entire observation,
  // including ctime: same-size writes with a restored mtime must still refuse this traversal.
  await mapFileChecks(files, async ({ file, observed }) => {
    checkCancelled(opts.signal)
    const current = await asyncFs.lstat(file)
    const actual = await asyncFs.realpath(file)
    if (
      !current.isFile() ||
      !sameFileObservation(current, observed) ||
      (verification ? actual !== file : !contained(root, actual))
    )
      throw sourceError('package file changed while hashing', 'tree-changed')
  })
  if (directories)
    await mapFileChecks([...directories], async ([directory, observed]) => {
      checkCancelled(opts.signal)
      await verifyDirectory(directory, observed)
    })
  const finalRoot = await asyncFs.lstat(dir)
  if (
    finalRoot.isSymbolicLink() ||
    finalRoot.ino !== rootStat.ino ||
    finalRoot.dev !== rootStat.dev ||
    (verification && !sameFileObservation(finalRoot, rootStat)) ||
    (await asyncFs.realpath(dir)) !== root
  )
    throw sourceError('package directory changed while hashing', 'tree-changed')
  checkCancelled(opts.signal)
  const outer = createHash('sha256')
  let manifest: Buffer | undefined
  let index = 0
  for (const digest of digests) {
    outer.update(digest)
    if (files[index++]?.rel === 'package.json') manifest = digest
  }
  const digest = `sha256-${outer.digest('hex')}`
  if (cache)
    rememberDigest(
      cache.key,
      rootStat,
      cache.signature,
      digest,
      started,
      files.map(({ observed }) => observed.mtimeMs),
      manifest,
    )
  return rememberManifest(digest, manifest)
}

async function verifyDirectory(directory: string, observed: Stats | undefined): Promise<void> {
  const current = await asyncFs.lstat(directory)
  if (
    !observed ||
    !current.isDirectory() ||
    !sameFileObservation(current, observed) ||
    (await asyncFs.realpath(directory)) !== directory
  )
    throw sourceError('package directory changed while hashing', 'tree-changed')
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
