import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateDirectorySync, createPrivateFileSync, renameWriteThroughSync } from '@agnes/system-node'
import { createPlatform } from '../adapters/platform.js'
import { type ComputerUseDriverLock, inspectComputerUseDriverLock } from './driver-lock.js'
import {
  assertComputerUseCoreHealth,
  assertComputerUseDoctorHealth,
  COMPUTER_USE_CORE_HEALTH_CHECKS,
  type ComputerUseHealthSelectors,
} from './health-report.js'
import {
  activateExtractedMacOSComputerUseDriver,
  extractLockedMacOSComputerUseDriver,
} from './macos-driver-archive.js'
import type { VerifiedMacOSComputerUseDriver } from './macos-driver-backend.js'
import { createMacOSComputerUseSessionRuntime } from './macos-driver-backend.js'
import { downloadLockedMacOSComputerUseDriver } from './macos-driver-download.js'
import { verifyMacOSComputerUseDriver } from './macos-driver-verifier.js'

const STATE_FILE = 'activation.json'
const STATE_MAX_BYTES = 32 * 1024
const LOCK_MAX_BYTES = 1024 * 1024
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const INSTALL_SERIALIZATION_LOCK = '.install-mutation-lock.db'
const queues = new Map<string, Promise<void>>()

export type MacOSComputerUseDriverRecord = Readonly<{
  version: string
  sourceTag: string
  sourceCommit: string
  archiveSha256: string
  directory: string
  bundleId: string
  teamId: string
  authority: string
}>

export type MacOSComputerUseDriverState = Readonly<{
  schemaVersion: 1
  generation: number
  active: MacOSComputerUseDriverRecord | null
  lastKnownGood: MacOSComputerUseDriverRecord | null
}>

export type MacOSComputerUseDriverInstallResult = Readonly<{
  state: MacOSComputerUseDriverState
  installed: boolean
  usedLastKnownGood: boolean
  verified: VerifiedMacOSComputerUseDriver
}>

export type MacOSComputerUseDriverInstallDependencies = Readonly<{
  download?: typeof downloadLockedMacOSComputerUseDriver
  extract?: typeof extractLockedMacOSComputerUseDriver
  activate?: typeof activateExtractedMacOSComputerUseDriver
  verify?: typeof verifyMacOSComputerUseDriver
  health?: (driver: VerifiedMacOSComputerUseDriver, signal: AbortSignal) => Promise<void>
  clock?: () => number
  processAlive?: (pid: number) => boolean
}>

function canonicalRoot(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root)
    throw new Error('Computer Use driver root must be canonical')
  return root
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) createPrivateDirectorySync(path)
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (createPlatform().os !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new Error('Computer Use driver directory is not private')
}

function ensureLayout(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Computer Use driver root is not a directory')
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new Error('Computer Use driver root has a foreign owner')
  // Validate identity before chmod: chmod follows symlinks on macOS and must never mutate an
  // attacker-selected target while trying to repair the private root.
  chmodSync(root, 0o700)
  ensureDirectory(root)
  for (const name of ['versions', 'staging', 'locks']) ensureDirectory(join(root, name))
}

function readPrivate(path: string, maximum: number): string {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.getuid !== undefined && stat.uid !== process.getuid()) ||
    (createPlatform().os !== 'win32' && (stat.mode & 0o077) !== 0) ||
    stat.size > maximum
  )
    throw new Error('Computer Use private state file is unsafe')
  return readFileSync(path, 'utf8')
}

function writePrivate(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = createPrivateFileSync(temporary)
  let committed = false
  try {
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWriteThroughSync(temporary, path)
    committed = true
  } finally {
    if (!committed) rmSync(temporary, { force: true })
  }
}

function record(value: unknown): MacOSComputerUseDriverRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use macOS activation record is invalid')
  const row = value as Record<string, unknown>
  if (
    JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify(
        [
          'archiveSha256',
          'authority',
          'bundleId',
          'directory',
          'sourceCommit',
          'sourceTag',
          'teamId',
          'version',
        ].sort(),
      ) ||
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
    typeof row.bundleId !== 'string' ||
    !row.bundleId ||
    typeof row.teamId !== 'string' ||
    !row.teamId ||
    typeof row.authority !== 'string' ||
    !row.authority
  )
    throw new Error('Computer Use macOS activation record is invalid')
  return Object.freeze(row as MacOSComputerUseDriverRecord)
}

function state(value: unknown): MacOSComputerUseDriverState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use macOS activation state is invalid')
  const row = value as Record<string, unknown>
  if (
    JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify(['active', 'generation', 'lastKnownGood', 'schemaVersion'].sort()) ||
    row.schemaVersion !== 1 ||
    !Number.isSafeInteger(row.generation) ||
    (row.generation as number) < 0
  )
    throw new Error('Computer Use macOS activation state is invalid')
  return Object.freeze({
    schemaVersion: 1,
    generation: row.generation as number,
    active: row.active === null ? null : record(row.active),
    lastKnownGood: row.lastKnownGood === null ? null : record(row.lastKnownGood),
  })
}

function readState(root: string): MacOSComputerUseDriverState {
  const path = join(root, STATE_FILE)
  if (!existsSync(path))
    return Object.freeze({ schemaVersion: 1, generation: 0, active: null, lastKnownGood: null })
  const text = readPrivate(path, STATE_MAX_BYTES)
  const checked = state(JSON.parse(text) as unknown)
  if (text !== `${JSON.stringify(checked, null, 2)}\n`)
    throw new Error('Computer Use macOS activation state is not canonical JSON')
  return checked
}

function writeState(root: string, value: MacOSComputerUseDriverState): void {
  writePrivate(join(root, STATE_FILE), new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`))
}

function snapshotPath(root: string, value: MacOSComputerUseDriverRecord): string {
  return join(root, 'locks', `${value.directory}.json`)
}

function selectedArtifact(lock: ComputerUseDriverLock) {
  return lock.artifacts.find((artifact) => artifact.platform === 'darwin')
}

function matchesLock(value: MacOSComputerUseDriverRecord, lock: ComputerUseDriverLock): boolean {
  const artifact = selectedArtifact(lock)
  return (
    artifact !== undefined &&
    value.version === lock.source.tag.slice('cua-driver-rs-v'.length) &&
    value.sourceTag === lock.source.tag &&
    value.sourceCommit === lock.source.commit &&
    value.archiveSha256 === artifact.sha256
  )
}

function writeSnapshot(root: string, value: MacOSComputerUseDriverRecord, lock: ComputerUseDriverLock): void {
  if (!matchesLock(value, lock)) throw new Error('Computer Use macOS lock snapshot does not match record')
  const bytes = new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`)
  if (bytes.byteLength > LOCK_MAX_BYTES) throw new Error('Computer Use macOS lock snapshot is oversized')
  writePrivate(snapshotPath(root, value), bytes)
}

function readSnapshot(root: string, value: MacOSComputerUseDriverRecord): ComputerUseDriverLock {
  const text = readPrivate(snapshotPath(root, value), LOCK_MAX_BYTES)
  const inspected = inspectComputerUseDriverLock(JSON.parse(text) as unknown)
  if (
    !inspected.ok ||
    text !== `${JSON.stringify(inspected.lock, null, 2)}\n` ||
    !matchesLock(value, inspected.lock)
  )
    throw new Error('Computer Use macOS lock snapshot is invalid')
  return inspected.lock
}

function driverRecord(
  lock: ComputerUseDriverLock,
  directory: string,
  driver: VerifiedMacOSComputerUseDriver,
): MacOSComputerUseDriverRecord {
  const artifact = selectedArtifact(lock)
  if (!artifact) throw new Error('Computer Use lock has no macOS artifact')
  return Object.freeze({
    version: driver.version,
    sourceTag: lock.source.tag,
    sourceCommit: lock.source.commit,
    archiveSha256: artifact.sha256,
    directory,
    bundleId: driver.bundleId,
    teamId: driver.teamId,
    authority: driver.authority,
  })
}

export async function probeMacOSComputerUseDriverHealth(
  driver: VerifiedMacOSComputerUseDriver,
  signal: AbortSignal,
  selectors?: ComputerUseHealthSelectors,
  dependencies: Readonly<{
    runtime?: ReturnType<typeof createMacOSComputerUseSessionRuntime>
  }> = {},
): Promise<void> {
  const runtime = dependencies.runtime ?? createMacOSComputerUseSessionRuntime(driver)
  const session = Object.freeze({ key: `health-${randomBytes(12).toString('hex')}`, lane: 'health' })
  const connection = await runtime.open(session, signal)
  try {
    for (const name of ['health_report', 'check_permissions', 'get_window_state'])
      if (!connection.catalog.has(name)) throw new Error(`Computer Use driver catalog lacks ${name}`)
    const params = selectors
      ? {
          ...(selectors.include ? { include: [...selectors.include] } : {}),
          ...(selectors.skip ? { skip: [...selectors.skip] } : {}),
        }
      : { include: [...COMPUTER_USE_CORE_HEALTH_CHECKS] }
    const result = await connection.call('health_report', params, { timeoutMs: 10_000, signal })
    if (selectors === undefined) assertComputerUseCoreHealth(result, 'darwin', driver.version)
    else assertComputerUseDoctorHealth(result, 'darwin', driver.version, selectors)
  } finally {
    try {
      await runtime.close(session, 'session_end')
    } finally {
      await runtime.dispose()
    }
  }
}

/** Re-proves codesign/Gatekeeper/notarization identity before running a live health probe. */
export async function doctorLockedMacOSComputerUseDriver(input: {
  directory: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: Pick<MacOSComputerUseDriverInstallDependencies, 'verify' | 'health'>
  selectors?: ComputerUseHealthSelectors
}): Promise<VerifiedMacOSComputerUseDriver> {
  if (!isAbsolute(input.directory) || resolve(input.directory) !== input.directory)
    throw new Error('Computer Use macOS doctor driver directory must be canonical')
  const signal = input.signal ?? new AbortController().signal
  const verified = await (input.dependencies?.verify ?? verifyMacOSComputerUseDriver)(
    input.directory,
    input.lock,
  )
  const health = input.dependencies?.health ?? probeMacOSComputerUseDriverHealth
  await health(verified, signal, input.selectors ?? {})
  return verified
}

async function verifyRecord(
  root: string,
  value: MacOSComputerUseDriverRecord,
  lock: ComputerUseDriverLock,
  dependencies: MacOSComputerUseDriverInstallDependencies,
  signal: AbortSignal,
): Promise<VerifiedMacOSComputerUseDriver> {
  if (!matchesLock(value, lock)) throw new Error('Computer Use macOS driver does not match requested lock')
  const verified = await (dependencies.verify ?? verifyMacOSComputerUseDriver)(
    join(root, 'versions', value.directory),
    lock,
  )
  if (
    verified.version !== value.version ||
    verified.bundleId !== value.bundleId ||
    verified.teamId !== value.teamId ||
    verified.authority !== value.authority
  )
    throw new Error('Computer Use macOS installed identity changed')
  await (dependencies.health ?? probeMacOSComputerUseDriverHealth)(verified, signal)
  return verified
}

async function queue<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(root) ?? Promise.resolve()
  let release: () => void = () => undefined
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prior.then(() => next)
  queues.set(root, tail)
  await prior
  try {
    return await operation()
  } finally {
    release()
    if (queues.get(root) === tail) queues.delete(root)
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

function removeOwnedInstallLock(directory: string): void {
  try {
    unlinkSync(join(directory, 'owner'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // An unexpected entry blocks cleanup instead of being recursively deleted through a path that
  // another same-user process can mutate while installation recovery is running.
  rmdirSync(directory)
}

function acquireProcessSerialization(root: string): () => void {
  const path = join(root, INSTALL_SERIALIZATION_LOCK)
  try {
    closeSync(createPrivateFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (createPlatform().os !== 'win32') {
    const stat = lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('Computer Use macOS installation serialization lock is unsafe')
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    database.close()
    const code = (error as { errcode?: unknown }).errcode
    if (code === 5 || code === 6) throw new Error('Computer Use macOS installation is already in progress')
    throw error
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

function acquireProcessLock(
  root: string,
  dependencies: MacOSComputerUseDriverInstallDependencies,
): () => void {
  const path = join(root, '.install-lock')
  const ownerNonce = randomUUID()
  const now = (dependencies.clock ?? Date.now)()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Computer Use macOS installation clock is invalid')
  const releaseSerialization = acquireProcessSerialization(root)
  const acquire = (): void => {
    try {
      createPrivateDirectorySync(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let owner: { pid: number; createdAt: number; nonce?: string } | undefined
    try {
      const parsed = JSON.parse(readPrivate(join(path, 'owner'), 1024)) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (Object.keys(parsed).sort().join(',') === 'createdAt,pid' ||
          Object.keys(parsed).sort().join(',') === 'createdAt,nonce,pid') &&
        Number.isSafeInteger((parsed as { pid?: unknown }).pid) &&
        ((parsed as { pid: number }).pid as number) > 0 &&
        Number.isSafeInteger((parsed as { createdAt?: unknown }).createdAt) &&
        ((parsed as { createdAt: number }).createdAt as number) >= 0 &&
        (!Object.hasOwn(parsed, 'nonce') ||
          (typeof (parsed as { nonce?: unknown }).nonce === 'string' &&
            /^[0-9a-f-]{36}$/u.test((parsed as { nonce: string }).nonce)))
      )
        owner = parsed as { pid: number; createdAt: number; nonce?: string }
    } catch {
      /* A fresh or malformed lock is never proof that its owner is dead. */
    }
    if (
      !owner ||
      now - owner.createdAt < 10 * 60_000 ||
      (dependencies.processAlive ?? defaultProcessAlive)(owner.pid)
    )
      throw new Error('Computer Use macOS installation is already in progress')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Computer Use macOS installation lock is unsafe')
    const stale = join(root, `.stale-install-lock-${randomUUID()}`)
    try {
      renameSync(path, stale)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        acquire()
        return
      }
      throw error
    }
    const moved = lstatSync(stale)
    if (!moved.isDirectory() || moved.isSymbolicLink())
      throw new Error('Computer Use macOS stale installation lock is unsafe')
    removeOwnedInstallLock(stale)
    acquire()
  }
  try {
    acquire()
  } catch (error) {
    releaseSerialization()
    throw error
  }
  try {
    writePrivate(
      join(path, 'owner'),
      new TextEncoder().encode(
        `${JSON.stringify({ createdAt: now, nonce: ownerNonce, pid: process.pid })}\n`,
      ),
    )
  } catch (error) {
    try {
      removeOwnedInstallLock(path)
    } catch {
      // Preserve the owner-write error. Any unexpected residue intentionally blocks another writer.
    }
    releaseSerialization()
    throw error
  }
  return () => {
    try {
      const parsed = JSON.parse(readPrivate(join(path, 'owner'), 1024)) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'createdAt,nonce,pid' ||
        (parsed as { nonce?: unknown }).nonce !== ownerNonce ||
        (parsed as { pid?: unknown }).pid !== process.pid
      )
        throw new Error('Computer Use macOS installation lock ownership changed')
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Computer Use macOS installation lock identity changed')
      const released = join(root, `.released-install-lock-${ownerNonce}`)
      renameSync(path, released)
      const moved = lstatSync(released)
      if (!moved.isDirectory() || moved.isSymbolicLink())
        throw new Error('Computer Use macOS released installation lock is unsafe')
      removeOwnedInstallLock(released)
    } finally {
      releaseSerialization()
    }
  }
}

/** Installs or repairs a locked macOS driver; activation changes only after signature + health pass. */
export async function installOrUpdateLockedMacOSComputerUseDriver(input: {
  root: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: MacOSComputerUseDriverInstallDependencies
}): Promise<MacOSComputerUseDriverInstallResult> {
  const root = canonicalRoot(input.root)
  const dependencies = input.dependencies ?? {}
  const signal = input.signal ?? new AbortController().signal
  if (createPlatform().os !== 'darwin' && !input.dependencies)
    throw new Error('macOS Computer Use driver installation is unavailable on this platform')
  ensureLayout(root)
  return queue(root, async () => {
    const unlock = acquireProcessLock(root, dependencies)
    try {
      signal.throwIfAborted()
      const before = readState(root)
      if (before.active && matchesLock(before.active, input.lock)) {
        try {
          const verified = await verifyRecord(root, before.active, input.lock, dependencies, signal)
          return Object.freeze({ state: before, installed: false, usedLastKnownGood: false, verified })
        } catch {
          signal.throwIfAborted()
        }
      }

      let healthyFallback:
        | Readonly<{ record: MacOSComputerUseDriverRecord; verified: VerifiedMacOSComputerUseDriver }>
        | undefined
      for (const candidate of [before.active, before.lastKnownGood]) {
        if (!candidate) continue
        try {
          const verified = await verifyRecord(
            root,
            candidate,
            readSnapshot(root, candidate),
            dependencies,
            signal,
          )
          healthyFallback = { record: candidate, verified }
          break
        } catch {
          signal.throwIfAborted()
        }
      }

      let activatedCandidate: string | undefined
      try {
        const bytes = await (dependencies.download ?? downloadLockedMacOSComputerUseDriver)(input.lock, {
          signal,
        })
        const extracted = await (dependencies.extract ?? extractLockedMacOSComputerUseDriver)({
          archiveBytes: bytes,
          stagingParent: join(root, 'staging'),
          lock: input.lock,
          signal,
        })
        const directory = `${extracted.verified.version}-${randomUUID()}`
        try {
          activatedCandidate = join(root, 'versions', directory)
          ;(dependencies.activate ?? activateExtractedMacOSComputerUseDriver)(extracted, activatedCandidate)
          const record = driverRecord(input.lock, directory, extracted.verified)
          writeSnapshot(root, record, input.lock)
          const verified = await verifyRecord(root, record, input.lock, dependencies, signal)
          const after = Object.freeze({
            schemaVersion: 1 as const,
            generation: before.generation + 1,
            active: record,
            lastKnownGood: healthyFallback?.record ?? record,
          })
          writeState(root, after)
          activatedCandidate = undefined
          return Object.freeze({ state: after, installed: true, usedLastKnownGood: false, verified })
        } finally {
          await extracted.release()
        }
      } catch (error) {
        if (activatedCandidate && existsSync(activatedCandidate)) {
          const candidate = lstatSync(activatedCandidate)
          if (!candidate.isDirectory() || candidate.isSymbolicLink())
            throw new AggregateError([error], 'Computer Use failed candidate has unsafe identity')
          rmSync(activatedCandidate, { recursive: true, force: false })
        }
        signal.throwIfAborted()
        if (!healthyFallback) throw error
        const after = Object.freeze({
          schemaVersion: 1 as const,
          generation:
            before.generation + (before.active?.directory === healthyFallback.record.directory ? 0 : 1),
          active: healthyFallback.record,
          lastKnownGood: healthyFallback.record,
        })
        writeState(root, after)
        return Object.freeze({
          state: after,
          installed: false,
          usedLastKnownGood: true,
          verified: healthyFallback.verified,
        })
      }
    } finally {
      unlock()
    }
  })
}

export function readMacOSComputerUseDriverState(root: string): MacOSComputerUseDriverState {
  return readState(canonicalRoot(root))
}
