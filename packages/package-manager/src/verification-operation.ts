import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync } from 'node:fs'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { canonical } from './integrity.js'
import { hashDirectory, hashDirectoryAsync } from './sources.js'

/** Only file verification is shared. Trust, policy, binding and consent are always read again. */
type VerificationOperation = {
  digests: Map<string, string>
  pending: Map<string, Promise<string>>
  epoch: number
  active: boolean
  /** This read accepts settled trees (see settledTrees); every other read hashes them again. */
  settleTrees: boolean
}
const operations = new AsyncLocalStorage<VerificationOperation | undefined>()

/**
 * For a read that opts in, trees AGH stores itself (installed packages, runtime snapshots, shipped
 * builtins) are hashed in full once per process. Later opted-in reads reuse that digest while the
 * canonical directory, the exact expected identity and the root's inode are unchanged: installs,
 * updates and snapshot writes replace whole directories, so a replaced tree is hashed again. An
 * in-place edit is not seen by these reads until the process restarts; ordinary reads still see it.
 * Editable workspace/local sources never settle.
 */
type SettledTree = Readonly<{ dev: number; ino: number; digest: string }>
const settledTrees = new Map<string, SettledTree>()
const SETTLED_TREE_LIMIT = 512

function rootInode(directory: string): Readonly<{ dev: number; ino: number }> | undefined {
  try {
    const root = lstatSync(directory)
    return { dev: root.dev, ino: root.ino }
  } catch {
    return undefined
  }
}

function settledDigest(directory: string, key: string): string | undefined {
  const known = settledTrees.get(key)
  if (!known) return undefined
  const root = rootInode(directory)
  if (root?.dev === known.dev && root.ino === known.ino) return known.digest
  settledTrees.delete(key)
  return undefined
}

/** Records a digest only when the root was not replaced while it was being hashed. */
function settleTree(
  directory: string,
  key: string,
  before: Readonly<{ dev: number; ino: number }> | undefined,
  digest: string,
): void {
  const after = rootInode(directory)
  if (!before || after?.dev !== before.dev || after.ino !== before.ino) return
  const oldest = settledTrees.keys().next().value
  if (settledTrees.size >= SETTLED_TREE_LIMIT && oldest !== undefined) settledTrees.delete(oldest)
  settledTrees.set(key, { ...before, digest })
}

/**
 * Explicit read/admission boundary. Nested readers join it; nothing survives its completion except,
 * for a read that passes `settleTrees`, the settled digests of AGH-stored trees.
 */
export async function withPackageVerification<T>(
  read: () => Promise<T>,
  options: Readonly<{ settleTrees?: boolean }> = {},
): Promise<T> {
  if (operations.getStore()?.active) return read()
  const operation: VerificationOperation = {
    digests: new Map(),
    pending: new Map(),
    epoch: 0,
    active: true,
    settleTrees: options.settleTrees === true,
  }
  return operations.run(operation, async () => {
    try {
      return await read()
    } finally {
      operation.active = false
      invalidate(operation)
    }
  })
}

/** Writers and pre-use/copy/execute/publish gates must never consume an earlier read's result. */
export function withoutPackageVerification<T>(action: () => T): T
export function withoutPackageVerification(action: () => unknown): unknown {
  const parent = operations.getStore()
  invalidate(parent)
  try {
    const result = operations.run(undefined, action)
    if (result instanceof Promise) return result.finally(() => invalidate(parent))
    return result
  } finally {
    invalidate(parent)
  }
}

/** A retry or recovery mutation invalidates every earlier file observation, settled trees included. */
export function invalidatePackageVerification(): void {
  invalidate(operations.getStore())
  settledTrees.clear()
}

function invalidate(operation: VerificationOperation | undefined): void {
  if (!operation) return
  operation.epoch++
  operation.digests.clear()
  operation.pending.clear()
}

/** Exact expected identity plus canonical directory and digest formula, never mtime/size. Failures
 * are not memoized. Resolve and reject a link on every access, including a memo hit (retargeting).
 * This synchronous seam is intentionally separate from hashDirectory for read-only async callers. */
export function verifiedDirectoryDigest(
  directory: string,
  identity: Readonly<{
    version: string
    integrity: string
    treeIntegrity?: string | undefined
    capabilityHash: string
  }>,
  publish = false,
  /** The tree is AGH-stored (see settledTrees); an opted-in read may reuse its settled digest. */
  storedTree = false,
): string {
  const operation = operations.getStore()
  const expected = publish ? identity.integrity : identity.treeIntegrity
  const hash = () => hashDirectory(directory, publish ? {} : { exclude: [] })
  if (!operation?.active || expected === undefined) return hash()
  const settled = storedTree && operation.settleTrees
  const key = directoryKey(directory, identity, publish)
  if (key === undefined) return hash()
  const prior = operation.digests.get(key)
  if (prior !== undefined) return prior
  const known = settled ? settledDigest(directory, key) : undefined
  if (known !== undefined) {
    operation.digests.set(key, known)
    return known
  }
  const before = settled ? rootInode(directory) : undefined
  const digest = hash()
  if (digest === expected) {
    operation.digests.set(key, digest)
    if (settled) settleTree(directory, key, before, digest)
  }
  return digest
}

type DirectoryIdentity = Parameters<typeof verifiedDirectoryDigest>[1]
function directoryKey(directory: string, identity: DirectoryIdentity, publish: boolean): string | undefined {
  // Let the ordinary validator preserve its refusal for missing, non-directory or linked roots.
  let canonicalDirectory: string | undefined
  try {
    const root = lstatSync(directory)
    if (root.isDirectory() && !root.isSymbolicLink()) canonicalDirectory = nativeRealpathSync(directory)
  } catch {
    return undefined
  }
  if (canonicalDirectory === undefined) return undefined
  return canonical({
    directory: canonicalDirectory,
    identity: {
      version: identity.version,
      integrity: identity.integrity,
      treeIntegrity: identity.treeIntegrity,
      capabilityHash: identity.capabilityHash,
    },
    publish,
  })
}

/** Read-only counterpart. Pending work is scoped to this exact operation and invalidation epoch. */
export async function verifiedDirectoryDigestAsync(
  directory: string,
  identity: DirectoryIdentity,
  publish = false,
  storedTree = false,
): Promise<string> {
  const operation = operations.getStore()
  const expected = publish ? identity.integrity : identity.treeIntegrity
  const hash = () => hashDirectoryAsync(directory, publish ? {} : { exclude: [] })
  if (!operation?.active || expected === undefined) return hash()
  const settled = storedTree && operation.settleTrees
  // These cheap checks deliberately run before every memo/pending hit, without yielding.
  const key = directoryKey(directory, identity, publish)
  if (key === undefined) return hash()
  const prior = operation.digests.get(key)
  if (prior !== undefined) return prior
  const known = settled ? settledDigest(directory, key) : undefined
  if (known !== undefined) {
    operation.digests.set(key, known)
    return known
  }
  const pending = operation.pending.get(key)
  if (pending) return pending
  const epoch = operation.epoch
  const before = settled ? rootInode(directory) : undefined
  const result = hash()
    .then((digest) => {
      if (
        operation.active &&
        operation.epoch === epoch &&
        digest === expected &&
        directoryKey(directory, identity, publish) === key
      ) {
        operation.digests.set(key, digest)
        if (settled) settleTree(directory, key, before, digest)
      }
      return digest
    })
    .finally(() => {
      if (operation.pending.get(key) === result) operation.pending.delete(key)
    })
  operation.pending.set(key, result)
  return result
}
