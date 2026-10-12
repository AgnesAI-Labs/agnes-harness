import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
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
import { copyPackageTreeSync } from './copy-tree.js'
import { syncDirectory } from './integrity.js'
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'
import {
  type RuntimeGenerationResourceInput,
  type RuntimeGenerationResourceSnapshot,
  readGenerationResources,
  writeGenerationResources,
} from './runtime-snapshots-resources.js'
import { hashDirectory } from './sources.js'

const OWNER_FILE = 'owner.pid'
const UNOWNED_GRACE_MS = 10 * 60_000

function writeAtomically(path: string, bytes: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
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
  /** Absent on a snapshot written before seams were recorded; such a snapshot cannot be resumed. */
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
  /** Monotonic integer; absent only on a pin written before the field existed. */
  formatVersion?: number
  sessionKey: string
  generationId: string
  /** The pinned seam implementations, recorded at the session's first binding. */
  seams?: readonly PinnedSeam[]
  loop?: Readonly<{ id: string; version: string }>
  resourcesDigest?: string
}>

/** Durable session pins and immutable package copies, independent of mutable installation state. */
export class RuntimeGenerationSnapshotStore {
  readonly root: string
  readonly #created = new Set<string>()
  constructor(profileDirectory: string) {
    this.root = join(profileDirectory, '.runtime-generations')
  }

  private directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('E_GENERATION_ID: invalid generation id')
    return join(this.root, id)
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
      writeFileSync(join(directory, OWNER_FILE), String(process.pid), { mode: 0o600, flush: true })
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
      writeAtomically(
        join(directory, 'generation.json'),
        JSON.stringify({
          version: seams ? GENERATION_SNAPSHOT_VERSION : resources ? 2 : 1,
          ...(seams ? { seams } : {}),
          id,
          ownerPid: process.pid,
          artifact: encodeRuntimeTargetArtifact(target),
          sources: copied,
          packages,
          compatibility,
          ...(resourcesDigest ? { resourcesDigest } : {}),
        }),
      )
      this.#created.add(id)
      return this.read(id)
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  read(id: string): PluginGenerationSnapshot {
    const directory = this.directory(id)
    let text: string
    try {
      text = readFileSync(join(directory, 'generation.json'), 'utf8')
    } catch {
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${id} cannot be resumed`)
    }
    let record: PluginGenerationSnapshot
    try {
      record = JSON.parse(text) as PluginGenerationSnapshot
    } catch {
      throw new Error(`E_GENERATION_INTEGRITY: generation ${id} record is not valid JSON`)
    }
    if (typeof record.version === 'number' && record.version > GENERATION_SNAPSHOT_VERSION)
      throw new Error(
        `E_GENERATION_SNAPSHOT_NEWER: generation ${id} was written by a newer AGH (snapshot format ${record.version})`,
      )
    if (
      record.id !== id ||
      (record.version !== undefined && ![1, 2, 3].includes(record.version)) ||
      (record.version === 2 && !/^[a-f0-9]{64}$/.test(record.resourcesDigest ?? '')) ||
      (record.version === 3 && !validSeams(record.seams)) ||
      typeof record.compatibility !== 'string' ||
      !Array.isArray(record.sources) ||
      !Array.isArray(record.packages) ||
      record.packages.some((pkg) => typeof pkg.id !== 'string' || typeof pkg.version !== 'string')
    )
      throw new Error('E_GENERATION_INTEGRITY: invalid generation snapshot')
    decodeRuntimeTargetArtifact(record.artifact)
    const sources = record.sources.map((source, index) => {
      if (!source.trusted || source.snapshot.directory !== String(index))
        throw new Error('E_GENERATION_INTEGRITY: invalid package snapshot')
      const snapshot = { ...source.snapshot, directory: join(directory, String(index)) }
      if (hashDirectory(snapshot.directory, { exclude: [] }) !== snapshot.treeIntegrity)
        throw new Error('E_GENERATION_INTEGRITY: package snapshot is unavailable or changed')
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
      throw new Error('E_GENERATION_CONFIG_INTEGRITY: accepted configuration cannot be restored', { cause })
    }
  }

  /** Called after Host accepts config; callers compensate this record along with their live apply. */
  saveLiveConfig(id: string, artifact: RuntimeTargetArtifact | undefined): void {
    const directory = this.directory(id),
      path = join(directory, 'live-config.json')
    if (!existsSync(join(directory, 'generation.json')))
      throw new Error('E_GENERATION_SNAPSHOT_MISSING: configuration generation is unavailable')
    if (!artifact) {
      rmSync(path, { force: true })
      syncDirectory(directory)
      return
    }
    decodeRuntimeTargetArtifact(artifact)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ generationId: id, artifact }), {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      })
      renameSync(temporary, path)
      syncDirectory(directory)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  private pinPath(sessionKey: string): string {
    return join(this.root, 'sessions', `${createHash('sha256').update(sessionKey).digest('hex')}.json`)
  }

  pin(sessionKey: string, generationId: string, seams?: readonly PinnedSeam[]): SessionGenerationPin {
    if (!existsSync(join(this.directory(generationId), 'generation.json')))
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot be bound`)
    mkdirSync(join(this.root, 'sessions'), { recursive: true, mode: 0o700 })
    const path = this.pinPath(sessionKey),
      pin: SessionGenerationPin = {
        formatVersion: SESSION_PIN_FORMAT_VERSION,
        sessionKey,
        generationId,
        ...(seams ? { seams } : {}),
      }
    // Link publication is atomic and never overwrites another worker's first binding.
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(pin), { mode: 0o600, flag: 'wx', flush: true })
    try {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return this.session(sessionKey) as SessionGenerationPin
      }
      return Object.freeze(pin)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  session(sessionKey: string): SessionGenerationPin | undefined {
    const path = this.pinPath(sessionKey)
    if (!existsSync(path)) return undefined
    let pin: SessionGenerationPin
    try {
      pin = JSON.parse(readFileSync(path, 'utf8')) as SessionGenerationPin
    } catch {
      throw new Error(`E_GENERATION_INTEGRITY: session pin ${sessionKey} is not valid JSON`)
    }
    if (pin.sessionKey !== sessionKey) throw new Error('E_GENERATION_INTEGRITY: session pin mismatch')
    if (pin.formatVersion !== undefined && pin.formatVersion > SESSION_PIN_FORMAT_VERSION)
      throw new Error(
        `E_GENERATION_PIN_NEWER: session pin was written by a newer AGH (pin format ${pin.formatVersion})`,
      )
    this.directory(pin.generationId)
    return Object.freeze(pin)
  }

  /**
   * Every readable pin. One session that cannot be read here (written by a newer AGH, or damaged)
   * must not hide the others or stop generation bookkeeping, and its generation must not be
   * collected: a pin of a newer format still names its generation, and an unreadable one makes
   * collection stand down altogether.
   */
  sessions(): readonly SessionGenerationPin[] {
    const directory = join(this.root, 'sessions')
    this.#unreadablePins = 0
    if (!existsSync(directory)) return []
    const pins: SessionGenerationPin[] = []
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      try {
        const raw = JSON.parse(readFileSync(join(directory, name), 'utf8')) as SessionGenerationPin
        try {
          pins.push(this.session(raw.sessionKey) as SessionGenerationPin)
        } catch (error) {
          if (!String((error as Error).message).includes('E_GENERATION_PIN_NEWER')) throw error
          this.directory(raw.generationId)
          pins.push(Object.freeze(raw))
        }
      } catch {
        this.#unreadablePins += 1
      }
    }
    return pins
  }
  #unreadablePins = 0

  recordLoop(sessionKey: string, loop: Readonly<{ id: string; version: string }>): void {
    const pin = this.session(sessionKey)
    if (!pin) throw new Error('E_GENERATION_PIN_MISSING: session is not bound')
    if (pin.loop && (pin.loop.id !== loop.id || pin.loop.version !== loop.version))
      throw new Error('E_GENERATION_LOOP_INCOMPATIBLE: session loop differs from its generation pin')
    const path = this.pinPath(sessionKey),
      temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ ...pin, loop }), { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temporary, path)
  }

  /** Coordinator-owned idle migration. Admission must be excluded while replacing this pin. */
  migrateSession(
    sessionKey: string,
    expectedGenerationId: string,
    generationId: string,
    seams?: readonly PinnedSeam[],
  ): SessionGenerationPin {
    const pin = this.session(sessionKey)
    if (!pin || pin.generationId !== expectedGenerationId)
      throw new Error('E_GENERATION_BINDING_CONFLICT: session pin changed before migration')
    if (this.read(pin.generationId).compatibility !== this.read(generationId).compatibility)
      throw new Error('E_GENERATION_INCOMPATIBLE: session migration needs a compatible deployment')
    const nextSeams = seams ?? pin.seams
    const next: SessionGenerationPin = {
      formatVersion: SESSION_PIN_FORMAT_VERSION,
      sessionKey,
      generationId,
      ...(nextSeams ? { seams: nextSeams } : {}),
      ...(pin.loop ? { loop: pin.loop } : {}),
    }
    const path = this.pinPath(sessionKey),
      temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true })
      renameSync(temporary, path)
      return Object.freeze(next)
    } finally {
      rmSync(temporary, { force: true })
    }
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
      rmSync(directory, { recursive: true, force: true })
      renameSync(temporary, directory)
      const path = this.pinPath(key),
        record = `${path}.${randomUUID()}.tmp`
      writeFileSync(record, JSON.stringify({ ...pin, resourcesDigest }), {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      })
      renameSync(record, path)
      return this.sessionResources(key) as RuntimeGenerationResourceSnapshot
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  /** Call only after the session has been deleted, never on close or hibernation. */
  releaseSession(sessionKey: string): void {
    rmSync(this.pinPath(sessionKey), { force: true })
  }

  /** Unreadable owner metadata counts as live until the directory is old enough that no creator can still be writing it. */
  private ownerMayBeLive(id: string): boolean {
    const directory = this.directory(id),
      young = () => {
        try {
          return Date.now() - statSync(directory).mtimeMs < UNOWNED_GRACE_MS
        } catch {
          return false
        }
      }
    let ownerPid: unknown
    try {
      ownerPid = JSON.parse(readFileSync(join(directory, 'generation.json'), 'utf8')).ownerPid
    } catch {
      try {
        ownerPid = Number(readFileSync(join(directory, OWNER_FILE), 'utf8'))
      } catch {
        return young()
      }
    }
    if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return young()
    try {
      process.kill(ownerPid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private headPath(compositionKey: string): string {
    return join(this.root, 'heads', `${createHash('sha256').update(compositionKey).digest('hex')}.json`)
  }

  /** Durable current head of one composition, so workers that start later agree on it. */
  setHead(compositionKey: string, generationId: string): void {
    this.directory(generationId)
    if (!existsSync(join(this.directory(generationId), 'generation.json')))
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot become the head`)
    mkdirSync(join(this.root, 'heads'), { recursive: true, mode: 0o700 })
    writeAtomically(this.headPath(compositionKey), JSON.stringify({ compositionKey, generationId }))
  }

  headId(compositionKey: string): string | undefined {
    try {
      const value = JSON.parse(readFileSync(this.headPath(compositionKey), 'utf8')) as {
        compositionKey?: unknown
        generationId?: unknown
      }
      if (value.compositionKey !== compositionKey || typeof value.generationId !== 'string') return undefined
      this.directory(value.generationId)
      return value.generationId
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
      return snapshot
    } catch {
      return undefined
    }
  }

  collect(keep: ReadonlySet<string>, retired: ReadonlySet<string> = new Set()): readonly string[] {
    if (!existsSync(this.root)) return []
    const referenced = new Set(this.sessions().map((pin) => pin.generationId)),
      removed: string[] = []
    // A recorded head outlives the worker that created it; the next worker to start reuses it.
    for (const name of existsSync(join(this.root, 'heads')) ? readdirSync(join(this.root, 'heads')) : []) {
      try {
        const head = JSON.parse(readFileSync(join(this.root, 'heads', name), 'utf8')) as {
          generationId?: string
        }
        if (typeof head.generationId === 'string') referenced.add(head.generationId)
      } catch {}
    }
    if (this.#unreadablePins > 0) return []
    for (const id of readdirSync(this.root)) {
      // Another workspace worker may still be accepting sessions on its own snapshot.
      if (!/^[a-f0-9-]{36}$/.test(id) || keep.has(id) || referenced.has(id)) continue
      if (!this.#created.has(id) && !retired.has(id) && this.ownerMayBeLive(id)) continue
      rmSync(this.directory(id), { recursive: true, force: true })
      removed.push(id)
      this.#created.delete(id)
    }
    return removed
  }
}

function validSeams(value: unknown): value is GenerationSeams {
  if (!value || typeof value !== 'object') return false
  const record = value as { formatVersion?: unknown; selections?: unknown }
  if (record.formatVersion !== 1) return false
  const selections = record.selections
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return false
  return Object.values(selections).every(
    (selection) =>
      selection &&
      typeof selection === 'object' &&
      typeof (selection as { provider?: unknown }).provider === 'string' &&
      ((selection as { version?: unknown }).version === undefined ||
        typeof (selection as { version?: unknown }).version === 'string'),
  )
}
