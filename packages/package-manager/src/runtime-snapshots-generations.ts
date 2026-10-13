import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { publishFileDurablySync, removeFileDurablySync } from '@agnes/system-node'
import { copyPackageTreeSync } from './copy-tree.js'
import { syncDirectory } from './integrity.js'
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'
import {
  corrupt,
  DurableStateError,
  decodeGenerationRecord,
  decodeHeadRecord,
  decodeSessionPin,
  GENERATION_ID_PATTERN,
  parseRecord,
  sessionPinFileName,
} from './runtime-snapshots-decode.js'
import {
  type RuntimeGenerationResourceInput,
  type RuntimeGenerationResourceSnapshot,
  readGenerationResources,
  writeGenerationResources,
} from './runtime-snapshots-resources.js'
import { hashDirectory } from './sources.js'

// Durable record publication is shared by every module that keeps recoverable state beside generations.
export { publishFileDurablySync, removeFileDurablySync } from '@agnes/system-node'
export { DurableStateError } from './runtime-snapshots-decode.js'

const OWNER_FILE = 'owner.json'
const ADOPTERS_DIR = 'adopters'
const UNOWNED_GRACE_MS = 10 * 60_000
const PIN_LOCK_STALE_MS = 30_000
const PIN_LOCK_WAIT_MS = 10_000

/** A process recorded as holding a generation: its pid, and its start identity when one was known. */
type Holder = Readonly<{ pid: number; startId?: string }>

/**
 * How a store tells whether a recorded holder still runs. `startId` identifies this process beyond
 * its pid, so a reused pid is not mistaken for the holder. Without one a store records and compares
 * bare pids, which can only keep a generation longer than needed, never remove one early.
 */
export type ProcessLiveness = Readonly<{
  startId: string
  /** False only when the process is gone or the pid now belongs to another process; unknown counts as running. */
  isRunning(pid: number, startId: string): Promise<boolean>
}>

export type StateProblem = Readonly<{ file: string; reason: string }>

function parseHolder(bytes: string): Holder | undefined {
  try {
    const value = JSON.parse(bytes) as { pid?: unknown; startId?: unknown } | null
    if (!value || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined
    return {
      pid: value.pid as number,
      ...(typeof value.startId === 'string' && value.startId ? { startId: value.startId } : {}),
    }
  } catch {
    return undefined
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Atomics.wait is unavailable; a short spin covers a contended lock.
    }
  }
}
/** The seam selections a generation's container is compiled from, with the format they were written in. */
export type GenerationSeams = Readonly<{
  formatVersion: 1
  selections: Readonly<Record<string, Readonly<{ provider: string; version?: string }>>>
}>
/**
 * The implementation a session was bound to for one pinned seam kind. Everything needed to explain
 * and re-check the pin is stored; nothing has to be reconstructed later.
 */
export type PinnedSeam = Readonly<{
  kind: string
  provider: string
  version: string
  sourcePackage: string
  /** Package integrity of the code that supplied the provider (the immutable snapshot for third parties). */
  integrity: string
}>
/** Monotonic format of one session pin record. */
export const SESSION_PIN_FORMAT_VERSION = 1
export const GENERATION_SNAPSHOT_VERSION = 3

export type PluginGenerationSnapshot = Readonly<{
  version?: 1 | 2 | 3
  /** Present on every snapshot a session can resume; older formats carry none. */
  seams?: GenerationSeams
  id: string
  artifact: RuntimeTargetArtifact
  sources: readonly RuntimePluginSnapshot[]
  packages: readonly Readonly<{ id: string; version: string }>[]
  compatibility: string
  resourcesDigest?: string
  resources?: RuntimeGenerationResourceSnapshot
}>
export type SessionGenerationPin = Readonly<{
  /** Monotonic integer of the format the pin was written in. */
  formatVersion: number
  sessionKey: string
  generationId: string
  /**
   * The pinned seam implementations, recorded at the session's first binding. Every readable pin
   * carries them; only the key and generation of a pin written by a newer AGH are decoded.
   */
  seams?: readonly PinnedSeam[]
  loop?: Readonly<{ id: string; version: string }>
  resourcesDigest?: string
}>

/** Durable session pins and immutable package copies, independent of mutable installation state. */
export class RuntimeGenerationSnapshotStore {
  readonly root: string
  readonly #created = new Set<string>()
  readonly #token = randomUUID()
  readonly #liveness: ProcessLiveness | undefined
  #problems: StateProblem[] = []
  constructor(profileDirectory: string, options: { liveness?: ProcessLiveness | undefined } = {}) {
    this.root = join(profileDirectory, '.runtime-generations')
    this.#liveness = options.liveness
  }

  private directory(id: string): string {
    if (!GENERATION_ID_PATTERN.test(id)) throw new Error('E_GENERATION_ID: invalid generation id')
    return join(this.root, id)
  }

  /** Creates a subdirectory of the root and makes its entry durable, so records published inside it outlive power loss. */
  #ensure(name: string): string {
    const directory = join(this.root, name)
    if (mkdirSync(directory, { recursive: true, mode: 0o700 }) !== undefined) {
      syncDirectory(this.root)
      syncDirectory(join(this.root, '..'))
    }
    return directory
  }

  #holder(): Holder {
    return { pid: process.pid, ...(this.#liveness ? { startId: this.#liveness.startId } : {}) }
  }

  create(
    target: RuntimeTarget,
    sources: readonly RuntimePluginSnapshot[],
    compatibility: string,
    packages: PluginGenerationSnapshot['packages'] = sources.map((source) => ({
      id: source.snapshot.packageId,
      version: source.snapshot.version,
    })),
    resources?: RuntimeGenerationResourceInput,
    seams?: GenerationSeams,
  ): PluginGenerationSnapshot {
    const id = randomUUID(),
      directory = this.directory(id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      // Written first so collection can tell a live creator from a dead one before generation.json exists.
      writeFileSync(join(directory, OWNER_FILE), JSON.stringify(this.#holder()), { mode: 0o600, flush: true })
      const copied = sources.map((source, index) => {
        if (!source.trusted) throw new Error('E_GENERATION_UNTRUSTED: snapshot is not trusted')
        const destination = join(directory, String(index))
        copyPackageTreeSync(source.snapshot.directory, destination)
        if (hashDirectory(destination, { exclude: [] }) !== source.snapshot.treeIntegrity)
          throw new Error('E_GENERATION_INTEGRITY: package snapshot changed')
        return { ...source, snapshot: { ...source.snapshot, directory: String(index) } }
      })
      const resourcesDigest = resources
        ? writeGenerationResources(join(directory, 'resources'), resources)
        : undefined
      publishFileDurablySync(
        join(directory, 'generation.json'),
        JSON.stringify({
          version: seams ? GENERATION_SNAPSHOT_VERSION : resources ? 2 : 1,
          ...(seams ? { seams } : {}),
          id,
          artifact: encodeRuntimeTargetArtifact(target),
          sources: copied,
          packages,
          compatibility,
          ...(resourcesDigest ? { resourcesDigest } : {}),
        }),
        { replace: true },
      )
      // The directory entry itself must be durable before any pin or head may name this generation.
      syncDirectory(this.root)
      this.#created.add(id)
      this.#adopt(id)
      return this.read(id)
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  read(id: string): PluginGenerationSnapshot {
    const directory = this.directory(id),
      file = join(directory, 'generation.json')
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${id} cannot be resumed`)
    }
    const record = decodeGenerationRecord(parseRecord(text, file), id, file, GENERATION_SNAPSHOT_VERSION)
    const sources = record.sources.map((source, index) => {
      const snapshot = { ...source.snapshot, directory: join(directory, String(index)) }
      if (hashDirectory(snapshot.directory, { exclude: [] }) !== snapshot.treeIntegrity)
        throw corrupt(file, `package snapshot ${index} is unavailable or changed`)
      return Object.freeze({ ...source, snapshot: Object.freeze(snapshot) })
    })
    return Object.freeze({
      ...record,
      ...(record.resourcesDigest
        ? { resources: readGenerationResources(join(directory, 'resources'), record.resourcesDigest) }
        : {}),
      sources: Object.freeze(sources),
      packages: Object.freeze(record.packages.map((pkg) => Object.freeze(pkg))),
    })
  }

  /** Accepted live config is mutable generation state, separate from the immutable code archive. */
  liveConfig(id: string): RuntimeTargetArtifact | undefined {
    const path = join(this.directory(id), 'live-config.json')
    if (!existsSync(path)) return undefined
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as {
        generationId: string
        artifact: RuntimeTargetArtifact
      }
      if (record.generationId !== id) throw new Error('generation binding mismatch')
      decodeRuntimeTargetArtifact(record.artifact)
      return Object.freeze(record.artifact)
    } catch (cause) {
      throw Object.assign(
        new DurableStateError(
          'E_GENERATION_CONFIG_INTEGRITY',
          'accepted configuration cannot be restored',
          path,
        ),
        { cause },
      )
    }
  }

  /** Called after Host accepts config; callers compensate this record along with their live apply. */
  saveLiveConfig(id: string, artifact: RuntimeTargetArtifact | undefined): void {
    const directory = this.directory(id),
      path = join(directory, 'live-config.json')
    if (!existsSync(join(directory, 'generation.json')))
      throw new Error('E_GENERATION_SNAPSHOT_MISSING: configuration generation is unavailable')
    if (artifact) {
      decodeRuntimeTargetArtifact(artifact)
      publishFileDurablySync(path, JSON.stringify({ generationId: id, artifact }), { replace: true })
    } else removeFileDurablySync(path)
  }

  private pinPath(sessionKey: string): string {
    return join(this.root, 'sessions', sessionPinFileName(sessionKey))
  }

  /** Binds the session's first generation. A pin already published by another worker wins and is returned. */
  pin(sessionKey: string, generationId: string, seams: readonly PinnedSeam[]): SessionGenerationPin {
    if (!existsSync(join(this.directory(generationId), 'generation.json')))
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot be bound`)
    this.#ensure('sessions')
    const pin: SessionGenerationPin = {
      formatVersion: SESSION_PIN_FORMAT_VERSION,
      sessionKey,
      generationId,
      seams,
    }
    return publishFileDurablySync(this.pinPath(sessionKey), JSON.stringify(pin))
      ? Object.freeze(pin)
      : (this.session(sessionKey) as SessionGenerationPin)
  }

  /**
   * Whether a pin file exists for the session whose key has this sha256 digest, without reading it.
   * Anything other than a definite absence counts as present, so an unreadable pin is never "no pin".
   */
  pinFileState(sessionKeyDigest: string): 'present' | 'absent' {
    try {
      statSync(join(this.root, 'sessions', `${sessionKeyDigest}.json`))
      return 'present'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'present'
    }
  }

  session(sessionKey: string): SessionGenerationPin | undefined {
    const path = this.pinPath(sessionKey)
    let bytes: string
    try {
      bytes = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw corrupt(path, 'session pin cannot be read')
    }
    return Object.freeze(
      decodeSessionPin(parseRecord(bytes, path), path, {
        allowNewer: false,
        currentFormat: SESSION_PIN_FORMAT_VERSION,
      }),
    )
  }

  /**
   * Every readable pin. One session that cannot be read here (written by a newer AGH, or damaged)
   * must not hide the others or stop generation bookkeeping: a pin of a newer format still names its
   * generation and keeps it, and a damaged one is listed by `corruptEntries()` and makes collection
   * stand down altogether.
   */
  sessions(): readonly SessionGenerationPin[] {
    const directory = join(this.root, 'sessions')
    this.#problems = []
    if (!existsSync(directory)) return []
    const pins: SessionGenerationPin[] = []
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      const file = join(directory, name)
      try {
        pins.push(
          Object.freeze(
            decodeSessionPin(parseRecord(readFileSync(file, 'utf8'), file), file, {
              allowNewer: true,
              currentFormat: SESSION_PIN_FORMAT_VERSION,
            }),
          ),
        )
      } catch (error) {
        this.#problems.push({
          file,
          reason: error instanceof DurableStateError ? error.message : `${name}: cannot be read`,
        })
      }
    }
    return pins
  }

  /** The damaged durable entries found by the latest `sessions()` or `collect()`, each with its file. */
  corruptEntries(): readonly StateProblem[] {
    return this.#problems
  }

  /**
   * Serializes read-modify-write of one pin (and its release) across workers. The critical section is a single small
   * read and publish, so a lock older than `PIN_LOCK_STALE_MS` belongs to a crashed worker and is removed.
   */
  #lockedPin<T>(sessionKey: string, body: () => T): T {
    const lock = `${this.pinPath(sessionKey)}.lock`,
      started = Date.now()
    this.#ensure('sessions')
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let stale = false
        try {
          stale = Date.now() - statSync(lock).mtimeMs > PIN_LOCK_STALE_MS
        } catch {
          continue
        }
        if (stale) rmSync(lock, { recursive: true, force: true })
        else if (Date.now() - started > PIN_LOCK_WAIT_MS)
          throw new DurableStateError(
            'E_GENERATION_PIN_BUSY',
            `session pin is locked by another worker; remove ${lock} if no AGH process is running`,
            lock,
          )
        else pause(5)
      }
    }
    try {
      return body()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }

  #replacePin(pin: SessionGenerationPin): SessionGenerationPin {
    publishFileDurablySync(this.pinPath(pin.sessionKey), JSON.stringify(pin), { replace: true })
    return Object.freeze(pin)
  }

  recordLoop(sessionKey: string, loop: Readonly<{ id: string; version: string }>): void {
    this.#lockedPin(sessionKey, () => {
      const pin = this.session(sessionKey)
      if (!pin) throw new Error('E_GENERATION_PIN_MISSING: session is not bound')
      if (pin.loop && (pin.loop.id !== loop.id || pin.loop.version !== loop.version))
        throw new Error('E_GENERATION_LOOP_INCOMPATIBLE: session loop differs from its generation pin')
      this.#replacePin({ ...pin, loop })
    })
  }

  /** Coordinator-owned idle migration. Admission must be excluded while replacing this pin. */
  migrateSession(
    sessionKey: string,
    expectedGenerationId: string,
    generationId: string,
    seams?: readonly PinnedSeam[],
  ): SessionGenerationPin {
    return this.#lockedPin(sessionKey, () => {
      const pin = this.session(sessionKey)
      if (!pin || pin.generationId !== expectedGenerationId)
        throw new Error('E_GENERATION_BINDING_CONFLICT: session pin changed before migration')
      if (this.read(pin.generationId).compatibility !== this.read(generationId).compatibility)
        throw new Error('E_GENERATION_INCOMPATIBLE: session migration needs a compatible deployment')
      return this.#replacePin({
        formatVersion: SESSION_PIN_FORMAT_VERSION,
        sessionKey,
        generationId,
        seams: seams ?? (pin.seams as readonly PinnedSeam[]),
        ...(pin.loop ? { loop: pin.loop } : {}),
      })
    })
  }

  sessionResources(key: string): RuntimeGenerationResourceSnapshot | undefined {
    const pin = this.session(key)
    if (!pin?.resourcesDigest) return undefined
    return readGenerationResources(
      join(
        this.directory(pin.generationId),
        'session-resources',
        createHash('sha256').update(key).digest('hex'),
      ),
      pin.resourcesDigest,
    )
  }

  pinSessionResources(
    key: string,
    resources: RuntimeGenerationResourceInput,
  ): RuntimeGenerationResourceSnapshot {
    const existing = this.sessionResources(key)
    if (existing) return existing
    const pin = this.session(key)
    if (!pin) throw new Error('E_GENERATION_PIN_MISSING: session is not bound')
    const directory = join(
      this.directory(pin.generationId),
      'session-resources',
      createHash('sha256').update(key).digest('hex'),
    )
    const temporary = `${directory}.${randomUUID()}.tmp`
    try {
      const resourcesDigest = writeGenerationResources(temporary, resources)
      return this.#lockedPin(key, () => {
        const current = this.session(key)
        if (!current) throw new Error('E_GENERATION_PIN_MISSING: session is not bound')
        // Another worker may have pinned resources, or migrated the session, while ours were written.
        if (current.generationId !== pin.generationId)
          throw new Error('E_GENERATION_BINDING_CONFLICT: session pin changed before resources were pinned')
        if (current.resourcesDigest) return this.sessionResources(key) as RuntimeGenerationResourceSnapshot
        rmSync(directory, { recursive: true, force: true })
        renameSync(temporary, directory)
        syncDirectory(join(directory, '..'))
        this.#replacePin({ ...current, resourcesDigest })
        return this.sessionResources(key) as RuntimeGenerationResourceSnapshot
      })
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  /** Call only after the session has been deleted, never on close or hibernation. */
  releaseSession(sessionKey: string): void {
    if (!existsSync(join(this.root, 'sessions'))) return
    this.#lockedPin(sessionKey, () => removeFileDurablySync(this.pinPath(sessionKey)))
  }

  /**
   * Registers this store as a holder of the generation. A holder is a worker that may accept sessions
   * on it without a durable pin, so no other worker's collection may remove it while that process lives.
   */
  #adopt(id: string): void {
    const directory = join(this.directory(id), ADOPTERS_DIR)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    publishFileDurablySync(join(directory, this.#token), JSON.stringify(this.#holder()), { replace: true })
  }

  #release(id: string): void {
    rmSync(join(this.directory(id), ADOPTERS_DIR, this.#token), { force: true })
  }

  async #running(holder: Holder): Promise<boolean> {
    if (holder.startId !== undefined && this.#liveness) {
      try {
        return await this.#liveness.isRunning(holder.pid, holder.startId)
      } catch {
        return true
      }
    }
    return pidExists(holder.pid)
  }

  /** Whether a different store (worker) still holds the generation; an unreadable record counts while young. */
  async #heldByOther(id: string): Promise<boolean> {
    const directory = join(this.directory(id), ADOPTERS_DIR)
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return false
    }
    for (const name of names) {
      if (name === this.#token) continue
      const path = join(directory, name)
      let holder: Holder | undefined
      try {
        holder = parseHolder(readFileSync(path, 'utf8'))
      } catch {
        continue
      }
      if (!holder) {
        try {
          if (Date.now() - statSync(path).mtimeMs < UNOWNED_GRACE_MS) return true
        } catch {}
        continue
      }
      if (await this.#running(holder)) return true
    }
    return false
  }

  /** Unreadable owner metadata counts as live until the directory is old enough that no creator can still be writing it. */
  private async ownerMayBeLive(id: string): Promise<boolean> {
    const directory = this.directory(id),
      young = () => {
        try {
          return Date.now() - statSync(directory).mtimeMs < UNOWNED_GRACE_MS
        } catch {
          return false
        }
      }
    let holder: Holder | undefined
    try {
      holder = parseHolder(readFileSync(join(directory, OWNER_FILE), 'utf8'))
    } catch {
      return young()
    }
    return holder ? this.#running(holder) : young()
  }

  private headPath(compositionKey: string): string {
    return join(this.root, 'heads', `${createHash('sha256').update(compositionKey).digest('hex')}.json`)
  }

  /** Durable current head of one composition, so workers that start later agree on it. */
  setHead(compositionKey: string, generationId: string): void {
    this.directory(generationId)
    if (!existsSync(join(this.directory(generationId), 'generation.json')))
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot become the head`)
    this.#ensure('heads')
    publishFileDurablySync(this.headPath(compositionKey), JSON.stringify({ compositionKey, generationId }), {
      replace: true,
    })
  }

  headId(compositionKey: string): string | undefined {
    const file = this.headPath(compositionKey)
    try {
      return decodeHeadRecord(parseRecord(readFileSync(file, 'utf8'), file), compositionKey, file)
    } catch {
      return undefined
    }
  }

  /**
   * The recorded head when it was built from exactly these inputs, else undefined. Anything unreadable,
   * missing or different means the caller snapshots afresh; a pointer is a shortcut, never an authority.
   */
  reusableHead(
    compositionKey: string,
    expected: Readonly<{
      artifactDigest: string
      compatibility: string
      packages: PluginGenerationSnapshot['packages']
      resourcesDigest?: string
      seams?: GenerationSeams
    }>,
  ): PluginGenerationSnapshot | undefined {
    const id = this.headId(compositionKey)
    if (!id) return undefined
    try {
      const snapshot = this.read(id)
      if (
        snapshot.artifact.digest !== expected.artifactDigest ||
        snapshot.compatibility !== expected.compatibility ||
        snapshot.resourcesDigest !== expected.resourcesDigest ||
        JSON.stringify(snapshot.packages) !== JSON.stringify(expected.packages) ||
        JSON.stringify(snapshot.seams ?? null) !== JSON.stringify(expected.seams ?? null)
      )
        return undefined
      // Register before trusting the head, then confirm the record survived a concurrent collection.
      this.#adopt(id)
      return this.read(id)
    } catch {
      return undefined
    }
  }

  /**
   * Removes generations nothing can still reach. Anything this store cannot read and so cannot prove
   * unreferenced (a damaged pin or head, listed by `corruptEntries()`) stops the whole pass.
   */
  async collect(
    keep: ReadonlySet<string>,
    retired: ReadonlySet<string> = new Set(),
  ): Promise<readonly string[]> {
    if (!existsSync(this.root)) return []
    const referenced = new Set(this.sessions().map((pin) => pin.generationId)),
      removed: string[] = []
    // A recorded head outlives the worker that created it; the next worker to start reuses it.
    const heads = join(this.root, 'heads')
    for (const name of existsSync(heads)
      ? readdirSync(heads).filter((entry) => entry.endsWith('.json'))
      : []) {
      const file = join(heads, name)
      try {
        referenced.add(decodeHeadRecord(parseRecord(readFileSync(file, 'utf8'), file), undefined, file))
      } catch (error) {
        this.#problems.push({
          file,
          reason: error instanceof DurableStateError ? error.message : `${name}: cannot be read`,
        })
      }
    }
    if (this.#problems.length > 0) return []
    for (const id of readdirSync(this.root)) {
      // Another workspace worker may still be accepting sessions on its own snapshot.
      if (!GENERATION_ID_PATTERN.test(id) || keep.has(id)) continue
      this.#release(id)
      if (referenced.has(id) || (await this.#heldByOther(id))) continue
      if (!this.#created.has(id) && !retired.has(id) && (await this.ownerMayBeLive(id))) continue
      rmSync(this.directory(id), { recursive: true, force: true })
      removed.push(id)
      this.#created.delete(id)
    }
    if (removed.length) syncDirectory(this.root)
    return removed
  }
}
