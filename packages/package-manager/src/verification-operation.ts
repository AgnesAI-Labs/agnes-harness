import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync } from 'node:fs'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { withoutByteVerification } from './byte-verification.js'
import { canonical } from './integrity.js'
import { hashDirectory, hashDirectoryAsync } from './sources.js'

/** Only file verification is shared. Trust, policy, binding and consent are always read again. */
type VerificationOperation = {
  digests: Map<string, string>
  pending: Map<string, Promise<string>>
  epoch: number
  active: boolean
}
const operations = new AsyncLocalStorage<VerificationOperation | undefined>()

/** Explicit read/admission boundary. Nested readers join it; nothing survives its completion. */
export async function withPackageVerification<T>(read: () => Promise<T>): Promise<T> {
  if (operations.getStore()?.active) return read()
  const operation: VerificationOperation = { digests: new Map(), pending: new Map(), epoch: 0, active: true }
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
    const result = withoutByteVerification(() => operations.run(undefined, action))
    if (result instanceof Promise) return result.finally(() => invalidate(parent))
    return result
  } finally {
    invalidate(parent)
  }
}

/** A retry or recovery mutation invalidates every earlier file observation in this operation. */
export function invalidatePackageVerification(): void {
  invalidate(operations.getStore())
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
): string {
  const operation = operations.getStore()
  const expected = publish ? identity.integrity : identity.treeIntegrity
  const hash = () => hashDirectory(directory, publish ? {} : { exclude: [] })
  if (!operation?.active || expected === undefined) return hash()
  const key = directoryKey(directory, identity, publish)
  if (key === undefined) return hash()
  const prior = operation.digests.get(key)
  if (prior !== undefined) return prior
  const digest = hash()
  if (digest === expected) operation.digests.set(key, digest)
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
): Promise<string> {
  const operation = operations.getStore()
  const expected = publish ? identity.integrity : identity.treeIntegrity
  const hash = () => hashDirectoryAsync(directory, publish ? {} : { exclude: [] })
  if (!operation?.active || expected === undefined) return hash()
  // These cheap checks deliberately run before every memo/pending hit, without yielding.
  const key = directoryKey(directory, identity, publish)
  if (key === undefined) return hash()
  const prior = operation.digests.get(key)
  if (prior !== undefined) return prior
  const pending = operation.pending.get(key)
  if (pending) return pending
  const epoch = operation.epoch
  const result = hash()
    .then((digest) => {
      if (
        operation.active &&
        operation.epoch === epoch &&
        digest === expected &&
        directoryKey(directory, identity, publish) === key
      )
        operation.digests.set(key, digest)
      return digest
    })
    .finally(() => {
      if (operation.pending.get(key) === result) operation.pending.delete(key)
    })
  operation.pending.set(key, result)
  return result
}
