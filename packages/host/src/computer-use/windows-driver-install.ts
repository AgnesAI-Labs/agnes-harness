import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPrivateFileSync,
  windowsEnsurePrivateDirectorySync,
  windowsOpenPrivateFileSync,
  windowsReadPrivateTextSync,
  windowsWritePrivateFile,
} from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import { type ComputerUseDriverLock, inspectComputerUseDriverLock } from './driver-lock.js'
import { connectComputerUseDriver } from './fake/connection.js'
import {
  assertComputerUseCoreHealth,
  assertComputerUseDoctorHealth,
  type ComputerUseHealthSelectors,
} from './health-report.js'
import {
  activateExtractedWindowsComputerUseDriver,
  extractLockedWindowsComputerUseDriver,
} from './windows-driver-archive.js'
import { downloadLockedWindowsComputerUseDriver } from './windows-driver-download.js'
import {
  type VerifiedWindowsComputerUseDriver,
  verifyWindowsComputerUseDriver,
} from './windows-driver-verifier.js'

const STATE_FILE = 'activation.json'
const STATE_MAX_BYTES = 32 * 1024
const LOCK_MAX_BYTES = 1024 * 1024
const INSTALL_LOCK_MAX_BYTES = 1024
const INSTALL_LOCK_STALE_MS = 10 * 60_000
const INSTALL_SERIALIZATION_LOCK = '.install-mutation-lock.db'
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u
const SHA256 = /^[a-f0-9]{64}$/u

export type WindowsComputerUseDriverRecord = Readonly<{
  version: string
  sourceTag: string
  sourceCommit: string
  archiveSha256: string
  directory: string
  publisher: string
  leafThumbprint: string
  publisherSha256: string
}>

export type WindowsComputerUseDriverState = Readonly<{
  schemaVersion: 1
  generation: number
  active: WindowsComputerUseDriverRecord | null
  lastKnownGood: WindowsComputerUseDriverRecord | null
}>

export type WindowsComputerUseDriverInstallResult = Readonly<{
  state: WindowsComputerUseDriverState
  installed: boolean
  usedLastKnownGood: boolean
  verified: VerifiedWindowsComputerUseDriver
}>

export type WindowsComputerUseDriverRecoveryResult = Readonly<{
  state: WindowsComputerUseDriverState
  verified: VerifiedWindowsComputerUseDriver
  rolledBack: boolean
}>

export type WindowsComputerUseDriverInstallDependencies = Readonly<{
  ensurePrivateDirectory?: (path: string) => void
  readPrivateText?: (path: string, maxBytes: number) => string
  writePrivateFile?: (path: string, bytes: Uint8Array) => Promise<void>
  exists?: (path: string) => boolean
  download?: typeof downloadLockedWindowsComputerUseDriver
  extract?: typeof extractLockedWindowsComputerUseDriver
  activate?: typeof activateExtractedWindowsComputerUseDriver
  verify?: typeof verifyWindowsComputerUseDriver
  health?: (driver: VerifiedWindowsComputerUseDriver, signal: AbortSignal) => Promise<void>
  clock?: () => number
  processAlive?: (pid: number) => boolean
}>

const rootQueues = new Map<string, Promise<void>>()

function selectedArtifact(lock: ComputerUseDriverLock) {
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture = runtimeArchitecture === 'x64' ? 'x86_64' : runtimeArchitecture
  return lock.artifacts.find(
    (artifact) => artifact.platform === 'win32' && artifact.architectures.includes(architecture as never),
  )
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value)
    throw new Error('Computer Use driver store root must be canonical')
  return value
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use driver activation state is invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field]
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    })
  )
    throw new Error('Computer Use driver activation state has unknown fields')
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value]))
}

function record(value: unknown): WindowsComputerUseDriverRecord {
  const row = exactObject(value, [
    'version',
    'sourceTag',
    'sourceCommit',
    'archiveSha256',
    'directory',
    'publisher',
    'leafThumbprint',
    'publisherSha256',
  ])
  if (
    typeof row.version !== 'string' ||
    !TOKEN.test(row.version) ||
    typeof row.sourceTag !== 'string' ||
    !/^cua-driver-rs-v[0-9]+\.[0-9]+\.[0-9]+$/u.test(row.sourceTag) ||
    typeof row.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(row.sourceCommit) ||
    typeof row.archiveSha256 !== 'string' ||
    !SHA256.test(row.archiveSha256) ||
    typeof row.directory !== 'string' ||
    !TOKEN.test(row.directory) ||
    typeof row.publisher !== 'string' ||
    row.publisher.length < 1 ||
    row.publisher.length > 256 ||
    typeof row.leafThumbprint !== 'string' ||
    !/^[A-Fa-f0-9]{40,128}$/u.test(row.leafThumbprint) ||
    typeof row.publisherSha256 !== 'string' ||
    !SHA256.test(row.publisherSha256)
  )
    throw new Error('Computer Use driver activation record is invalid')
  return Object.freeze(row as WindowsComputerUseDriverRecord)
}

function state(value: unknown): WindowsComputerUseDriverState {
  const row = exactObject(value, ['active', 'generation', 'lastKnownGood', 'schemaVersion'])
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.generation) || (row.generation as number) < 0)
    throw new Error('Computer Use driver activation state version is invalid')
  return Object.freeze({
    schemaVersion: 1,
    generation: row.generation as number,
    active: row.active === null ? null : record(row.active),
    lastKnownGood: row.lastKnownGood === null ? null : record(row.lastKnownGood),
  })
}

function emptyState(): WindowsComputerUseDriverState {
  return Object.freeze({ schemaVersion: 1, generation: 0, active: null, lastKnownGood: null })
}

function readState(
  root: string,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): WindowsComputerUseDriverState {
  try {
    const text = (dependencies.readPrivateText ?? windowsReadPrivateTextSync)(
      join(root, STATE_FILE),
      STATE_MAX_BYTES,
    )
    const parsed: unknown = JSON.parse(text)
    const checked = state(parsed)
    if (text !== `${JSON.stringify(checked, null, 2)}\n`)
      throw new Error('Computer Use driver activation state is not canonical JSON')
    return checked
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

async function writeState(
  root: string,
  value: WindowsComputerUseDriverState,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
  await (dependencies.writePrivateFile ?? windowsWritePrivateFile)(join(root, STATE_FILE), bytes)
}

function lockSnapshotPath(root: string, value: WindowsComputerUseDriverRecord): string {
  return join(root, 'locks', `${value.directory}.json`)
}

async function writeLockSnapshot(
  root: string,
  value: WindowsComputerUseDriverRecord,
  lock: ComputerUseDriverLock,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): Promise<void> {
  if (!matchesLock(value, lock))
    throw new Error('Computer Use driver lock snapshot does not match its activation record')
  const bytes = new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`)
  if (bytes.byteLength > LOCK_MAX_BYTES) throw new Error('Computer Use driver lock snapshot is oversized')
  await (dependencies.writePrivateFile ?? windowsWritePrivateFile)(lockSnapshotPath(root, value), bytes)
}

function readLockSnapshot(
  root: string,
  value: WindowsComputerUseDriverRecord,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): ComputerUseDriverLock {
  const text = (dependencies.readPrivateText ?? windowsReadPrivateTextSync)(
    lockSnapshotPath(root, value),
    LOCK_MAX_BYTES,
  )
  const parsed: unknown = JSON.parse(text)
  const inspected = inspectComputerUseDriverLock(parsed)
  if (!inspected.ok) throw new Error('Computer Use driver lock snapshot is invalid')
  if (text !== `${JSON.stringify(inspected.lock, null, 2)}\n`)
    throw new Error('Computer Use driver lock snapshot is not canonical JSON')
  if (!matchesLock(value, inspected.lock))
    throw new Error('Computer Use driver lock snapshot does not match its activation record')
  return inspected.lock
}

function availableRollbackRecord(
  root: string,
  before: WindowsComputerUseDriverState,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): WindowsComputerUseDriverRecord | undefined {
  for (const candidate of [before.active, before.lastKnownGood]) {
    if (!candidate) continue
    try {
      readLockSnapshot(root, candidate, dependencies)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function withRootQueue<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = rootQueues.get(root) ?? Promise.resolve()
  let release: () => void = () => undefined
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = prior.then(() => next)
  rootQueues.set(root, queued)
  await prior
  try {
    return await operation()
  } finally {
    release()
    if (rootQueues.get(root) === queued) rootQueues.delete(root)
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function acquireProcessSerialization(root: string): () => void {
  const path = join(root, INSTALL_SERIALIZATION_LOCK)
  try {
    closeSync(createPrivateFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let validationError: unknown
  if (createPlatform().os === 'win32') {
    try {
      closeSync(windowsOpenPrivateFileSync(path))
    } catch (error) {
      // SQLite's active writer handle can intentionally deny this validation handle. In that case
      // BEGIN IMMEDIATE below must prove contention; otherwise preserve the validation failure.
      validationError = error
    }
  } else {
    const stat = lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('Computer Use Windows installation serialization lock is unsafe')
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    database.close()
    const code = (error as { errcode?: unknown }).errcode
    if (code === 5 || code === 6) throw new Error('Computer Use Windows installation is already in progress')
    throw error
  }
  if (validationError) {
    try {
      database.exec('ROLLBACK')
    } finally {
      database.close()
    }
    throw validationError
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      database.exec('COMMIT')
    } finally {
      database.close()
    }
  }
}

function parseInstallLockOwner(text: string): { createdAt: number; nonce: string; pid: number } | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    if (Object.keys(value).sort().join(',') !== 'createdAt,nonce,pid') return undefined
    const owner = value as { createdAt?: unknown; nonce?: unknown; pid?: unknown }
    if (
      !Number.isSafeInteger(owner.createdAt) ||
      (owner.createdAt as number) < 0 ||
      typeof owner.nonce !== 'string' ||
      !/^[a-f0-9]{48}$/u.test(owner.nonce) ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0
    )
      return undefined
    const checked = owner as { createdAt: number; nonce: string; pid: number }
    if (text !== `${JSON.stringify(checked)}\n`) return undefined
    return checked
  } catch {
    return undefined
  }
}

async function acquireProcessLock(
  root: string,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): Promise<() => Promise<void>> {
  const path = join(root, '.install-lock')
  const ownerNonce = randomBytes(24).toString('hex')
  const now = (dependencies.clock ?? Date.now)()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Computer Use Windows installation clock is invalid')
  const releaseSerialization = acquireProcessSerialization(root)
  const ensure = dependencies.ensurePrivateDirectory ?? windowsEnsurePrivateDirectorySync
  const read = dependencies.readPrivateText ?? windowsReadPrivateTextSync
  const write = dependencies.writePrivateFile ?? windowsWritePrivateFile

  const removeOwnedDirectory = (directory: string): void => {
    try {
      unlinkSync(join(directory, 'owner'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Never recursively delete a lock path. An unexpected entry or replacement leaves a harmless
    // tombstone and fails closed instead of allowing traversal through an attacker-created reparse.
    rmdirSync(directory)
  }

  const acquire = async (): Promise<void> => {
    let created = false
    try {
      mkdirSync(path)
      created = true
      ensure(path)
      return
    } catch (error) {
      if (created) {
        try {
          rmdirSync(path)
        } catch {
          // Preserve the private-directory validation failure; a nonempty residue blocks retries.
        }
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let owner: ReturnType<typeof parseInstallLockOwner>
    try {
      owner = parseInstallLockOwner(read(join(path, 'owner'), INSTALL_LOCK_MAX_BYTES))
    } catch {
      // A fresh or malformed lock is not proof that its creator is dead.
    }
    if (
      !owner ||
      now - owner.createdAt < INSTALL_LOCK_STALE_MS ||
      (dependencies.processAlive ?? defaultProcessAlive)(owner.pid)
    )
      throw new Error('Computer Use Windows installation is already in progress')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Computer Use Windows installation lock is unsafe')
    const stale = join(root, `.stale-install-lock-${ownerNonce}`)
    try {
      renameSync(path, stale)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await acquire()
        return
      }
      throw error
    }
    const moved = lstatSync(stale)
    if (!moved.isDirectory() || moved.isSymbolicLink())
      throw new Error('Computer Use Windows stale installation lock is unsafe')
    removeOwnedDirectory(stale)
    await acquire()
  }

  try {
    await acquire()
  } catch (error) {
    releaseSerialization()
    throw error
  }
  try {
    await write(
      join(path, 'owner'),
      new TextEncoder().encode(
        `${JSON.stringify({ createdAt: now, nonce: ownerNonce, pid: process.pid })}\n`,
      ),
    )
  } catch (error) {
    try {
      removeOwnedDirectory(path)
    } catch {
      // Preserve the write failure. The residue intentionally blocks another mutation.
    }
    releaseSerialization()
    throw error
  }

  return async () => {
    try {
      const owner = parseInstallLockOwner(read(join(path, 'owner'), INSTALL_LOCK_MAX_BYTES))
      if (!owner || owner.nonce !== ownerNonce || owner.pid !== process.pid)
        throw new Error('Computer Use Windows installation lock ownership changed')
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Computer Use Windows installation lock identity changed')
      const released = join(root, `.released-install-lock-${ownerNonce}`)
      renameSync(path, released)
      const moved = lstatSync(released)
      if (!moved.isDirectory() || moved.isSymbolicLink())
        throw new Error('Computer Use Windows released installation lock is unsafe')
      removeOwnedDirectory(released)
    } finally {
      releaseSerialization()
    }
  }
}

function driverRecord(
  lock: ComputerUseDriverLock,
  directory: string,
  verified: VerifiedWindowsComputerUseDriver,
): WindowsComputerUseDriverRecord {
  const artifact = selectedArtifact(lock)
  if (!artifact) throw new Error('Computer Use lock has no Windows artifact for this architecture')
  return Object.freeze({
    version: verified.version,
    sourceTag: lock.source.tag,
    sourceCommit: lock.source.commit,
    archiveSha256: artifact.sha256,
    directory,
    publisher: verified.publisher,
    leafThumbprint: verified.leafThumbprint,
    publisherSha256: verified.publisherSha256,
  })
}

function matchesLock(value: WindowsComputerUseDriverRecord, lock: ComputerUseDriverLock): boolean {
  const artifact = selectedArtifact(lock)
  return (
    artifact !== undefined &&
    value.version === lock.source.tag.slice('cua-driver-rs-v'.length) &&
    value.sourceTag === lock.source.tag &&
    value.sourceCommit === lock.source.commit &&
    value.archiveSha256 === artifact.sha256
  )
}

export async function probeWindowsComputerUseDriverHealth(
  driver: VerifiedWindowsComputerUseDriver,
  signal: AbortSignal,
  selectors?: ComputerUseHealthSelectors,
): Promise<void> {
  const connection = await connectComputerUseDriver(
    { command: driver.executablePath, args: ['mcp'], startupTimeoutMs: 10_000, closeGraceMs: 1_000 },
    1,
    randomBytes(24).toString('hex'),
    signal,
  )
  try {
    for (const name of ['health_report', 'check_permissions', 'get_window_state'])
      if (!connection.catalog.has(name)) throw new Error(`Computer Use driver catalog lacks ${name}`)
    const params = selectors
      ? {
          ...(selectors.include ? { include: [...selectors.include] } : {}),
          ...(selectors.skip ? { skip: [...selectors.skip] } : {}),
        }
      : {}
    const result = await connection.call('health_report', params, { timeoutMs: 10_000, signal })
    if (selectors === undefined) assertComputerUseCoreHealth(result, 'win32', driver.version)
    else assertComputerUseDoctorHealth(result, 'win32', driver.version, selectors)
  } finally {
    await connection.close('health-check')
  }
}

/** Re-proves the on-disk signer/version identity before running a live health probe. */
export async function doctorLockedWindowsComputerUseDriver(input: {
  directory: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: Pick<WindowsComputerUseDriverInstallDependencies, 'verify' | 'health'>
  selectors?: ComputerUseHealthSelectors
}): Promise<VerifiedWindowsComputerUseDriver> {
  if (!isAbsolute(input.directory) || resolve(input.directory) !== input.directory)
    throw new Error('Computer Use doctor driver directory must be canonical')
  const signal = input.signal ?? new AbortController().signal
  const verified = await (input.dependencies?.verify ?? verifyWindowsComputerUseDriver)(
    input.directory,
    input.lock,
  )
  const health = input.dependencies?.health ?? probeWindowsComputerUseDriverHealth
  await health(verified, signal, input.selectors ?? {})
  return verified
}

async function verifyRecord(
  root: string,
  value: WindowsComputerUseDriverRecord,
  lock: ComputerUseDriverLock,
  dependencies: WindowsComputerUseDriverInstallDependencies,
): Promise<VerifiedWindowsComputerUseDriver> {
  if (!matchesLock(value, lock))
    throw new Error('Computer Use installed driver does not match the requested lock')
  const directory = join(root, 'versions', value.directory)
  const verified = await (dependencies.verify ?? verifyWindowsComputerUseDriver)(directory, lock)
  if (
    verified.version !== value.version ||
    verified.publisher !== value.publisher ||
    verified.leafThumbprint.toUpperCase() !== value.leafThumbprint.toUpperCase() ||
    verified.publisherSha256 !== value.publisherSha256
  )
    throw new Error('Computer Use installed driver identity changed')
  return verified
}

async function verifyHealthyRecord(
  root: string,
  value: WindowsComputerUseDriverRecord,
  lock: ComputerUseDriverLock,
  dependencies: WindowsComputerUseDriverInstallDependencies,
  signal: AbortSignal,
): Promise<VerifiedWindowsComputerUseDriver> {
  const verified = await verifyRecord(root, value, lock, dependencies)
  await (dependencies.health ?? probeWindowsComputerUseDriverHealth)(verified, signal)
  return verified
}

async function verifyStoredHealthyRecord(
  root: string,
  value: WindowsComputerUseDriverRecord,
  dependencies: WindowsComputerUseDriverInstallDependencies,
  signal: AbortSignal,
): Promise<VerifiedWindowsComputerUseDriver> {
  return verifyHealthyRecord(root, value, readLockSnapshot(root, value, dependencies), dependencies, signal)
}

/**
 * Installs the exact locked Windows release into an immutable version directory. Activation is one
 * atomic private state-file replacement and happens only after signature, version and MCP health
 * checks succeed. The previous active release remains the rollback target.
 */
export async function installOrUpdateLockedWindowsComputerUseDriver(input: {
  root: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: WindowsComputerUseDriverInstallDependencies
}): Promise<WindowsComputerUseDriverInstallResult> {
  if (createPlatform().os !== 'win32' && !input.dependencies)
    throw new Error('Windows Computer Use driver installation is unavailable on this platform')
  const root = canonicalRoot(input.root)
  const dependencies = input.dependencies ?? {}
  const signal = input.signal ?? new AbortController().signal
  return withRootQueue(root, async () => {
    signal.throwIfAborted()
    const ensure = dependencies.ensurePrivateDirectory ?? windowsEnsurePrivateDirectorySync
    ensure(root)
    const unlock = await acquireProcessLock(root, dependencies)
    try {
      ensure(join(root, 'versions'))
      ensure(join(root, 'staging'))
      ensure(join(root, 'locks'))
      const before = readState(root, dependencies)
      let repairCurrent = false
      if (before.active && matchesLock(before.active, input.lock)) {
        try {
          const verified = await verifyHealthyRecord(root, before.active, input.lock, dependencies, signal)
          // Migrates stores created before per-version lock snapshots were introduced.
          await writeLockSnapshot(root, before.active, input.lock, dependencies)
          return Object.freeze({
            state: before,
            installed: false,
            usedLastKnownGood: false,
            verified,
          })
        } catch {
          signal.throwIfAborted()
          const lkg = before.lastKnownGood
          if (lkg && lkg.directory !== before.active.directory) {
            try {
              const verified = await verifyStoredHealthyRecord(root, lkg, dependencies, signal)
              const after = Object.freeze({
                schemaVersion: 1 as const,
                generation: before.generation + 1,
                active: lkg,
                lastKnownGood: lkg,
              })
              await writeState(root, after, dependencies)
              return Object.freeze({
                state: after,
                installed: false,
                usedLastKnownGood: true,
                verified,
              })
            } catch {
              signal.throwIfAborted()
            }
          }
          // Do not overwrite or delete the suspect directory. Reinstall the exact current lock into
          // a fresh immutable directory, then publish it only after signature and health checks pass.
          repairCurrent = true
        }
      }

      try {
        const artifact = selectedArtifact(input.lock)
        if (!artifact) throw new Error('Computer Use lock has no Windows artifact for this architecture')
        const canonicalDirectory = `${input.lock.source.tag}-${artifact.sha256}`
        const directory = repairCurrent
          ? `${canonicalDirectory}-repair-${randomBytes(8).toString('hex')}`
          : canonicalDirectory
        const versionDirectory = join(root, 'versions', directory)
        let verified: VerifiedWindowsComputerUseDriver
        let installed = false
        if ((dependencies.exists ?? existsSync)(versionDirectory)) {
          verified = await (dependencies.verify ?? verifyWindowsComputerUseDriver)(
            versionDirectory,
            input.lock,
          )
        } else {
          const archive = await (dependencies.download ?? downloadLockedWindowsComputerUseDriver)(
            input.lock,
            { signal },
          )
          const extracted = await (dependencies.extract ?? extractLockedWindowsComputerUseDriver)({
            archiveBytes: archive,
            stagingParent: join(root, 'staging'),
            lock: input.lock,
            signal,
          })
          let activated = false
          try {
            ;(dependencies.activate ?? activateExtractedWindowsComputerUseDriver)(extracted, versionDirectory)
            activated = true
            installed = true
          } finally {
            if (!activated) await extracted.release()
          }
          verified = await (dependencies.verify ?? verifyWindowsComputerUseDriver)(
            versionDirectory,
            input.lock,
          )
        }
        await (dependencies.health ?? probeWindowsComputerUseDriverHealth)(verified, signal)
        const active = driverRecord(input.lock, directory, verified)
        await writeLockSnapshot(root, active, input.lock, dependencies)
        const rollback = repairCurrent ? undefined : availableRollbackRecord(root, before, dependencies)
        const after = Object.freeze({
          schemaVersion: 1 as const,
          generation: before.generation + 1,
          active,
          lastKnownGood: rollback ?? active,
        })
        await writeState(root, after, dependencies)
        return Object.freeze({
          state: after,
          installed,
          usedLastKnownGood: false,
          verified,
        })
      } catch (candidateError) {
        signal.throwIfAborted()
        if (!before.active) throw candidateError
        try {
          const verified = await verifyStoredHealthyRecord(root, before.active, dependencies, signal)
          return Object.freeze({
            state: before,
            installed: false,
            usedLastKnownGood: true,
            verified,
          })
        } catch (rollbackError) {
          throw new AggregateError(
            [candidateError, rollbackError],
            'Computer Use candidate and active fallback are both unavailable',
          )
        }
      }
    } finally {
      await unlock()
    }
  })
}

/** Revalidates the active release and atomically rolls back to a healthy LKG when it is damaged. */
export async function recoverLockedWindowsComputerUseDriver(input: {
  root: string
  activeLock: ComputerUseDriverLock
  lastKnownGoodLock?: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: WindowsComputerUseDriverInstallDependencies
}): Promise<WindowsComputerUseDriverRecoveryResult> {
  if (createPlatform().os !== 'win32' && !input.dependencies)
    throw new Error('Windows Computer Use driver recovery is unavailable on this platform')
  const root = canonicalRoot(input.root)
  const dependencies = input.dependencies ?? {}
  const signal = input.signal ?? new AbortController().signal
  return withRootQueue(root, async () => {
    signal.throwIfAborted()
    const ensure = dependencies.ensurePrivateDirectory ?? windowsEnsurePrivateDirectorySync
    ensure(root)
    const unlock = await acquireProcessLock(root, dependencies)
    try {
      const current = readState(root, dependencies)
      if (!current.active) throw new Error('Computer Use driver has no active installation')
      try {
        const verified = await verifyRecord(root, current.active, input.activeLock, dependencies)
        await (dependencies.health ?? probeWindowsComputerUseDriverHealth)(verified, signal)
        return Object.freeze({ state: current, verified, rolledBack: false })
      } catch (activeError) {
        signal.throwIfAborted()
        const lkg = current.lastKnownGood
        if (!lkg || lkg.directory === current.active.directory)
          throw new AggregateError(
            [activeError],
            'Computer Use active driver is unhealthy and no distinct LKG exists',
          )
        try {
          const lkgLock = input.lastKnownGoodLock ?? readLockSnapshot(root, lkg, dependencies)
          const verified = await verifyRecord(root, lkg, lkgLock, dependencies)
          await (dependencies.health ?? probeWindowsComputerUseDriverHealth)(verified, signal)
          const after = Object.freeze({
            schemaVersion: 1 as const,
            generation: current.generation + 1,
            active: lkg,
            lastKnownGood: lkg,
          })
          await writeState(root, after, dependencies)
          return Object.freeze({ state: after, verified, rolledBack: true })
        } catch (rollbackError) {
          throw new AggregateError(
            [activeError, rollbackError],
            'Computer Use active driver and LKG are both unhealthy',
          )
        }
      }
    } finally {
      await unlock()
    }
  })
}

export function readWindowsComputerUseDriverState(
  root: string,
  dependencies: WindowsComputerUseDriverInstallDependencies = {},
): WindowsComputerUseDriverState {
  return readState(canonicalRoot(root), dependencies)
}
