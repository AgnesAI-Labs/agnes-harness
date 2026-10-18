import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync } from 'node:fs'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { canonical } from './integrity.js'
import { hashDirectory } from './sources.js'

/** Only file verification is shared. Trust, policy, binding and consent are always read again. */
type VerificationOperation = { digests: Map<string, string>; active: boolean }
const operations = new AsyncLocalStorage<VerificationOperation | undefined>()

/** Explicit read/admission boundary. Nested readers join it; nothing survives its completion. */
export async function withPackageVerification<T>(read: () => Promise<T>): Promise<T> {
  if (operations.getStore()?.active) return read()
  const operation: VerificationOperation = { digests: new Map(), active: true }
  return operations.run(operation, async () => {
    try {
      return await read()
    } finally {
      operation.active = false
      operation.digests.clear()
    }
  })
}

/** Writers and pre-use/copy/execute/publish gates must never consume an earlier read's result. */
export function withoutPackageVerification<T>(action: () => T): T
export function withoutPackageVerification(action: () => unknown): unknown {
  const parent = operations.getStore()
  parent?.digests.clear()
  try {
    const result = operations.run(undefined, action)
    if (result instanceof Promise) return result.finally(() => parent?.digests.clear())
    return result
  } finally {
    parent?.digests.clear()
  }
}

/** A retry or recovery mutation invalidates every earlier file observation in this operation. */
export function invalidatePackageVerification(): void {
  operations.getStore()?.digests.clear()
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
  // Let the ordinary validator preserve its refusal for missing, non-directory or linked roots.
  let canonicalDirectory: string | undefined
  try {
    const root = lstatSync(directory)
    if (root.isDirectory() && !root.isSymbolicLink()) canonicalDirectory = nativeRealpathSync(directory)
  } catch {
    return hash()
  }
  if (canonicalDirectory === undefined) return hash()
  const key = canonical({
    directory: canonicalDirectory,
    identity: {
      version: identity.version,
      integrity: identity.integrity,
      treeIntegrity: identity.treeIntegrity,
      capabilityHash: identity.capabilityHash,
    },
    publish,
  })
  const prior = operation.digests.get(key)
  if (prior !== undefined) return prior
  const digest = hash()
  if (digest === expected) operation.digests.set(key, digest)
  return digest
}
