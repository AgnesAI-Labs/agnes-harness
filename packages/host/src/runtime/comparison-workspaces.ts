import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceBaseline, WorkspaceSnapshotPort } from '@agnes/runtime-comparison'
import {
  type ComparisonExternalReference,
  captureLink,
  externalReference,
  WorkspaceLinkError,
} from './comparison-workspace-links.js'

export interface ComparisonWorkspaceOptions {
  /** Host-owned private storage, outside every source workspace. */
  directory: string
  /** Existing Host read authorization; rejection aborts the entire snapshot. */
  authorizeRead: (canonicalPath: string) => Promise<void>
  /** Explicit authorization for canonical external regular-file dependencies. Never grants writes. */
  authorizeExternalRead?: (canonicalPath: string) => Promise<void>
  maxFiles?: number
  maxEntries?: number
  maxBytes?: number
  maxDepth?: number
  /** Basenames excluded at every depth. .git is always excluded; dependencies and untracked files are retained. */
  excludeNames?: readonly string[]
}
export class ComparisonWorkspaceError extends Error {
  constructor(readonly code: string) {
    super(`Comparison workspace preparation failed (${code})`)
    this.name = 'ComparisonWorkspaceError'
  }
}
type Entry = {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  target?: string
  externalTarget?: string
  mode: number
  identity: string
  size?: number
  digest?: string
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
const identity = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':')
function failure(code: string): never {
  throw new ComparisonWorkspaceError(code)
}

/** Resolve existing ancestors without creating anything, so overlap checks precede all writes. */
async function destinationPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await destinationPath(parent), relative(parent, path))
  }
}
/** After confirmed worker exit, restore directory traversal/unlink rights without following lane-created links. */
async function removeSnapshot(path: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const name of await readdir(directory)) await visit(join(directory, name))
  }
  try {
    await visit(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await rm(path, { recursive: true, force: true })
}
function bounded(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) failure('INVALID_LIMIT')
  return result
}
async function checkedStat(
  path: string,
  source: string,
  authorize: ComparisonWorkspaceOptions['authorizeRead'],
): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) failure('SPECIAL_FILE_UNSUPPORTED')
  const canonical = stat.isSymbolicLink()
    ? join(await realpath(dirname(path)), relative(dirname(path), path))
    : await realpath(path)
  if (canonical !== path || !inside(source, canonical)) failure('SOURCE_CHANGED')
  try {
    // Reading the link itself requires its containing directory, not permission to follow it.
    // External file contents have their own explicit authorization below.
    await authorize(stat.isSymbolicLink() ? dirname(canonical) : canonical)
  } catch {
    failure('READ_DENIED')
  }
  return stat
}
async function captureFile(
  source: string,
  target: string,
  expected: BigIntStats,
  remaining: number,
): Promise<string> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (identity(await input.stat({ bigint: true })) !== identity(expected)) failure('SOURCE_CHANGED')
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    const digest = createHash('sha256')
    let bytes = 0
    try {
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, null)
        if (bytesRead === 0) break
        bytes += bytesRead
        if (bytes > remaining || bytes > Number(expected.size)) failure('SOURCE_CHANGED')
        const chunk = buffer.subarray(0, bytesRead)
        digest.update(chunk)
        let written = 0
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written)
          if (result.bytesWritten === 0) failure('COPY_FAILED')
          written += result.bytesWritten
        }
      }
      if (
        bytes !== Number(expected.size) ||
        identity(await input.stat({ bigint: true })) !== identity(expected)
      )
        failure('SOURCE_CHANGED')
      await output.sync()
    } finally {
      await output.close()
    }
    return digest.digest('hex')
  } finally {
    await input.close()
  }
}
async function materialize(baseline: string, root: string, entries: readonly Entry[]): Promise<void> {
  await mkdir(root, { mode: 0o700 })
  for (const entry of entries) {
    if (entry.path === '') continue
    const target = join(root, entry.path)
    if (entry.kind === 'directory') await mkdir(target, { mode: 0o700 })
    else if (entry.kind === 'file') {
      await copyFile(join(baseline, entry.path), target, constants.COPYFILE_EXCL)
      await chmod(target, entry.mode)
    }
  }
  for (const entry of entries)
    if (entry.kind === 'symlink' && entry.target !== undefined)
      await symlink(entry.target, join(root, entry.path))
  // Populate first, then restore source directory access modes without setuid/setgid bits.
  for (const entry of [...entries].reverse())
    if (entry.path !== '' && entry.kind === 'directory') await chmod(join(root, entry.path), entry.mode)
}

/**
 * Freeze dirty and untracked working-tree bytes once, then copy only that private baseline.
 * No Git invocation, hardlink or fallback to shared cwd is permitted. Internal links stay
 * within each copy; explicitly authorized external regular files retain canonical links and receipts.
 * Source identity is checked before/after reads and in a second full metadata walk. This detects
 * ordinary concurrent edits; it is not an OS-atomic filesystem snapshot against hostile path swaps.
 */
export function createComparisonWorkspaces(options: ComparisonWorkspaceOptions): WorkspaceSnapshotPort {
  if (
    !isAbsolute(options.directory) ||
    options.directory.includes('\0') ||
    typeof options.authorizeRead !== 'function'
  )
    failure('INVALID_CONFIGURATION')
  const policy = Object.freeze({
    version: 2,
    maxFiles: bounded(options.maxFiles, 10_000),
    maxEntries: bounded(options.maxEntries, 20_000),
    maxBytes: bounded(options.maxBytes, 256 * 1024 * 1024),
    maxDepth: bounded(options.maxDepth, 64),
    excludeNames: [...new Set(['.git', ...(options.excludeNames ?? [])])].sort(),
    symlinks: 'internal-relative-external-verified-regular',
    specialFiles: 'reject',
    fileCopies: 'independent',
    modeBits: '0777',
  })
  if (
    policy.excludeNames.some(
      (name) => !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'),
    )
  )
    failure('INVALID_CONFIGURATION')
  const policyHash = hash(JSON.stringify(policy))
  const excluded = new Set(policy.excludeNames)
  const directory = resolve(options.directory)
  const authorize = options.authorizeRead
  let storage: Promise<string> | undefined
  const storagePath = () => (storage ??= destinationPath(directory))
  const key = (id: string) => {
    if (!id) failure('INVALID_ID')
    return hash(id)
  }
  return {
    async prepare({ comparisonId, cwd }): Promise<WorkspaceBaseline> {
      try {
        if (!isAbsolute(cwd) || cwd.includes('\0')) failure('INVALID_SOURCE')
        const source = await realpath(cwd)
        const destination = await storagePath()
        if (inside(source, destination) || inside(destination, source)) failure('WORKSPACE_OVERLAP')
        const rootStat = await checkedStat(source, source, authorize)
        if (!rootStat.isDirectory()) failure('INVALID_SOURCE')
        await mkdir(destination, { recursive: true, mode: 0o700 })
        const storageStat = await lstat(destination)
        if (
          !storageStat.isDirectory() ||
          storageStat.isSymbolicLink() ||
          (await realpath(destination)) !== destination
        )
          failure('INVALID_STORAGE')
        const target = join(destination, key(comparisonId))
        // Exclusive reservation is outside catch: a losing duplicate must never remove the winner's workspace.
        try {
          await mkdir(target, { mode: 0o700 })
        } catch {
          failure('SNAPSHOT_EXISTS')
        }
        try {
          const baseline = join(target, 'baseline')
          await mkdir(baseline, { mode: 0o700 })
          const entries: Entry[] = []
          const externalReferences: ComparisonExternalReference[] = []
          const externalTargets = new Map<string, ComparisonExternalReference>()
          let bytes = 0
          let files = 0
          const walk = async (
            path: string,
            depth: number,
            capture: boolean,
            seen: Entry[],
          ): Promise<void> => {
            if (depth > policy.maxDepth || seen.length >= policy.maxEntries) failure('SNAPSHOT_LIMIT')
            const actual = path === '' ? source : join(source, path)
            const stat = await checkedStat(actual, source, authorize)
            const mode = Number(stat.mode & 0o777n)
            const entry: Entry = {
              path,
              kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
              mode,
              identity: identity(stat),
            }
            seen.push(entry)
            if (stat.isSymbolicLink()) {
              const link = await captureLink(source, path, excluded)
              Object.assign(entry, link)
              if (capture) {
                if (++files > policy.maxFiles) failure('SNAPSHOT_LIMIT')
                if (link.externalTarget !== undefined) {
                  if (inside(destination, link.externalTarget)) failure('EXTERNAL_REFERENCE_DENIED')
                  await authorizeExternal(options, link.externalTarget)
                  let reference = externalTargets.get(link.externalTarget)
                  if (!reference) {
                    reference = await externalReference(path, link.externalTarget, policy.maxBytes - bytes)
                    externalTargets.set(link.externalTarget, reference)
                    bytes += reference.size
                  }
                  externalReferences.push({ ...reference, path })
                }
              }
              if (identity(await lstat(actual, { bigint: true })) !== entry.identity)
                failure('SOURCE_CHANGED')
            } else if (stat.isDirectory()) {
              if (capture && path !== '') await mkdir(join(baseline, path), { mode: 0o700 })
              const names = (await readdir(actual)).filter((name) => !excluded.has(name)).sort()
              for (const name of names)
                await walk(path === '' ? name : join(path, name), depth + 1, capture, seen)
              if (identity(await lstat(actual, { bigint: true })) !== entry.identity)
                failure('SOURCE_CHANGED')
            } else {
              if (stat.size > BigInt(policy.maxBytes)) failure('SNAPSHOT_LIMIT')
              entry.size = Number(stat.size)
              if (capture) {
                if (++files > policy.maxFiles || bytes + entry.size > policy.maxBytes)
                  failure('SNAPSHOT_LIMIT')
                entry.digest = await captureFile(actual, join(baseline, path), stat, policy.maxBytes - bytes)
                bytes += entry.size
                await chmod(join(baseline, path), 0o400 | (mode & 0o111))
              }
            }
          }
          await walk('', 0, true, entries)
          const verified: Entry[] = []
          await walk('', 0, false, verified)
          if (
            JSON.stringify(entries.map(({ digest: _digest, ...entry }) => entry)) !== JSON.stringify(verified)
          )
            failure('SOURCE_CHANGED')
          const digest = snapshotDigest(entries, externalReferences)
          const roots = { left: join(target, 'left'), right: join(target, 'right') }
          const copies = await Promise.allSettled([
            materialize(baseline, roots.left, entries),
            materialize(baseline, roots.right, entries),
          ])
          if (copies.some((result) => result.status === 'rejected')) failure('COPY_FAILED')
          const manifest = await open(join(target, 'manifest.json'), 'wx', 0o600)
          try {
            await manifest.writeFile(
              JSON.stringify({ version: 2, source, digest, policyHash, policy, entries, externalReferences }),
            )
            await manifest.sync()
          } finally {
            await manifest.close()
          }
          await verifyComparisonWorkspaceReferences(options, comparisonId)
          return {
            id: `snapshot-${key(comparisonId)}`,
            digest,
            policyHash,
            roots,
            labels: { left: 'Left isolated workspace', right: 'Right isolated workspace' },
          }
        } catch (error) {
          try {
            await removeSnapshot(target)
          } catch {
            failure('CLEANUP_FAILED')
          }
          if (error instanceof WorkspaceLinkError) failure(error.code)
          if (error instanceof ComparisonWorkspaceError) throw error
          return failure('SNAPSHOT_FAILED')
        }
      } catch (error) {
        if (error instanceof ComparisonWorkspaceError) throw error
        return failure('SNAPSHOT_FAILED')
      }
    },
    async release(comparisonId): Promise<void> {
      const root = await storagePath()
      const target = join(root, key(comparisonId))
      try {
        const parent = await lstat(root)
        if (!parent.isDirectory() || parent.isSymbolicLink() || (await realpath(root)) !== root)
          failure('INVALID_STORAGE')
        const stat = await lstat(target)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)) !== target)
          failure('INVALID_STORAGE')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      await removeSnapshot(target)
    },
  }
}

async function authorizeExternal(
  options: Pick<ComparisonWorkspaceOptions, 'authorizeExternalRead'>,
  target: string,
): Promise<void> {
  if (!options.authorizeExternalRead) failure('EXTERNAL_REFERENCE_DENIED')
  try {
    await options.authorizeExternalRead(target)
  } catch {
    failure('EXTERNAL_REFERENCE_DENIED')
  }
}
function snapshotDigest(
  entries: readonly Entry[],
  references: readonly ComparisonExternalReference[],
): string {
  return hash(
    JSON.stringify({
      entries: entries.map(({ identity: _identity, ...entry }) => entry),
      externalReferences: references,
    }),
  )
}

/** Revalidate external dependencies before admission and after execution. Does not widen lane permissions. */
export async function verifyComparisonWorkspaceReferences(
  options: Pick<ComparisonWorkspaceOptions, 'directory' | 'authorizeExternalRead'>,
  comparisonId: string,
  expected?: Pick<WorkspaceBaseline, 'digest' | 'policyHash'>,
): Promise<string[]> {
  if (!comparisonId || !isAbsolute(options.directory)) failure('INVALID_CONFIGURATION')
  try {
    const storage = await lstat(options.directory)
    if (!storage.isDirectory() || storage.isSymbolicLink()) failure('INVALID_STORAGE')
    const directory = await realpath(options.directory)
    const root = join(directory, hash(comparisonId))
    if ((await realpath(root)) !== root) failure('INVALID_STORAGE')
    const path = join(root, 'manifest.json')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let manifest: unknown
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size > 32n * 1024n * 1024n) failure('MANIFEST_INVALID')
      manifest = JSON.parse(await handle.readFile('utf8')) as unknown
      if (
        identity(before) !== identity(await handle.stat({ bigint: true })) ||
        identity(before) !== identity(await lstat(path, { bigint: true }))
      )
        failure('MANIFEST_INVALID')
    } finally {
      await handle.close()
    }
    if (!manifest || typeof manifest !== 'object') failure('MANIFEST_INVALID')
    const value = manifest as Record<string, unknown>
    if (!Array.isArray(value.entries) || typeof value.digest !== 'string') failure('MANIFEST_INVALID')
    if (expected && (value.digest !== expected.digest || value.policyHash !== expected.policyHash))
      failure('MANIFEST_INVALID')
    // Version 1 admitted no symlinks, so it has no external reference lifecycle.
    if (value.version === 1) {
      if (
        value.entries.some((entry: Entry) => entry.kind !== 'file' && entry.kind !== 'directory') ||
        hash(JSON.stringify(value.entries.map(({ identity: _identity, ...entry }: Entry) => entry))) !==
          value.digest
      )
        failure('MANIFEST_INVALID')
      return []
    }
    if (
      value.version !== 2 ||
      !Array.isArray(value.externalReferences) ||
      typeof value.source !== 'string' ||
      !isAbsolute(value.source) ||
      hash(JSON.stringify(value.policy)) !== value.policyHash
    )
      failure('MANIFEST_INVALID')
    const entries = value.entries as Entry[]
    const refs = value.externalReferences as ComparisonExternalReference[]
    if (snapshotDigest(entries, refs) !== value.digest) failure('MANIFEST_INVALID')
    const targets = new Map<string, ComparisonExternalReference>()
    for (const reference of refs) {
      if (
        !reference ||
        typeof reference.path !== 'string' ||
        typeof reference.target !== 'string' ||
        !isAbsolute(reference.target) ||
        typeof reference.identity !== 'string' ||
        !Number.isSafeInteger(reference.size) ||
        reference.size < 0 ||
        typeof reference.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(reference.digest) ||
        !entries.some(
          (entry) =>
            entry.kind === 'symlink' &&
            entry.path === reference.path &&
            entry.externalTarget === reference.target,
        ) ||
        inside(directory, reference.target) ||
        inside(value.source, reference.target)
      )
        failure('MANIFEST_INVALID')
      const prior = targets.get(reference.target)
      if (
        prior &&
        (prior.identity !== reference.identity ||
          prior.digest !== reference.digest ||
          prior.size !== reference.size)
      )
        failure('MANIFEST_INVALID')
      targets.set(reference.target, reference)
    }
    if (
      entries.some(
        (entry) =>
          entry.kind === 'symlink' &&
          entry.externalTarget !== undefined &&
          !refs.some(
            (reference) => reference.path === entry.path && reference.target === entry.externalTarget,
          ),
      )
    )
      failure('MANIFEST_INVALID')
    for (const reference of targets.values()) {
      await authorizeExternal(options, reference.target)
      try {
        const current = await externalReference(reference.path, reference.target, reference.size)
        if (
          current.identity !== reference.identity ||
          current.digest !== reference.digest ||
          current.size !== reference.size
        )
          failure('EXTERNAL_REFERENCE_CHANGED')
      } catch {
        failure('EXTERNAL_REFERENCE_CHANGED')
      }
    }
    return [...targets.keys()]
  } catch (error) {
    if (error instanceof ComparisonWorkspaceError) throw error
    if (error instanceof WorkspaceLinkError)
      failure(error.code === 'EXTERNAL_REFERENCE_UNSUPPORTED' ? error.code : 'EXTERNAL_REFERENCE_CHANGED')
    return failure('MANIFEST_INVALID')
  }
}
