import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import {
  mkdirDurablySync,
  publishFileDurablySync,
  removeFileDurablySync,
  syncDirectorySync,
  syncTreeBatchedSync,
} from '@agnes/system-node'
import {
  acquireOwnerFileLock,
  pidExists,
  readLockOwner,
  releaseOwnerFileLock,
  takeOverOwnerFileLock,
} from '@agnes/system-node/owner-lock'
import { collectRead, collectReadAsync, directoryDigestSteps, type ReadSteps } from './cooperative-read.js'
import { clonePackageTreeSync } from './copy-tree.js'
import { type GenerationReuseInputs, matchesGenerationBuildInputs } from './generation-equivalence.js'
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
  readGenerationResourcesSteps,
  writeGenerationResources,
} from './runtime-snapshots-resources.js'
import { withoutPackageVerification } from './verification-operation.js'

// Durable record publication is shared by every module that keeps recoverable state beside generations.
export { mkdirDurablySync, publishFileDurablySync, removeFileDurablySync } from '@agnes/system-node'
export { DurableStateError } from './runtime-snapshots-decode.js'

const OWNER_FILE = 'owner.json'
const ADOPTERS_DIR = 'adopters'
const UNOWNED_GRACE_MS = 10 * 60_000
const PIN_LOCK_WAIT_MS = 10_000
/** Heads this store replaced, per composition, kept as publication reuse candidates (newest first). */
const REPLACED_HEADS = 8
/** A generation directory being removed is first renamed to `<id>.deleting-<ms>-<token>`. */
const CLAIM_PATTERN = /^([a-f0-9-]{36})\.deleting-(\d+)-/

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
  readonly #anchor: string
  readonly #lockWaitMs: number
  readonly #replacedHeads = new Map<string, string[]>()
  #problems: StateProblem[] = []
  constructor(
    profileDirectory: string,
    options: { liveness?: ProcessLiveness | undefined; lockWaitMs?: number } = {},
  ) {
    this.root = join(profileDirectory, '.runtime-generations')
    this.#anchor = dirname(profileDirectory)
    this.#liveness = options.liveness
    this.#lockWaitMs = options.lockWaitMs ?? PIN_LOCK_WAIT_MS
  }

  private directory(id: string): string {
    if (!GENERATION_ID_PATTERN.test(id)) throw new Error('E_GENERATION_ID: invalid generation id')
    return join(this.root, id)
  }

  /** Creates a subdirectory of the root and makes its entry durable, so records published inside it outlive power loss. */
  #ensure(name: string): string {
    const directory = join(this.root, name)
    mkdirDurablySync(directory, this.#anchor)
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
    return withoutPackageVerification(() =>
      collectRead(this.createSteps(target, sources, compatibility, packages, resources, seams)),
    )
  }

  /** Same publication checks and durability order, with bounded cooperative hashing. */
  async createAsync(
    ...args: Parameters<RuntimeGenerationSnapshotStore['create']>
  ): Promise<PluginGenerationSnapshot> {
    // A caller may retain mutable arrays/records; a yield must not change the admitted build inputs.
    const captured = structuredClone(args)
    return withoutPackageVerification(() => collectReadAsync(this.createSteps(...captured)))
  }

  private *createSteps(
    ...args: Parameters<RuntimeGenerationSnapshotStore['create']>
  ): ReadSteps<PluginGenerationSnapshot> {
    const [
      target,
      sources,
      compatibility,
      packages = sources.map((source) => ({
        id: source.snapshot.packageId,
        version: source.snapshot.version,
      })),
      resources,
      seams,
    ] = args
    const id = randomUUID(),
      directory = this.directory(id)
    mkdirDurablySync(directory, this.#anchor)
    try {
      // Written first so collection can tell a live creator from a dead one before generation.json exists.
      writeFileSync(join(directory, OWNER_FILE), JSON.stringify(this.#holder()), {
        mode: 0o600,
        flush: true,
      })
      const destinations: string[] = []
      const copied: RuntimePluginSnapshot[] = []
      for (const [index, source] of sources.entries()) {
        if (!source.trusted) throw new Error('E_GENERATION_UNTRUSTED: snapshot is not trusted')
        const destination = join(directory, String(index))
        destinations.push(destination)
        // Clone independent bytes, then verify the destination at this write gate. A prior
        // Worker read cannot attest a new archive, even when the source root inode still matches.
        clonePackageTreeSync(source.snapshot.directory, destination)
        if ((yield* directoryDigestSteps(destination, source.snapshot)) !== source.snapshot.treeIntegrity)
          throw new Error('E_GENERATION_INTEGRITY: package snapshot changed')
        copied.push({ ...source, snapshot: { ...source.snapshot, directory: String(index) } })
      }
      // One drive flush for every copied tree, before anything names them.
      syncTreeBatchedSync(...destinations)
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
      // These independent destination trees were freshly checked above; read-back validates the record.
      const snapshot = yield* this.readSteps(id, new Set(sources.keys()))
      this.#created.add(id)
      this.#adopt(id)
      return snapshot
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  read(id: string): PluginGenerationSnapshot {
    return collectRead(this.readSteps(id))
  }

  /** Display metadata only; never supplies executable sources or proves that an archive can resume. */
  describe(id: string): Pick<PluginGenerationSnapshot, 'id' | 'packages'> {
    const file = join(this.directory(id), 'generation.json')
    const record = decodeGenerationRecord(
      parseRecord(readFileSync(file, 'utf8'), file),
      id,
      file,
      GENERATION_SNAPSHOT_VERSION,
    )
    return Object.freeze({ id: record.id, packages: record.packages })
  }

  /** Same integrity checks as read(), with cooperative file hashing for read-only status. */
  readAsync(id: string): Promise<PluginGenerationSnapshot> {
    return collectReadAsync(this.readSteps(id))
  }

  /** `checked` names source indexes the caller verified within this same create. */
  private *readSteps(
    id: string,
    checked: ReadonlySet<number> = new Set(),
  ): ReadSteps<PluginGenerationSnapshot> {
    const directory = this.directory(id),
      file = join(directory, 'generation.json')
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${id} cannot be resumed`)
    }
    const record = decodeGenerationRecord(parseRecord(text, file), id, file, GENERATION_SNAPSHOT_VERSION)
    const sources: RuntimePluginSnapshot[] = []
    for (const [index, source] of record.sources.entries()) {
      const snapshot = { ...source.snapshot, directory: join(directory, String(index)) }
      if (
        !checked.has(index) &&
        (yield* directoryDigestSteps(snapshot.directory, snapshot)) !== snapshot.treeIntegrity
      )
        throw corrupt(file, `package snapshot ${index} is unavailable or changed`)
      sources.push(Object.freeze({ ...source, snapshot: Object.freeze(snapshot) }))
    }
    const resources = record.resourcesDigest
      ? yield* readGenerationResourcesSteps(join(directory, 'resources'), record.resourcesDigest)
      : undefined
    return Object.freeze({
      ...record,
      ...(resources ? { resources } : {}),
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
    if (!publishFileDurablySync(this.pinPath(sessionKey), JSON.stringify(pin)))
      return this.session(sessionKey) as SessionGenerationPin
    this.#confirmPresent(generationId, () => removeFileDurablySync(this.pinPath(sessionKey)))
    return Object.freeze(pin)
  }

  /**
   * Collection claims a generation by renaming its directory before it looks at references again, so a
   * reference published after the claim finds the generation gone here and is withdrawn by `undo`;
   * one published before it is seen by the collector, which then restores the directory.
   */
  #confirmPresent(generationId: string, undo: () => void): void {
    if (existsSync(join(this.directory(generationId), 'generation.json'))) return
    undo()
    throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot be bound`)
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

  /** Scans every pin and head afresh and lists the damaged ones; collection stands down while any exists. */
  scanDamage(): readonly StateProblem[] {
    this.#references()
    return this.#problems
  }

  /**
   * Serializes read-modify-write of one pin (and its release) across workers. The lock is a file
   * published already holding its owner (pid, start identity, token), so it never exists unowned. It is
   * taken over only when its owner's pid is gone: age proves nothing about a worker that is paused or
   * waiting on a slow disk, so a live or unknown owner keeps the lock and contenders end in
   * `E_GENERATION_PIN_BUSY`. Release removes the lock only while it still carries this holder's token.
   */
  #lockedPin<T>(sessionKey: string, body: () => T): T {
    const lock = `${this.pinPath(sessionKey)}.lock`,
      deadline = Date.now() + this.#lockWaitMs,
      owner = { ...this.#holder(), token: randomUUID() }
    this.#ensure('sessions')
    for (;;) {
      if (acquireOwnerFileLock(lock, owner)) break
      const held = readLockOwner(lock)
      if (held && !pidExists(held.pid)) takeOverOwnerFileLock(lock, held.token)
      else if (Date.now() > deadline)
        throw new DurableStateError(
          'E_GENERATION_PIN_BUSY',
          held
            ? `session pin is locked by process ${held.pid}; wait for it, or remove ${lock} once that process is gone`
            : `session pin lock ${lock} has no readable owner; remove it if no AGH process is running`,
          lock,
        )
      else pause(5)
    }
    try {
      return body()
    } finally {
      releaseOwnerFileLock(lock, owner.token)
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
      if (pin.loop) return
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
      const migrated = this.#replacePin({
        formatVersion: SESSION_PIN_FORMAT_VERSION,
        sessionKey,
        generationId,
        seams: seams ?? (pin.seams as readonly PinnedSeam[]),
        ...(pin.loop ? { loop: pin.loop } : {}),
      })
      this.#confirmPresent(generationId, () => this.#replacePin(pin))
      return migrated
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
    mkdirDurablySync(join(directory, '..'), this.directory(pin.generationId))
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
        syncDirectorySync(join(directory, '..'))
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
    // Never created recursively: a generation claimed by a collector must stay gone. An adopter file is
    // published inside the generation's own directory, so a claim either sees it or fails this call.
    const generation = this.directory(id)
    try {
      mkdirDurablySync(join(generation, ADOPTERS_DIR), generation)
      publishFileDurablySync(join(generation, ADOPTERS_DIR, this.#token), JSON.stringify(this.#holder()), {
        replace: true,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${id} was collected`)
      throw error
    }
  }

  #release(id: string): void {
    removeFileDurablySync(join(this.directory(id), ADOPTERS_DIR, this.#token))
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
  async #heldByOther(generation: string): Promise<boolean> {
    const directory = join(generation, ADOPTERS_DIR)
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
  private async ownerMayBeLive(directory: string): Promise<boolean> {
    const young = () => {
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
    const previous = this.headId(compositionKey),
      publish = (id: string) =>
        publishFileDurablySync(
          this.headPath(compositionKey),
          JSON.stringify({ compositionKey, generationId: id }),
          {
            replace: true,
          },
        )
    publish(generationId)
    this.#confirmPresent(generationId, () =>
      previous ? publish(previous) : removeFileDurablySync(this.headPath(compositionKey)),
    )
    if (previous && previous !== generationId) {
      const replaced = (this.#replacedHeads.get(compositionKey) ?? []).filter((id) => id !== previous)
      this.#replacedHeads.set(compositionKey, [previous, ...replaced].slice(0, REPLACED_HEADS))
    }
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
    expected: GenerationReuseInputs,
  ): PluginGenerationSnapshot | undefined {
    const id = this.headId(compositionKey)
    return id ? this.#reuse(id, expected) : undefined
  }

  /**
   * A generation already recorded from exactly these inputs, for a publication that would otherwise
   * snapshot the same code again. Candidates, in order: heads this store replaced for the composition
   * (a worker records its boot snapshot over the head the previous worker published), the recorded
   * head, then generations named by session pins. `exclude` holds generations the caller already runs
   * or saw fail, whose identity a publication must not take over. A candidate with accepted live
   * configuration is skipped: a container rebuilt from it would apply that configuration, not the
   * published one. Recorded fields are compared before any package tree is re-hashed.
   */
  reusableGeneration(
    compositionKey: string,
    expected: GenerationReuseInputs,
    exclude: ReadonlySet<string>,
  ): PluginGenerationSnapshot | undefined {
    const candidates = new Set([
      ...(this.#replacedHeads.get(compositionKey) ?? []),
      this.headId(compositionKey),
      ...this.sessions().map((pin) => pin.generationId),
    ])
    for (const id of candidates) {
      if (!id || exclude.has(id) || !this.#recorded(id, expected)) continue
      if (existsSync(join(this.directory(id), 'live-config.json'))) continue
      const reused = this.#reuse(id, expected)
      if (reused) return reused
    }
    return undefined
  }

  /** Whether `generation.json` alone names these inputs; anything unreadable is not a match. */
  #recorded(id: string, expected: GenerationReuseInputs): boolean {
    try {
      const file = join(this.directory(id), 'generation.json')
      const record = decodeGenerationRecord(
        parseRecord(readFileSync(file, 'utf8'), file),
        id,
        file,
        GENERATION_SNAPSHOT_VERSION,
      )
      return matchesGenerationBuildInputs(record, expected)
    } catch {
      return false
    }
  }

  /** The generation when it reads cleanly and was built from exactly these inputs, adopted; else undefined. */
  #reuse(id: string, expected: GenerationReuseInputs): PluginGenerationSnapshot | undefined {
    try {
      if (!matchesGenerationBuildInputs(this.read(id), expected)) return undefined
      // Register before trusting the generation, then confirm the record survived a concurrent collection.
      this.#adopt(id)
      return this.read(id)
    } catch {
      return undefined
    }
  }

  /**
   * The generations named by a pin or a head. Anything this store cannot read and so cannot prove
   * unreferenced (a damaged pin or head, listed by `corruptEntries()`) yields undefined.
   */
  #references(): Set<string> | undefined {
    const referenced = new Set(this.sessions().map((pin) => pin.generationId))
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
    return this.#problems.length > 0 ? undefined : referenced
  }

  /**
   * Removes generations nothing can still reach. A generation is deleted only after its directory was
   * renamed to a claim name: from then on adopters, pins and heads that name it fail or are withdrawn
   * (see `#confirmPresent`), and the references are read again before anything is removed. A claim that
   * finds a reference puts the directory back, so adopt, pin and collect agree across processes.
   */
  async collect(
    keep: ReadonlySet<string>,
    retired: ReadonlySet<string> = new Set(),
  ): Promise<readonly string[]> {
    if (!existsSync(this.root)) return []
    const referenced = this.#references(),
      removed: string[] = []
    if (!referenced) return []
    for (const name of readdirSync(this.root)) {
      const abandoned = CLAIM_PATTERN.exec(name)
      if (abandoned) {
        // A claimer that died between its rename and its verdict; settle it like a fresh claim.
        if (Date.now() - Number(abandoned[2]) > UNOWNED_GRACE_MS)
          await this.#settleClaim(abandoned[1] as string, join(this.root, name), removed)
        continue
      }
      const id = name
      // Another workspace worker may still be accepting sessions on its own snapshot.
      if (!GENERATION_ID_PATTERN.test(id) || keep.has(id)) continue
      this.#release(id)
      const directory = this.directory(id)
      if (referenced.has(id) || (await this.#heldByOther(directory))) continue
      if (!this.#created.has(id) && !retired.has(id) && (await this.ownerMayBeLive(directory))) continue
      const claim = `${directory}.deleting-${Date.now()}-${this.#token}`
      try {
        renameSync(directory, claim)
      } catch {
        continue
      }
      await this.#settleClaim(id, claim, removed)
    }
    if (removed.length) syncDirectorySync(this.root)
    return removed
  }

  async #settleClaim(id: string, claim: string, removed: string[]): Promise<void> {
    const referenced = this.#references()
    if (!referenced || referenced.has(id) || (await this.#heldByOther(claim))) {
      try {
        renameSync(claim, this.directory(id))
      } catch {
        // Left claimed: the next pass settles it again.
      }
      return
    }
    rmSync(claim, { recursive: true, force: true })
    removed.push(id)
    this.#created.delete(id)
  }
}
