import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createPrivateFileSync,
  renameWriteThroughSync,
  windowsEnsurePrivateDirectorySync,
  windowsOpenPrivateFileSync,
  windowsWritePrivateFile,
} from '@agnes/system-node'
import { createPlatform } from './adapters/platform.js'
import {
  computerUseMarkerPath,
  pathEntryExists,
  readComputerUseTombstone,
  serializeComputerUseTombstone,
} from './computer-use-marker.js'

const SHA256 = /^[0-9a-f]{64}$/u
const mutationTails = new Map<string, Promise<void>>()
const MUTATION_LOCK = 'computer-use-artifact-mutation-lock.db'
export const MUTATION_LOCK_TIMEOUT_MS = 30_000

export type PrivateArtifactStore = Readonly<{
  put(sha256: string, bytes: Uint8Array): Promise<void>
  putComputerUseMetadata(sha256: string, bytes: Uint8Array): Promise<void>
}>

/**
 * Serializes screenshot publication with GC for one Host data directory. A new CAS reference is
 * returned before its durable ledger root can be committed, so collection must not pass a writer
 * between classification and byte publication. The in-process queue avoids self-contention and
 * the private SQLite transaction extends the same lock across daemon and local Host processes.
 */
export async function withComputerUseArtifactMutation<T>(
  dataDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = createPlatform().os === 'win32' ? resolve(dataDir).toLowerCase() : resolve(dataDir)
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((done) => {
    release = done
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  mutationTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    const database = await acquireComputerUseArtifactMutationLock(dataDir)
    try {
      try {
        const result = await operation()
        database.exec('COMMIT')
        return result
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // Preserve the operation or commit failure; close still releases the OS lock.
        }
        throw error
      }
    } finally {
      database.close()
    }
  } finally {
    release()
    if (mutationTails.get(key) === tail) mutationTails.delete(key)
  }
}

export function ensurePosixPrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Computer Use private artifact directory is unsafe')
  chmodSync(path, 0o700)
  const handle = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  closeSync(handle)
}

function validatePrivateFile(path: string, label: string): void {
  if (createPlatform().os === 'win32') {
    const handle = windowsOpenPrivateFileSync(path)
    closeSync(handle)
    return
  }
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error(`${label} is unsafe`)
}

/** Opens a Host-private SQLite file below `<dataDir>/artifacts`, creating it privately first. */
export function openPrivateArtifactDatabase(dataDir: string, name: string, label: string): DatabaseSync {
  const directory = join(dataDir, 'artifacts')
  const platform = createPlatform().os
  if (platform === 'win32') windowsEnsurePrivateDirectorySync(directory)
  else if (platform === 'darwin' || platform === 'linux') ensurePosixPrivateDirectory(directory)
  else throw new Error(`${label} is unavailable on this platform`)
  const path = join(directory, name)
  try {
    const handle = createPrivateFileSync(path)
    closeSync(handle)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  validatePrivateFile(path, label)
  return new DatabaseSync(path)
}

/** Takes the write lock without SQLite's blocking busy handler, backing off on the event loop. */
export async function beginImmediateWithBackoff(
  database: DatabaseSync,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  const startedAt = performance.now()
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      const busy = (error as { errcode?: unknown }).errcode
      if (busy !== 5 && busy !== 6) throw error
      if (performance.now() - startedAt >= timeoutMs) throw new Error(timeoutMessage)
      await delay(25)
    }
  }
}

async function acquireComputerUseArtifactMutationLock(dataDir: string): Promise<DatabaseSync> {
  const database = openPrivateArtifactDatabase(dataDir, MUTATION_LOCK, 'Computer Use artifact mutation lock')
  try {
    await beginImmediateWithBackoff(
      database,
      MUTATION_LOCK_TIMEOUT_MS,
      'Computer Use artifact mutation lock timed out',
    )
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function computerUseMetadata(sha256: string, size: number): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ schemaVersion: 1, sha256, size, createdAtMs: Date.now() }, null, 2)}\n`,
  )
}

type PrivatePlatform = 'win32' | 'darwin' | 'linux'

async function writePrivate(
  dataDir: string,
  platform: PrivatePlatform,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  if (platform === 'win32') {
    await windowsWritePrivateFile(target, bytes)
    return
  }
  const shard = dirname(target)
  ensurePosixPrivateDirectory(join(dataDir, 'artifacts'))
  ensurePosixPrivateDirectory(dirname(shard))
  ensurePosixPrivateDirectory(shard)
  const temporary = join(shard, `.${randomUUID()}.tmp`)
  const handle = createPrivateFileSync(temporary)
  let committed = false
  try {
    try {
      writeFileSync(handle, bytes)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameWriteThroughSync(temporary, target)
    committed = true
  } finally {
    if (!committed) rmSync(temporary, { force: true })
  }
}

function ensureMarkerShard(dataDir: string, platform: PrivatePlatform, sha256: string): string {
  const metadataRoot = join(dataDir, 'artifacts', 'computer-use-meta')
  const shard = join(metadataRoot, sha256.slice(0, 2))
  if (platform === 'win32') {
    windowsEnsurePrivateDirectorySync(shard)
  } else {
    ensurePosixPrivateDirectory(join(dataDir, 'artifacts'))
    ensurePosixPrivateDirectory(metadataRoot)
    ensurePosixPrivateDirectory(shard)
  }
  return join(shard, `${sha256}.json`)
}

/**
 * Writes the reclaim tombstone for one screenshot. Only the collector calls this, while it holds
 * the screenshot mutation lock and before it deletes the bytes.
 */
export async function writeComputerUseTombstoneLocked(
  dataDir: string,
  platform: PrivatePlatform,
  marker: Readonly<{ sha256: string; size: number; createdAtMs: number; collectedAtMs: number }>,
): Promise<void> {
  if (!SHA256.test(marker.sha256)) throw new Error('Computer Use private metadata digest is invalid')
  const target = ensureMarkerShard(dataDir, platform, marker.sha256)
  await writePrivate(dataDir, platform, target, serializeComputerUseTombstone(marker))
}

/** Host-only private writer bound to the CU content-addressed store and retention marker tree. */
export function createPrivateArtifactStore(dataDir: string, platform: PrivatePlatform): PrivateArtifactStore {
  const root = join(dataDir, 'artifacts', 'sha256')
  return Object.freeze({
    async put(sha256: string, bytes: Uint8Array): Promise<void> {
      if (!SHA256.test(sha256)) throw new Error('Computer Use private artifact digest is invalid')
      await withComputerUseArtifactMutation(dataDir, async () => {
        const target = join(root, sha256.slice(0, 2), sha256)
        if (platform === 'win32') windowsEnsurePrivateDirectorySync(root)
        const metadata = computerUseMarkerPath(dataDir, sha256)
        // Bytes first: until they exist a reclaim tombstone must stay, or the digest would read as
        // lost instead of reclaimed. Then a digest classified by any earlier screenshot is refreshed
        // to v1 with a new age, so GC cannot delete a newly returned reference by its old age.
        await writePrivate(dataDir, platform, target, bytes)
        if (pathEntryExists(metadata))
          await writePrivate(dataDir, platform, metadata, computerUseMetadata(sha256, bytes.byteLength))
      })
    },
    async putComputerUseMetadata(sha256: string, bytes: Uint8Array): Promise<void> {
      if (!SHA256.test(sha256)) throw new Error('Computer Use private metadata digest is invalid')
      await withComputerUseArtifactMutation(dataDir, async () => {
        const target = ensureMarkerShard(dataDir, platform, sha256)
        // A reclaim tombstone whose bytes are still gone stays until `put` has written the bytes.
        if (
          !pathEntryExists(join(root, sha256.slice(0, 2), sha256)) &&
          (await readComputerUseTombstone(dataDir, sha256))
        )
          return
        // Every new screenshot publication refreshes retention age. Otherwise a digest reused by a
        // later capture can still look like an old orphan and be deleted before its new ledger root
        // is committed. Private replacement remains atomic and also replaces an unsafe legacy leaf.
        await writePrivate(dataDir, platform, target, bytes)
      })
    },
  })
}
