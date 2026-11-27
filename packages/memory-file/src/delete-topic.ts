import { randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MemorySource } from '@agnes/extension-api'
import { openCanonicalFileSync, syncDirectorySync } from '@agnes/system-node'
import { fault } from './content.js'
import { isMemoryName, missing, safe } from './paths.js'
import type { MemoryStore } from './store.js'

const maxIntentBytes = 64 * 1024
const intentName = 'delete-intent.json'
type MovedTopic = { leaf: string; tombstone: string }
export type DeleteMetadata = {
  baseHash: string
  origin: 'human' | 'agent' | 'host'
  actor: string
  source: MemorySource
  auditSeq?: number
}
type DeleteIntent = MovedTopic & DeleteMetadata & { phase: 'moved' | 'unlinked' }
const pending = new Map<string, MovedTopic>()
export const provisionalTopic = (root: string) => pending.get(root)

export async function retryBusy(action: () => void): Promise<void> {
  const deadline = performance.now() + 1000
  for (;;) {
    try {
      return action()
    } catch (error) {
      if (
        !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ||
        performance.now() >= deadline
      )
        throw error
      await delay(10)
    }
  }
}

export function hasDeleteIntent(root: string): boolean {
  return !!lstatSync(join(root, intentName), { throwIfNoEntry: false })
}

// Retain a reclaimed name and quarantine the tombstone in place. A matching inode means
// recovery already linked it back and was interrupted before removing the temporary name.
function restore(original: string, tombstone: string) {
  try {
    linkSync(tombstone, original)
  } catch (error) {
    if (missing(error)) return
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const from = lstatSync(tombstone, { bigint: true })
    const to = lstatSync(original, { bigint: true })
    if (from.dev !== to.dev || from.ino !== to.ino) return
  }
  unlinkSync(tombstone)
}

function finish(root: string) {
  syncDirectorySync(root)
  rmSync(join(root, intentName), { force: true })
  syncDirectorySync(root)
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const validLeaf = (leaf: unknown): leaf is string =>
  typeof leaf === 'string' && isMemoryName(leaf) && leaf.toLowerCase() !== 'memory.md'

function readIntent(store: MemoryStore): DeleteIntent | MovedTopic | undefined {
  const path = join(store.root, intentName)
  safe(store.protectedRoot, path)
  let fd: number
  try {
    fd = openCanonicalFileSync(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  let raw: string
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxIntentBytes)
      throw fault('MEMORY_INVALID_METADATA')
    raw = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  const data = JSON.parse(raw)
  if (data?.phase === undefined && validLeaf(data?.path) && typeof data.id === 'string' && uuid.test(data.id))
    return { leaf: data.path, tombstone: `${data.path}.${data.id}.del.tmp` }
  const { leaf, tombstone, baseHash, origin, actor, source, phase, auditSeq } = data ?? {}
  if (
    !validLeaf(leaf) ||
    typeof tombstone !== 'string' ||
    !tombstone.startsWith(`${leaf}.`) ||
    !tombstone.endsWith('.del.tmp') ||
    !uuid.test(tombstone.slice(leaf.length + 1, -8)) ||
    typeof baseHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(baseHash) ||
    !['human', 'agent', 'host'].includes(origin) ||
    typeof actor !== 'string' ||
    typeof source?.sessionKey !== 'string' ||
    !Number.isSafeInteger(source.turn) ||
    source.turn < 0 ||
    (source.toolUseId !== undefined && typeof source.toolUseId !== 'string') ||
    (source.maintenance !== undefined && typeof source.maintenance !== 'string') ||
    (auditSeq !== undefined && (!Number.isSafeInteger(auditSeq) || auditSeq < 0)) ||
    (phase !== 'moved' && phase !== 'unlinked')
  )
    throw fault('MEMORY_INVALID_METADATA')
  return { leaf, tombstone, baseHash, origin, actor, source, phase, auditSeq }
}

export function ongoingMove(store: MemoryStore) {
  const intent = readIntent(store)
  return intent && (!('phase' in intent) || intent.phase === 'moved') ? intent : undefined
}

/** Called only with the exclusive store lock. Older intents have no post-unlink metadata. */
export function recoverTopic(store: MemoryStore, purpose: 'read' | 'write' = 'write') {
  const intent = readIntent(store)
  if (!intent) return
  const original = join(store.root, intent.leaf)
  const tombstone = join(store.root, intent.tombstone)
  if (
    !('phase' in intent) ||
    (intent.phase === 'moved' &&
      (lstatSync(tombstone, { throwIfNoEntry: false }) || lstatSync(original, { throwIfNoEntry: false })))
  ) {
    restore(original, tombstone)
  } else {
    try {
      if (intent.phase === 'moved') {
        syncDirectorySync(store.root)
        store.atomic(join(store.root, intentName), JSON.stringify({ ...intent, phase: 'unlinked' }))
      }
      store.reconcileDeletedTopic(intent.leaf, intent)
    } catch (error) {
      // The unlink is committed. Readers can use live files while the journal awaits repair.
      if (purpose === 'read') return
      throw error
    }
  }
  finish(store.root)
}

export async function unlinkTopic(
  store: MemoryStore,
  leaf: string,
  metadata: DeleteMetadata,
  matches: (tombstone: string, identity: BigIntStats) => boolean,
  assertActive: () => void,
  prune: () => void,
): Promise<void> {
  const intent: DeleteIntent = {
    ...metadata,
    leaf,
    tombstone: `${leaf}.${randomUUID()}.del.tmp`,
    phase: 'moved',
  }
  const original = join(store.root, leaf)
  const tombstone = join(store.root, intent.tombstone)
  const journal = join(store.root, intentName)
  const unlinked = JSON.stringify({ ...intent, phase: 'unlinked' })
  if (Buffer.byteLength(unlinked) > maxIntentBytes) throw fault('MEMORY_INVALID_METADATA')
  store.atomic(journal, JSON.stringify(intent))
  const verify = () => {
    assertActive()
    const entry = lstatSync(tombstone, { bigint: true, throwIfNoEntry: false })
    if (!entry?.isFile() || entry.nlink !== 1n || !matches(tombstone, entry)) throw fault('MEMORY_CONFLICT')
    assertActive()
  }
  try {
    await retryBusy(() => {
      assertActive()
      renameSync(original, tombstone)
      pending.set(store.root, intent)
    })
    await retryBusy(() => {
      verify()
      prune()
      verify()
      unlinkSync(tombstone)
      pending.delete(store.root)
    })
  } catch (error) {
    await retryBusy(() => {
      restore(original, tombstone)
      finish(store.root)
    })
    throw error
  } finally {
    pending.delete(store.root)
  }
  try {
    syncDirectorySync(store.root)
    store.atomic(journal, unlinked)
  } catch {
    throw fault('MEMORY_COMMITTED_METADATA_FAILED')
  }
}

export const finishTopicDeletion = (root: string) => retryBusy(() => finish(root))
