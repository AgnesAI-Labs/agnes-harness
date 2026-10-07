import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'
import {
  type RuntimeGenerationResourceInput,
  type RuntimeGenerationResourceSnapshot,
  readGenerationResources,
  writeGenerationResources,
} from './runtime-snapshots-resources.js'
import { hashDirectory } from './sources.js'

export type PluginGenerationSnapshot = Readonly<{
  version?: 1 | 2
  id: string
  artifact: RuntimeTargetArtifact
  sources: readonly RuntimePluginSnapshot[]
  packages: readonly Readonly<{ id: string; version: string }>[]
  compatibility: string
  resourcesDigest?: string
  resources?: RuntimeGenerationResourceSnapshot
}>
export type SessionGenerationPin = Readonly<{
  sessionKey: string
  generationId: string
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
  ): PluginGenerationSnapshot {
    const id = randomUUID(),
      directory = this.directory(id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
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
      writeFileSync(
        join(directory, 'generation.json'),
        JSON.stringify({
          version: resources ? 2 : 1,
          id,
          ownerPid: process.pid,
          artifact: encodeRuntimeTargetArtifact(target),
          sources: copied,
          packages,
          compatibility,
          ...(resourcesDigest ? { resourcesDigest } : {}),
        }),
        { mode: 0o600, flag: 'wx', flush: true },
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
    let record: PluginGenerationSnapshot
    try {
      record = JSON.parse(
        readFileSync(join(directory, 'generation.json'), 'utf8'),
      ) as PluginGenerationSnapshot
    } catch {
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${id} cannot be resumed`)
    }
    if (
      record.id !== id ||
      (record.version !== undefined && record.version !== 1 && record.version !== 2) ||
      (record.version === 2 && !/^[a-f0-9]{64}$/.test(record.resourcesDigest ?? '')) ||
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

  private pinPath(sessionKey: string): string {
    return join(this.root, 'sessions', `${createHash('sha256').update(sessionKey).digest('hex')}.json`)
  }

  pin(sessionKey: string, generationId: string): SessionGenerationPin {
    if (!existsSync(join(this.directory(generationId), 'generation.json')))
      throw new Error(`E_GENERATION_SNAPSHOT_MISSING: generation ${generationId} cannot be bound`)
    mkdirSync(join(this.root, 'sessions'), { recursive: true, mode: 0o700 })
    const path = this.pinPath(sessionKey),
      pin = { sessionKey, generationId }
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
    const pin = JSON.parse(readFileSync(path, 'utf8')) as SessionGenerationPin
    if (pin.sessionKey !== sessionKey) throw new Error('E_GENERATION_INTEGRITY: session pin mismatch')
    this.directory(pin.generationId)
    return Object.freeze(pin)
  }

  sessions(): readonly SessionGenerationPin[] {
    const directory = join(this.root, 'sessions')
    if (!existsSync(directory)) return []
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const pin = JSON.parse(readFileSync(join(directory, name), 'utf8')) as SessionGenerationPin
        return this.session(pin.sessionKey) as SessionGenerationPin
      })
  }

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

  collect(keep: ReadonlySet<string>, retired: ReadonlySet<string> = new Set()): readonly string[] {
    if (!existsSync(this.root)) return []
    const referenced = new Set(this.sessions().map((pin) => pin.generationId)),
      removed: string[] = []
    for (const id of readdirSync(this.root)) {
      // Another workspace worker may still be accepting sessions on its own snapshot.
      if (!/^[a-f0-9-]{36}$/.test(id) || keep.has(id) || referenced.has(id)) continue
      if (!this.#created.has(id) && !retired.has(id)) {
        let ownerPid: unknown
        try {
          ownerPid = JSON.parse(readFileSync(join(this.directory(id), 'generation.json'), 'utf8')).ownerPid
        } catch {
          continue
        }
        if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) continue
        try {
          process.kill(ownerPid, 0)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
      rmSync(this.directory(id), { recursive: true, force: true })
      removed.push(id)
      this.#created.delete(id)
    }
    return removed
  }
}
