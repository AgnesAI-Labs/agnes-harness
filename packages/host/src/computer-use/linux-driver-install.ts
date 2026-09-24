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
  type ComputerUseHealthSelectors,
} from './health-report.js'
import {
  activateExtractedLinuxComputerUseDriver,
  extractLockedLinuxComputerUseDriver,
} from './linux-driver-archive.js'
import type { VerifiedLinuxComputerUseDriver } from './linux-driver-backend.js'
import { createLinuxComputerUseSessionRuntime } from './linux-driver-backend.js'
import { downloadLockedLinuxComputerUseDriver } from './linux-driver-download.js'
import { verifyLinuxComputerUseDriver } from './linux-driver-verifier.js'

const STATE_FILE = 'activation.json'
const STATE_MAX_BYTES = 32 * 1024
const LOCK_MAX_BYTES = 1024 * 1024
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const INSTALL_SERIALIZATION_LOCK = '.install-mutation-lock.db'
const queues = new Map<string, Promise<void>>()

export type LinuxComputerUseDriverRecord = Readonly<{
  version: string
  sourceTag: string
  sourceCommit: string
  archiveSha256: string
  directory: string
  architecture: 'arm64' | 'x86_64'
  provenanceIssuer: string
  provenanceSubject: string
}>

export type LinuxComputerUseDriverState = Readonly<{
  schemaVersion: 1
  generation: number
  active: LinuxComputerUseDriverRecord | null
  lastKnownGood: LinuxComputerUseDriverRecord | null
}>

export type LinuxComputerUseDriverInstallResult = Readonly<{
  state: LinuxComputerUseDriverState
  installed: boolean
  usedLastKnownGood: boolean
  verified: VerifiedLinuxComputerUseDriver
}>

export type LinuxComputerUseDriverInstallDependencies = Readonly<{
  download?: typeof downloadLockedLinuxComputerUseDriver
  extract?: typeof extractLockedLinuxComputerUseDriver
  activate?: typeof activateExtractedLinuxComputerUseDriver
  verify?: typeof verifyLinuxComputerUseDriver
  health?: (driver: VerifiedLinuxComputerUseDriver, signal: AbortSignal) => Promise<void>
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
  // Validate identity before chmod: chmod follows symlinks on Linux and must never mutate an
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

function record(value: unknown): LinuxComputerUseDriverRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use Linux activation record is invalid')
  const row = value as Record<string, unknown>
  if (
    JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify(
        [
          'archiveSha256',
          'architecture',
          'directory',
          'provenanceIssuer',
          'provenanceSubject',
          'sourceCommit',
          'sourceTag',
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
    (row.architecture !== 'arm64' && row.architecture !== 'x86_64') ||
    typeof row.provenanceIssuer !== 'string' ||
    !row.provenanceIssuer ||
    typeof row.provenanceSubject !== 'string' ||
    !row.provenanceSubject
  )
    throw new Error('Computer Use Linux activation record is invalid')
  return Object.freeze(row as LinuxComputerUseDriverRecord)
}

function state(value: unknown): LinuxComputerUseDriverState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Computer Use Linux activation state is invalid')
  const row = value as Record<string, unknown>
  if (
    JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify(['active', 'generation', 'lastKnownGood', 'schemaVersion'].sort()) ||
    row.schemaVersion !== 1 ||
    !Number.isSafeInteger(row.generation) ||
    (row.generation as number) < 0
  )
    throw new Error('Computer Use Linux activation state is invalid')
  return Object.freeze({
    schemaVersion: 1,
    generation: row.generation as number,
    active: row.active === null ? null : record(row.active),
    lastKnownGood: row.lastKnownGood === null ? null : record(row.lastKnownGood),
  })
}

function readState(root: string): LinuxComputerUseDriverState {
  const path = join(root, STATE_FILE)
  if (!existsSync(path))
    return Object.freeze({ schemaVersion: 1, generation: 0, active: null, lastKnownGood: null })
  const text = readPrivate(path, STATE_MAX_BYTES)
  const checked = state(JSON.parse(text) as unknown)
  if (text !== `${JSON.stringify(checked, null, 2)}\n`)
    throw new Error('Computer Use Linux activation state is not canonical JSON')
  return checked
}

function writeState(root: string, value: LinuxComputerUseDriverState): void {
  writePrivate(join(root, STATE_FILE), new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`))
}

function snapshotPath(root: string, value: LinuxComputerUseDriverRecord): string {
  return join(root, 'locks', `${value.directory}.json`)
}

function selectedArtifact(lock: ComputerUseDriverLock) {
  const runtimeArchitecture = createPlatform().snapshot().arch
  const architecture =
    runtimeArchitecture === 'x64' || runtimeArchitecture === 'x86_64'
      ? 'x86_64'
      : runtimeArchitecture === 'arm64'
        ? 'arm64'
        : undefined
  if (!architecture) return undefined
  return lock.artifacts.find(
    (artifact) => artifact.platform === 'linux' && artifact.architectures.includes(architecture),
  )
}

function matchesLock(value: LinuxComputerUseDriverRecord, lock: ComputerUseDriverLock): boolean {
  const artifact = selectedArtifact(lock)
  return (
    artifact !== undefined &&
    value.version === lock.source.tag.slice('cua-driver-rs-v'.length) &&
    value.sourceTag === lock.source.tag &&
    value.sourceCommit === lock.source.commit &&
    value.archiveSha256 === artifact.sha256
  )
}

function writeSnapshot(root: string, value: LinuxComputerUseDriverRecord, lock: ComputerUseDriverLock): void {
  if (!matchesLock(value, lock)) throw new Error('Computer Use Linux lock snapshot does not match record')
  const bytes = new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`)
  if (bytes.byteLength > LOCK_MAX_BYTES) throw new Error('Computer Use Linux lock snapshot is oversized')
  writePrivate(snapshotPath(root, value), bytes)
}

function readSnapshot(root: string, value: LinuxComputerUseDriverRecord): ComputerUseDriverLock {
  const text = readPrivate(snapshotPath(root, value), LOCK_MAX_BYTES)
  const inspected = inspectComputerUseDriverLock(JSON.parse(text) as unknown)
  if (
    !inspected.ok ||
    text !== `${JSON.stringify(inspected.lock, null, 2)}\n` ||
    !matchesLock(value, inspected.lock)
  )
    throw new Error('Computer Use Linux lock snapshot is invalid')
  return inspected.lock
}

function driverRecord(
  lock: ComputerUseDriverLock,
  directory: string,
  driver: VerifiedLinuxComputerUseDriver,
): LinuxComputerUseDriverRecord {
  const artifact = selectedArtifact(lock)
  if (!artifact) throw new Error('Computer Use lock has no Linux artifact')
  return Object.freeze({
    version: driver.version,
    sourceTag: lock.source.tag,
    sourceCommit: lock.source.commit,
    archiveSha256: artifact.sha256,
    directory,
    architecture: driver.architecture,
    provenanceIssuer: driver.provenanceIssuer,
    provenanceSubject: driver.provenanceSubject,
  })
}

export async function probeLinuxComputerUseDriverHealth(
  driver: VerifiedLinuxComputerUseDriver,
  signal: AbortSignal,
  selectors?: ComputerUseHealthSelectors,
): Promise<void> {
  const runtime = createLinuxComputerUseSessionRuntime(driver)
  const session = Object.freeze({ key: `health-${randomBytes(12).toString('hex')}`, lane: 'health' })
  const connection = await runtime.open(session, signal)
  try {
    for (const name of ['health_report', 'list_apps', 'list_windows', 'get_window_state'])
      if (!connection.catalog.has(name)) throw new Error(`Computer Use driver catalog lacks ${name}`)
    const params = selectors
      ? {
          ...(selectors.include ? { include: [...selectors.include] } : {}),
          ...(selectors.skip ? { skip: [...selectors.skip] } : {}),
        }
      : {}
    const result = await connection.call('health_report', params, { timeoutMs: 10_000, signal })
    if (selectors === undefined) assertComputerUseCoreHealth(result, 'linux', driver.version)
    else assertComputerUseDoctorHealth(result, 'linux', driver.version, selectors)
  } finally {
    try {
      await runtime.close(session, 'session_end')
    } finally {
      await runtime.dispose()
    }
  }
}

/** Re-proves locked provenance, filesystem identity and version before a live health probe. */
export async function doctorLockedLinuxComputerUseDriver(input: {
  directory: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: Pick<LinuxComputerUseDriverInstallDependencies, 'verify' | 'health'>
  selectors?: ComputerUseHealthSelectors
}): Promise<VerifiedLinuxComputerUseDriver> {
  if (!isAbsolute(input.directory) || resolve(input.directory) !== input.directory)
    throw new Error('Computer Use Linux doctor driver directory must be canonical')
  const signal = input.signal ?? new AbortController().signal
  const verified = await (input.dependencies?.verify ?? verifyLinuxComputerUseDriver)(
    input.directory,
    input.lock,
  )
  const health = input.dependencies?.health ?? probeLinuxComputerUseDriverHealth
  await health(verified, signal, input.selectors ?? {})
  return verified
}

async function verifyRecord(
  root: string,
  value: LinuxComputerUseDriverRecord,
  lock: ComputerUseDriverLock,
  dependencies: LinuxComputerUseDriverInstallDependencies,
  signal: AbortSignal,
): Promise<VerifiedLinuxComputerUseDriver> {
  if (!matchesLock(value, lock)) throw new Error('Computer Use Linux driver does not match requested lock')
  const verified = await (dependencies.verify ?? verifyLinuxComputerUseDriver)(
    join(root, 'versions', value.directory),
    lock,
  )
  if (
    verified.version !== value.version ||
    verified.archiveSha256 !== value.archiveSha256 ||
    verified.architecture !== value.architecture ||
    verified.provenanceIssuer !== value.provenanceIssuer ||
    verified.provenanceSubject !== value.provenanceSubject
  )
    throw new Error('Computer Use Linux installed identity changed')
  await (dependencies.health ?? probeLinuxComputerUseDriverHealth)(verified, signal)
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
  // Refuse an unexpected entry instead of recursively deleting a concurrently replaced tree.
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
      throw new Error('Computer Use Linux installation serialization lock is unsafe')
  }
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    database.close()
    const code = (error as { errcode?: unknown }).errcode
    if (code === 5 || code === 6) throw new Error('Computer Use Linux installation is already in progress')
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
  dependencies: LinuxComputerUseDriverInstallDependencies,
): () => void {
  const path = join(root, '.install-lock')
  const ownerNonce = randomUUID()
  const now = (dependencies.clock ?? Date.now)()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('Computer Use Linux installation clock is invalid')
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
      throw new Error('Computer Use Linux installation is already in progress')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Computer Use Linux installation lock is unsafe')
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
      throw new Error('Computer Use Linux stale installation lock is unsafe')
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
        throw new Error('Computer Use Linux installation lock ownership changed')
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Computer Use Linux installation lock identity changed')
      const released = join(root, `.released-install-lock-${ownerNonce}`)
      renameSync(path, released)
      const moved = lstatSync(released)
      if (!moved.isDirectory() || moved.isSymbolicLink())
        throw new Error('Computer Use Linux released installation lock is unsafe')
      removeOwnedInstallLock(released)
    } finally {
      releaseSerialization()
    }
  }
}

/** Installs or repairs a locked Linux driver; activation changes only after signature + health pass. */
export async function installOrUpdateLockedLinuxComputerUseDriver(input: {
  root: string
  lock: ComputerUseDriverLock
  signal?: AbortSignal
  dependencies?: LinuxComputerUseDriverInstallDependencies
}): Promise<LinuxComputerUseDriverInstallResult> {
  const root = canonicalRoot(input.root)
  const dependencies = input.dependencies ?? {}
  const signal = input.signal ?? new AbortController().signal
  if (createPlatform().os !== 'linux' && !input.dependencies)
    throw new Error('Linux Computer Use driver installation is unavailable on this platform')
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
        | Readonly<{ record: LinuxComputerUseDriverRecord; verified: VerifiedLinuxComputerUseDriver }>
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
        const bytes = await (dependencies.download ?? downloadLockedLinuxComputerUseDriver)(input.lock, {
          signal,
        })
        const extracted = await (dependencies.extract ?? extractLockedLinuxComputerUseDriver)({
          archiveBytes: bytes,
          stagingParent: join(root, 'staging'),
          lock: input.lock,
          signal,
        })
        const directory = `${extracted.verified.version}-${randomUUID()}`
        try {
          activatedCandidate = join(root, 'versions', directory)
          ;(dependencies.activate ?? activateExtractedLinuxComputerUseDriver)(extracted, activatedCandidate)
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

export function readLinuxComputerUseDriverState(root: string): LinuxComputerUseDriverState {
  return readState(canonicalRoot(root))
}
