import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type ExtensionManifest, satisfiesApiRange } from '@agnes/extension-api'
import { type PackagePreview, validatePackageAdminData } from '@agnes/protocol'
import type { PackageAuditSink } from './audit.js'
import { copyPackageTreeSync } from './copy-tree.js'
import { PackageError } from './errors.js'
import { inspectStaged } from './inspect.js'
import { canonical } from './integrity.js'
import { type InstalledInventory, readInventory } from './inventory.js'
import {
  assertNoReferences,
  assertNoRuntimePins,
  confirmTrust,
  installed,
  type PackageLifecycleActivation,
  type PackageReferences,
  previousSnapshot,
  type TrustDecision,
  trustPackageEntry,
} from './lifecycle.js'
import { type LockEntry, type Lockfile, readLock, withLock, writeLock } from './lockfile.js'
import { readManifestIn } from './manifest.js'
import { type RuntimePluginSnapshot, runtimePluginSnapshotsFromPins } from './package-plugin-loader.js'
import { checkCancelled, type OperationOptions, type PackageSourceAdapter, progress } from './ports.js'
import {
  collectRuntimeSnapshotsStore,
  listRuntimePinsStore,
  pinRuntimeSnapshotStore,
  type RuntimePin,
  type RuntimeSnapshotCollection,
  type RuntimeSnapshotPinRequest,
  type RuntimeSnapshotStore,
  recoverRuntimeSnapshotStore,
  releaseRuntimePinStore,
  resolveRuntimePinStore,
  runtimePinBlockers,
} from './runtime-snapshots.js'
import {
  type ExecFn,
  type FetchedSource,
  fetchSource,
  hashDirectory,
  type PackageSource,
  packageDir,
  parseSource,
} from './sources.js'
import { claimStage, clearStage, readyStage, recoverStaging } from './staging.js'
import {
  commitPackage,
  type PackageCommitPoint,
  previousPackageDir,
  type RuntimeSnapshotCommitPoint,
  recoverPackageStore,
} from './store.js'
import { runTrustGate, verifyInstalledIntegrity } from './trust-gate.js'
import { hashWorkspace, readDeployManifest } from './workspace.js'

export type PackageStatus = {
  id: string
  version: string
  trust: 'builtin' | 'trusted'
  state: 'installed' | 'trusted' | 'enabled'
  integrity: string
  source: LockEntry['source']
}

export interface PackageManager {
  inspect(profileDir: string, source: PackageSource, opts?: OperationOptions): Promise<PackagePreview>
  install(
    profileDir: string,
    source: PackageSource,
    opts: OperationOptions & { expectedIntegrity: string },
  ): Promise<LockEntry>
  add(profileDir: string, spec: string, opts?: { trust?: 'verify' | 'skip' }): Promise<LockEntry>
  trust(profileDir: string, id: string, decision?: TrustDecision): Promise<LockEntry>
  untrust(profileDir: string, id: string, decision: TrustDecision): Promise<LockEntry>
  inventory(profileDir: string): Promise<InstalledInventory>
  /** Lock-free, validated snapshot read for a worker while daemon package effects hold the lock. */
  runtimePluginSnapshots(profileDir: string): Promise<readonly RuntimePluginSnapshot[]>
  recover(profileDir: string): Promise<void>
  pinRuntimeSnapshot(profileDir: string, request: RuntimeSnapshotPinRequest): Promise<RuntimePin>
  resolveRuntimePin(
    profileDir: string,
    request: Readonly<{ pinId: string; expectedSnapshotId?: string }>,
  ): Promise<RuntimePin>
  releaseRuntimePin(
    profileDir: string,
    request: Readonly<{ pinId: string; expectedSnapshotId: string }>,
  ): Promise<void>
  collectRuntimeSnapshots(profileDir: string): Promise<RuntimeSnapshotCollection>
  listRuntimePins(profileDir: string): Promise<readonly RuntimePin[]>
  setEnabled(
    profileDir: string,
    id: string,
    enabled: boolean,
    opts?: Readonly<{ expectedInstalledIntegrity?: string }>,
  ): Promise<LockEntry>
  update(
    profileDir: string,
    id: string,
    source: PackageSource,
    opts: OperationOptions & {
      expectedIntegrity: string
      activation?: PackageLifecycleActivation
    },
  ): Promise<LockEntry>
  enable(
    profileDir: string,
    id: string,
    enabled: boolean,
    opts?: Readonly<{ expectedInstalledIntegrity?: string }>,
  ): Promise<LockEntry>
  remove(profileDir: string, id: string): Promise<void>
  rollback(
    profileDir: string,
    id: string,
    opts?: Readonly<{
      expectedTargetIntegrity?: string
      activation?: PackageLifecycleActivation
    }>,
  ): Promise<LockEntry>
  trustWorkspace(profileDir: string, deployDir: string): Promise<{ hash: string }>
  status(profileDir: string): Promise<PackageStatus[]>
}

export type ManagerOptions = {
  dataDir: string
  agnesVersion: string
  now?: () => string
  exec?: ExecFn
  extract?: (tarball: string, into: string) => Promise<void>
  minimumReleaseAgeMin?: number
  ceiling?: string[]
  cwd?: string
  references?: PackageReferences
  audit?: PackageAuditSink
  auditActor?: string
  checkpoint?: (point: PackageCommitPoint) => void
  runtimeCheckpoint?: (point: RuntimeSnapshotCommitPoint) => void
  sourceAdapters?: readonly PackageSourceAdapter[]
  residueCheck?: (id: string) => Promise<string[]>
}

type PackageJson = {
  name: string
  version: string
  license: string
  dependencies: Record<string, string>
}

const MAX_JSON_BYTES = 1024 * 1024

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function readPackageJson(dir: string): PackageJson {
  const file = join(dir, 'package.json')
  let value: unknown
  try {
    if (statSync(file).size > MAX_JSON_BYTES) throw new Error('too large')
    const text = readFileSync(file, 'utf8')
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('too large')
    value = JSON.parse(text)
  } catch {
    throw new PackageError('E_DEP_MISSING', 'installed package has no valid package.json', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PackageError('E_DEP_MISSING', 'installed package has no valid package.json', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.version !== 'string')
    throw new PackageError('E_DEP_MISSING', 'installed package identity is incomplete', {
      source: { file },
      detail: { reason: 'package-json' },
    })
  const dependencies: Record<string, string> = {}
  if (record.dependencies !== undefined) {
    if (
      record.dependencies === null ||
      typeof record.dependencies !== 'object' ||
      Array.isArray(record.dependencies)
    )
      throw new PackageError('E_DEP_MISSING', 'installed package dependencies are invalid', {
        source: { file },
        detail: { reason: 'package-json' },
      })
    for (const [id, version] of Object.entries(record.dependencies)) {
      if (typeof version !== 'string')
        throw new PackageError('E_DEP_MISSING', 'installed package dependencies are invalid', {
          source: { file },
          detail: { reason: 'package-json', id },
        })
      dependencies[id] = version
    }
  }
  return {
    name: record.name,
    version: record.version,
    license: typeof record.license === 'string' ? record.license : 'UNLICENSED',
    dependencies,
  }
}

export { readManifestIn } from './manifest.js'

function verifyIdentity(
  id: string,
  entry: LockEntry,
  dir: string,
  manifest: ExtensionManifest | undefined,
): void {
  const pkg = readPackageJson(dir)
  if (
    pkg.name !== id ||
    pkg.version !== entry.version ||
    (manifest !== undefined && (manifest.id !== id || manifest.version !== entry.version))
  )
    throw new PackageError('E_LOCK_MISMATCH', `${id} installed identity differs from the lockfile`, {
      detail: { id, reason: 'identity' },
    })
}

function entryFrom(
  source: PackageSource,
  fetched: FetchedSource,
  pkg: PackageJson,
  manifest: ExtensionManifest | undefined,
  installed: string,
  previous: LockEntry | undefined,
): LockEntry {
  if (manifest && (manifest.id !== pkg.name || manifest.version !== pkg.version))
    throw new PackageError('E_EXT_LOAD', 'package and extension manifest identities differ', {
      detail: {
        reason: 'identity-mismatch',
        packageId: pkg.name,
        packageVersion: pkg.version,
        manifestId: manifest.id,
        manifestVersion: manifest.version,
      },
    })
  const common = {
    version: fetched.version,
    integrity: fetched.integrity,
    trust: 'trusted' as const,
    license: pkg.license,
    ...(manifest ? { apiRange: manifest.apiRange, capabilities: manifest.capabilities } : {}),
    ...(manifest?.provides ? { provides: [...manifest.provides] } : {}),
    state: { installed, trusted: null, enabled: false },
    dependencies: { ...fetched.dependencies },
    previous: previous ? { version: previous.version, integrity: previous.integrity } : null,
  }
  if (source.type === 'npm') {
    if (!fetched.releasedAt)
      throw new PackageError('E_DEP_MISSING', 'npm package has no release timestamp', {
        detail: { reason: 'release-time', id: pkg.name },
      })
    return {
      ...common,
      source: { type: 'npm', ref: source.ref },
      releasedAt: fetched.releasedAt,
    }
  }
  if (source.type === 'market')
    throw new PackageError('E_DEP_MISSING', 'market sources are v0.x', {
      detail: { reason: 'market v0.x' },
    })
  return { ...common, source: { type: source.type, ref: source.ref } }
}

function entryOf(lock: Lockfile, id: string): LockEntry {
  const entry = lock.packages[id]
  if (!entry)
    throw new PackageError('E_DEP_MISSING', `${id} is not installed`, {
      detail: { id, reason: 'not-installed' },
    })
  return entry
}

function writable(lock: Lockfile): void {
  if (lock.resolvedProfileHash === null)
    throw new PackageError('E_LOCK_MISMATCH', 'profile must be resolved before packages can be changed', {
      detail: { reason: 'unresolved-lock' },
    })
}

function workspacePath(profileDir: string, deployDir: string): { deployDir: string; relative: string } {
  let root: string
  let deploy: string
  try {
    root = realpathSync(profileDir)
    if (lstatSync(deployDir).isSymbolicLink()) throw new Error('symlink')
    deploy = realpathSync(deployDir)
  } catch {
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace directory is not readable', {
      detail: { reason: 'unreadable' },
    })
  }
  if (!contained(root, deploy) || deploy === root)
    throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace must be contained by the profile directory', {
      detail: { reason: 'outside-profile' },
    })
  const portable = relative(root, deploy).split(sep).join('/')
  return { deployDir: deploy, relative: portable }
}

export function createPackageManager(options: ManagerOptions): PackageManager {
  const adapters = new Map(options.sourceAdapters?.map((adapter) => [adapter.type, adapter]))
  if (adapters.size !== (options.sourceAdapters?.length ?? 0)) throw new TypeError('duplicate source adapter')
  const stamp = options.now ?? (() => new Date().toISOString())
  const minimumReleaseAgeMin = options.minimumReleaseAgeMin ?? 2880
  if (!Number.isSafeInteger(minimumReleaseAgeMin) || minimumReleaseAgeMin < 0)
    throw new TypeError('minimumReleaseAgeMin must be a non-negative safe integer')
  const profileName = (profileDir: string): string => basename(resolve(profileDir))
  const load = (profileDir: string): Lockfile => {
    const profile = profileName(profileDir)
    const lock = readLock(profileDir, { profile, agnesVersion: options.agnesVersion })
    if (lock.profile !== profile)
      throw new PackageError('E_LOCK_MISMATCH', 'lockfile profile differs from its directory', {
        detail: { reason: 'profile', expected: profile, actual: lock.profile },
      })
    return lock
  }
  const ceiling = (lock: Lockfile): readonly string[] =>
    options.ceiling ?? lock.policySnapshot.capabilityCeiling
  const stageFor = (profileDir: string): string => {
    const root = dirname(packageDir(options.dataDir, profileName(profileDir), 'stage'))
    mkdirSync(root, { recursive: true })
    const stage = join(root, `.stage-${randomUUID()}`)
    claimStage(stage)
    return stage
  }
  const fetch = (source: PackageSource, stage: string, cwd: string): Promise<FetchedSource> =>
    fetchSource(source, stage, {
      cwd,
      ...(options.exec ? { exec: options.exec } : {}),
      ...(options.extract ? { extract: options.extract } : {}),
    })

  const acquire = async (
    source: PackageSource,
    stage: string,
    op: OperationOptions,
    profileDir: string,
  ): Promise<FetchedSource> => {
    if (!validatePackageAdminData('PackageSource', source).ok)
      throw new PackageError('E_DEP_MISSING', 'invalid package source')
    progress(op, 'fetching')
    const cwd = options.cwd ?? profileDir
    const adapter = adapters.get(source.type as PackageSourceAdapter['type'])
    try {
      const fetched = adapter
        ? await adapter.fetch(source, stage, { cwd, ...(op.signal ? { signal: op.signal } : {}) })
        : await fetchSource(source, stage, {
            cwd,
            ...(options.exec ? { exec: options.exec } : {}),
            ...(options.extract ? { extract: options.extract } : {}),
            ...(op.signal ? { signal: op.signal } : {}),
          })
      checkCancelled(op.signal)
      const acquiredTree = hashDirectory(stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) })
      readyStage(stage)
      progress(op, 'inspecting')
      if (hashDirectory(stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) }) !== acquiredTree)
        throw new PackageError('E_LOCK_MISMATCH', 'staging changed during inspection')
      return fetched
    } catch (error) {
      checkCancelled(op.signal)
      throw error
    }
  }
  const storeFor = (profileDir: string): RuntimeSnapshotStore => ({
    dataDir: options.dataDir,
    profileDir,
    profile: profileName(profileDir),
    agnesVersion: options.agnesVersion,
    now: stamp,
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.auditActor ? { actor: options.auditActor } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(options.runtimeCheckpoint ? { runtimeCheckpoint: options.runtimeCheckpoint } : {}),
  })
  const locked = <T>(
    profileDir: string,
    fn: () => Promise<T>,
    op: { signal?: AbortSignal } = {},
  ): Promise<T> =>
    withLock(
      profileDir,
      async () => {
        recoverPackageStore(storeFor(profileDir))
        recoverRuntimeSnapshotStore(storeFor(profileDir))
        recoverStaging(dirname(packageDir(options.dataDir, profileName(profileDir), 'stage')))
        return fn()
      },
      op,
    )
  if (options.auditActor !== undefined && !/^[a-zA-Z0-9_.-]{1,128}$/.test(options.auditActor))
    throw new TypeError('invalid audit actor')
  const commitLegacyStage = async (
    profileDir: string,
    lock: Lockfile,
    id: string,
    entry: LockEntry,
    stage: string,
    operation: 'add' | 'rollback',
  ) => {
    const current = lock.packages[id]
    if (current && (options.references || lock.workspace))
      await assertNoReferences(
        storeFor(profileDir),
        lock,
        id,
        operation === 'add' ? 'update' : 'rollback',
        options.references,
      )
    if (current)
      entry.previous = {
        ...previousSnapshot(current),
        treeIntegrity: hashDirectory(packageDir(options.dataDir, profileName(profileDir), id), {
          exclude: [],
        }),
      }
    commitPackage(storeFor(profileDir), lock, id, entry, operation, stage)
  }
  const manager: PackageManager = {
    async recover(profileDir) {
      if (!existsSync(profileDir)) return
      await locked(profileDir, async () => {})
    },
    async inventory(profileDir) {
      const read = () => {
        const lock = load(profileDir)
        return readInventory(lock, { ...storeFor(profileDir), ceiling: ceiling(lock) })
      }
      if (!existsSync(profileDir)) return read()
      return locked(profileDir, async () => read())
    },
    async runtimePluginSnapshots(profileDir) {
      const store = storeFor(profileDir)
      for (let attempt = 0; attempt < 3; attempt++) {
        const beforeLock = load(profileDir)
        const before = readInventory(beforeLock, { ...store, ceiling: ceiling(beforeLock) })
        const pins = listRuntimePinsStore(store)
        const afterLock = load(profileDir)
        const after = readInventory(afterLock, { ...store, ceiling: ceiling(afterLock) })
        if (before.hash === after.hash) return runtimePluginSnapshotsFromPins(after, pins)
      }
      throw new PackageError('E_LOCK_MISMATCH', 'runtime source changed during snapshot read', {
        detail: { reason: 'runtime-source-stale' },
      })
    },
    async pinRuntimeSnapshot(profileDir, request) {
      const frozen = structuredClone(request)
      return locked(profileDir, async () => {
        const lock = load(profileDir),
          store = storeFor(profileDir)
        writable(lock)
        return pinRuntimeSnapshotStore(
          store,
          lock,
          frozen,
          (id) => installed(store, lock, id, false, ceiling(lock)),
          ceiling(lock),
        )
      })
    },
    async resolveRuntimePin(profileDir, request) {
      const frozen = { ...request }
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        const inventory = readInventory(lock, { ...storeFor(profileDir), ceiling: ceiling(lock) })
        return resolveRuntimePinStore(storeFor(profileDir), frozen, lock, (id) => {
          const row = inventory.packages.find((candidate) => candidate.id === id)
          return row?.trusted === true && row.blockers.length === 0
        })
      })
    },
    async releaseRuntimePin(profileDir, request) {
      const frozen = { ...request }
      await locked(profileDir, async () => releaseRuntimePinStore(storeFor(profileDir), frozen))
    },
    async collectRuntimeSnapshots(profileDir) {
      return locked(profileDir, async () => collectRuntimeSnapshotsStore(storeFor(profileDir)))
    },
    async listRuntimePins(profileDir) {
      return locked(profileDir, async () => listRuntimePinsStore(storeFor(profileDir)))
    },
    async setEnabled(profileDir, id, enabled, opts) {
      return manager.enable(profileDir, id, enabled, opts)
    },
    async update(profileDir, id, requestedSource, op) {
      const source = { ...requestedSource },
        expectedIntegrity = op.expectedIntegrity
      return locked(
        profileDir,
        async () => {
          const lock = load(profileDir),
            store = storeFor(profileDir)
          writable(lock)
          const current = installed(store, lock, id, true).entry
          if (op.activation && current.integrity !== op.activation.expectedInstalledIntegrity)
            throw new PackageError('E_LOCK_MISMATCH', 'installed package preview is stale', {
              code: 'E_PACKAGE_PREVIEW_STALE',
            })
          const stage = stageFor(profileDir)
          try {
            const fetched = await acquire(source, stage, op, profileDir)
            if (fetched.integrity !== expectedIntegrity)
              throw new PackageError('E_LOCK_MISMATCH', 'package preview is stale', {
                code: 'E_PACKAGE_PREVIEW_STALE',
              })
            const { preview, treeIntegrity } = inspectStaged({
              dir: stage,
              source,
              fetched,
              previous: current,
              ceiling: ceiling(lock),
              ...(op.signal ? { signal: op.signal } : {}),
            })
            if (preview.id !== id)
              throw new PackageError('E_LOCK_MISMATCH', 'update package identity differs')
            if (preview.blockers.length)
              throw new PackageError('E_API_RANGE', 'package update is blocked', {
                detail: { blockers: preview.blockers },
              })
            const entry = entryFrom(
              source,
              fetched,
              readPackageJson(stage),
              readManifestIn(stage),
              stamp(),
              current,
            )
            entry.contributions = preview.contributions
            entry.treeIntegrity = treeIntegrity
            entry.surfaces = preview.contributions.flatMap((c) =>
              c.kind === 'surface' ? [c.descriptor] : [],
            )
            entry.previous = previousSnapshot(current)
            if (op.activation) {
              if (current.state.trusted === null)
                throw new PackageError(
                  'E_WORKSPACE_UNTRUSTED',
                  'untrusted package cannot activate during update',
                )
              const trusted = trustPackageEntry(
                store,
                id,
                entry,
                stage,
                op.activation.trust,
                minimumReleaseAgeMin,
                ceiling(lock),
              )
              trusted.state.enabled = true
              Object.assign(entry, trusted)
            }
            progress(op, 'committing')
            await assertNoReferences(store, lock, id, 'update', options.references)
            checkCancelled(op.signal)
            commitPackage(store, lock, id, entry, 'update', stage)
            try {
              op.onProgress?.(Object.freeze({ phase: 'completed', percent: 100 }))
            } catch {}
            return entry
          } finally {
            clearStage(stage)
          }
        },
        op,
      )
    },
    async inspect(profileDir, requestedSource, op = {}) {
      const source = { ...requestedSource }
      const stage = stageFor(profileDir)
      try {
        const fetched = await acquire(source, stage, op, profileDir)
        const lock = load(profileDir)
        const pkg = readPackageJson(stage)
        const { preview } = inspectStaged({
          dir: stage,
          source,
          fetched,
          ...(lock.packages[pkg.name] ? { previous: lock.packages[pkg.name] } : {}),
          ceiling: ceiling(lock),
          ...(op.signal ? { signal: op.signal } : {}),
        })
        progress(op, 'completed')
        return preview
      } finally {
        clearStage(stage)
      }
    },
    async install(profileDir, requestedSource, op) {
      const source = { ...requestedSource }
      checkCancelled(op.signal)
      if (!/^(?:sha256-[a-f0-9]{64}|sha512-[A-Za-z0-9+/]{86}==)$/.test(op.expectedIntegrity))
        throw new PackageError('E_DEP_MISSING', 'invalid expected integrity')
      const expectedIntegrity = op.expectedIntegrity
      return locked(
        profileDir,
        async () => {
          checkCancelled(op.signal)
          const lock = load(profileDir)
          writable(lock)
          const stage = stageFor(profileDir)
          try {
            const fetched = await acquire(source, stage, op, profileDir)
            if (fetched.integrity !== expectedIntegrity)
              throw new PackageError('E_LOCK_MISMATCH', 'package preview is stale', {
                code: 'E_PACKAGE_PREVIEW_STALE',
              })
            const { preview, treeIntegrity } = inspectStaged({
              dir: stage,
              source,
              fetched,
              ceiling: ceiling(lock),
              ...(op.signal ? { signal: op.signal } : {}),
            })
            if (lock.packages[preview.id])
              throw new PackageError('E_EXT_LOAD', 'package is already installed; use update')
            if (preview.blockers.length)
              throw new PackageError('E_API_RANGE', 'package installation is blocked', {
                detail: { blockers: preview.blockers },
              })
            const manifest = readManifestIn(stage)
            const entry = entryFrom(source, fetched, readPackageJson(stage), manifest, stamp(), undefined)
            entry.contributions = preview.contributions
            entry.treeIntegrity = treeIntegrity
            entry.surfaces = preview.contributions.flatMap((c) =>
              c.kind === 'surface' ? [c.descriptor] : [],
            )
            progress(op, 'committing')
            // Observers ran before the final tree check; no await or callback may intervene before commit.
            if (
              hashDirectory(stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) }) !==
              treeIntegrity
            )
              throw new PackageError('E_LOCK_MISMATCH', 'staging changed before commit')
            checkCancelled(op.signal)
            commitPackage(storeFor(profileDir), lock, preview.id, entry, 'install', stage)
            try {
              op.onProgress?.(Object.freeze({ phase: 'completed', percent: 100 }))
            } catch {
              /* committed state is authoritative */
            }
            return entry
          } finally {
            clearStage(stage)
          }
        },
        { ...(op.signal ? { signal: op.signal } : {}) },
      )
    },
    async add(profileDir, spec, addOptions = {}) {
      const source = parseSource(spec)
      if (source.type === 'workspace')
        throw new PackageError('E_WORKSPACE_UNTRUSTED', 'workspace packages require project trust', {
          detail: { reason: 'use-trust-workspace' },
        })
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const stage = stageFor(profileDir)
        try {
          const fetched = await fetch(source, stage, options.cwd ?? profileDir)
          const pkg = readPackageJson(stage)
          if (pkg.version !== fetched.version)
            throw new PackageError('E_LOCK_MISMATCH', 'fetched package version changed before install', {
              detail: { reason: 'version', id: pkg.name },
            })
          const manifest = readManifestIn(stage)
          const installed = stamp()
          const entry = entryFrom(source, fetched, pkg, manifest, installed, lock.packages[pkg.name])
          if (addOptions.trust === 'verify') {
            runTrustGate({
              id: pkg.name,
              entry,
              ...(manifest ? { manifest } : {}),
              ceiling: ceiling(lock),
              now: installed,
              minimumReleaseAgeMin,
            })
            entry.state.trusted = installed
          }
          if (lock.packages[pkg.name]?.contributions !== undefined)
            throw new PackageError('E_EXT_LOAD', 'modern package requires digest-bound update')
          await commitLegacyStage(profileDir, lock, pkg.name, entry, stage, 'add')
          return entry
        } finally {
          clearStage(stage)
        }
      })
    },

    async trust(profileDir, id, decision) {
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const entry = entryOf(lock, id)
        if (entry.contributions !== undefined) {
          const next = confirmTrust(
            storeFor(profileDir),
            lock,
            id,
            decision,
            minimumReleaseAgeMin,
            ceiling(lock),
          )
          commitPackage(storeFor(profileDir), lock, id, next, 'trust')
          return next
        }
        const dir = packageDir(options.dataDir, profileName(profileDir), id)
        let reference: string | undefined
        try {
          if (entry.source.type === 'npm') {
            reference = stageFor(profileDir)
            const fetched = await fetch(parseSource(entry.source.ref), reference, options.cwd ?? profileDir)
            if (fetched.integrity !== entry.integrity)
              throw new PackageError('E_LOCK_MISMATCH', `${id} source integrity differs from the lockfile`, {
                detail: { id, reason: 'integrity' },
              })
          }
          verifyInstalledIntegrity(id, entry, dir, reference)
          const manifest = readManifestIn(dir)
          verifyIdentity(id, entry, dir, manifest)
          const trusted = stamp()
          runTrustGate({
            id,
            entry,
            ...(manifest ? { manifest } : {}),
            ceiling: ceiling(lock),
            now: trusted,
            minimumReleaseAgeMin,
          })
          const next = structuredClone(entry)
          next.state.trusted = trusted
          commitPackage(storeFor(profileDir), lock, id, next, 'trust')
          return next
        } finally {
          if (reference) clearStage(reference)
        }
      })
    },

    async untrust(profileDir, id, decision) {
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const entry = entryOf(lock, id)
        if (entry.trust === 'builtin')
          throw new PackageError('E_WORKSPACE_UNTRUSTED', 'builtin packages cannot be untrusted')
        if (entry.integrity !== decision.integrity)
          throw new PackageError('E_LOCK_MISMATCH', 'installed package preview is stale', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        const store = storeFor(profileDir)
        const row = installed(store, lock, id, true, ceiling(lock))
        if (
          !row.trusted ||
          row.capabilityHash !== decision.capabilityHash ||
          (entry.trustDecision !== undefined &&
            (entry.trustDecision.integrity !== decision.integrity ||
              entry.trustDecision.capabilityHash !== decision.capabilityHash))
        )
          throw new PackageError('E_WORKSPACE_UNTRUSTED', 'package is not trusted with the supplied snapshot')
        if (options.references || lock.workspace)
          await assertNoReferences(store, lock, id, 'disable', options.references)
        const next = structuredClone(entry)
        next.state.trusted = null
        next.state.enabled = false
        delete next.trustDecision
        commitPackage(store, lock, id, next, 'untrust')
        return next
      })
    },

    async enable(profileDir, id, enabled, opts = {}) {
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const entry = entryOf(lock, id)
        if (
          opts.expectedInstalledIntegrity !== undefined &&
          entry.integrity !== opts.expectedInstalledIntegrity
        )
          throw new PackageError('E_LOCK_MISMATCH', 'installed package preview is stale', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        if (entry.contributions !== undefined) {
          const store = storeFor(profileDir),
            row = installed(store, lock, id, !enabled, ceiling(lock))
          if (enabled && row.blockers.length)
            throw new PackageError('E_API_RANGE', 'package inventory is blocked', {
              detail: { blockers: row.blockers },
            })
          if (enabled && !row.trusted)
            throw new PackageError('E_WORKSPACE_UNTRUSTED', 'package has no valid trust decision')
          if (!enabled) await assertNoReferences(store, lock, id, 'disable', options.references)
          const next = structuredClone(entry)
          next.state.enabled = enabled
          commitPackage(store, lock, id, next, enabled ? 'enable' : 'disable')
          return next
        }
        if (!enabled && (options.references || lock.workspace))
          await assertNoReferences(storeFor(profileDir), lock, id, 'disable', options.references)
        if (enabled && entry.state.trusted === null)
          throw new PackageError('E_WORKSPACE_UNTRUSTED', `${id} has not passed package trust`, {
            detail: { id, reason: 'not-trusted' },
          })
        const next = structuredClone(entry)
        next.state.enabled = enabled
        commitPackage(storeFor(profileDir), lock, id, next, enabled ? 'enable' : 'disable')
        return next
      })
    },

    async remove(profileDir, id) {
      await locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const entry = entryOf(lock, id),
          store = storeFor(profileDir)
        assertNoRuntimePins(runtimePinBlockers(store, id))
        if (entry.contributions !== undefined) {
          installed(store, lock, id, true)
          await assertNoReferences(store, lock, id, 'remove', options.references)
          collectRuntimeSnapshotsStore(store, id)
          commitPackage(store, lock, id, null, 'remove')
          return
        }
        if (options.references || lock.workspace)
          await assertNoReferences(store, lock, id, 'remove', options.references)
        const dependents = Object.entries(lock.packages)
          .filter(([candidate, value]) => candidate !== id && id in value.dependencies)
          .map(([candidate]) => candidate)
          .sort()
        if (dependents.length)
          throw new PackageError('E_DEP_MISSING', `${id} is still required by installed packages`, {
            detail: { id, reason: 'dependents', dependents },
          })
        const residue = await (options.residueCheck?.(id) ?? Promise.resolve([]))
        if (residue.length)
          throw new PackageError('E_EXT_LOAD', `${id} still owns live extension resources`, {
            detail: { id, reason: 'residue', residue: [...residue] },
          })
        collectRuntimeSnapshotsStore(store, id)
        commitPackage(store, lock, id, null, 'remove')
      })
    },

    async rollback(profileDir, id, opts = {}) {
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        const current = entryOf(lock, id)
        if (opts.activation && current.integrity !== opts.activation.expectedInstalledIntegrity)
          throw new PackageError('E_LOCK_MISMATCH', 'installed package preview is stale', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        if (current.contributions !== undefined) {
          const store = storeFor(profileDir)
          const currentRow = installed(store, lock, id, true)
          if (
            opts.expectedTargetIntegrity !== undefined &&
            currentRow.verifiedRollbackTarget?.integrity !== opts.expectedTargetIntegrity
          )
            throw new PackageError('E_LOCK_MISMATCH', 'rollback target preview is stale', {
              code: 'E_PACKAGE_PREVIEW_STALE',
            })
          if (
            opts.activation &&
            (!opts.expectedTargetIntegrity ||
              opts.activation.trust.integrity !== opts.expectedTargetIntegrity)
          )
            throw new PackageError('E_LOCK_MISMATCH', 'rollback activation target differs', {
              code: 'E_PACKAGE_PREVIEW_STALE',
            })
          if (!current.previous?.treeIntegrity || !current.previous.source)
            throw new PackageError('E_EXT_LOAD', 'no complete previous package snapshot')
          const retained = previousPackageDir(store, id)
          if (hashDirectory(retained, { exclude: [] }) !== current.previous.treeIntegrity)
            throw new PackageError('E_LOCK_MISMATCH', 'previous package tree differs')
          const stage = stageFor(profileDir)
          try {
            copyPackageTreeSync(retained, stage)
            readyStage(stage)
            const next = {
              ...structuredClone(current.previous),
              previous: previousSnapshot(current),
            } as LockEntry
            next.state = { ...next.state, trusted: null, enabled: false }
            delete next.trustDecision
            const source = parseSource(next.source.ref)
            const checked = inspectStaged({
              dir: stage,
              source,
              fetched: {
                dir: stage,
                version: next.version,
                integrity: next.integrity,
                license: next.license,
                dependencies: next.dependencies,
                ...(next.releasedAt ? { releasedAt: next.releasedAt } : {}),
              },
              ceiling: ceiling(lock),
            })
            if (checked.preview.blockers.length)
              throw new PackageError('E_API_RANGE', 'previous package is blocked')
            if (
              canonical(checked.preview.contributions) !== canonical(next.contributions) ||
              canonical(checked.preview.dependencies) !== canonical(next.dependencies)
            )
              throw new PackageError('E_LOCK_MISMATCH', 'previous metadata differs')
            if (opts.activation) {
              if (current.state.trusted === null)
                throw new PackageError(
                  'E_WORKSPACE_UNTRUSTED',
                  'untrusted package cannot activate during rollback',
                )
              const trusted = trustPackageEntry(
                store,
                id,
                next,
                stage,
                opts.activation.trust,
                minimumReleaseAgeMin,
                ceiling(lock),
              )
              trusted.state.enabled = true
              Object.assign(next, trusted)
            }
            await assertNoReferences(store, lock, id, 'rollback', options.references)
            commitPackage(store, lock, id, next, 'rollback', stage)
            return next
          } finally {
            clearStage(stage)
          }
        }
        if (!current.previous)
          throw new PackageError('E_DEP_MISSING', `${id} has no previous version`, {
            detail: { id, reason: 'no-previous' },
          })
        if (
          opts.expectedTargetIntegrity !== undefined &&
          current.previous.integrity !== opts.expectedTargetIntegrity
        )
          throw new PackageError('E_LOCK_MISMATCH', 'rollback target preview is stale', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        if (
          opts.activation &&
          (!opts.expectedTargetIntegrity || opts.activation.trust.integrity !== opts.expectedTargetIntegrity)
        )
          throw new PackageError('E_LOCK_MISMATCH', 'rollback activation target differs', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        if (current.source.type !== 'npm')
          throw new PackageError('E_DEP_MISSING', `${id} source cannot be rolled back automatically`, {
            detail: { id, reason: 'rollback-unsupported' },
          })
        const source = parseSource(`npm:${id}@${current.previous.version}`)
        const stage = stageFor(profileDir)
        try {
          const fetched = await fetch(source, stage, options.cwd ?? profileDir)
          if (fetched.integrity !== current.previous.integrity)
            throw new PackageError('E_LOCK_MISMATCH', `${id} previous source differs from the lockfile`, {
              detail: { id, reason: 'integrity' },
            })
          const pkg = readPackageJson(stage)
          const manifest = readManifestIn(stage)
          const trusted = stamp()
          const entry = entryFrom(source, fetched, pkg, manifest, trusted, current)
          verifyInstalledIntegrity(id, entry, stage, stage)
          runTrustGate({
            id,
            entry,
            ...(manifest ? { manifest } : {}),
            ceiling: ceiling(lock),
            now: trusted,
            minimumReleaseAgeMin,
          })
          entry.state.trusted = null
          entry.state.enabled = false
          delete entry.trustDecision
          if (opts.activation) {
            if (current.state.trusted === null)
              throw new PackageError(
                'E_WORKSPACE_UNTRUSTED',
                'untrusted package cannot activate during rollback',
              )
            const activated = trustPackageEntry(
              storeFor(profileDir),
              id,
              entry,
              stage,
              opts.activation.trust,
              minimumReleaseAgeMin,
              ceiling(lock),
            )
            activated.state.enabled = true
            Object.assign(entry, activated)
          }
          await commitLegacyStage(profileDir, lock, id, entry, stage, 'rollback')
          return entry
        } finally {
          clearStage(stage)
        }
      })
    },

    async trustWorkspace(profileDir, requestedDeployDir) {
      const workspace = workspacePath(profileDir, requestedDeployDir)
      const manifest = readDeployManifest(workspace.deployDir)
      const initialHash = hashWorkspace(workspace.deployDir)
      if (!satisfiesApiRange(manifest.harnessRange, options.agnesVersion))
        throw new PackageError('E_API_RANGE', 'workspace does not support this agnes version', {
          detail: { manifestId: manifest.id, harnessRange: manifest.harnessRange },
        })
      return locked(profileDir, async () => {
        const lock = load(profileDir)
        writable(lock)
        if (lock.policySnapshot.workspacePackages === 'deny')
          throw new PackageError('E_WORKSPACE_UNTRUSTED', 'profile policy denies workspace packages', {
            detail: { reason: 'policy-deny' },
          })
        const installed = stamp()
        const entries: Record<string, LockEntry> = {}
        for (const extension of manifest.extensions) {
          const dir = resolve(workspace.deployDir, extension.path)
          if (!contained(workspace.deployDir, dir))
            throw new PackageError('E_EXT_LOAD', 'workspace extension path escapes its deploy directory', {
              detail: { reason: 'path-escape', id: extension.id },
            })
          const author = readManifestIn(dir)
          const pkg = readPackageJson(dir)
          if (
            !author ||
            author.id !== extension.id ||
            pkg.name !== extension.id ||
            pkg.version !== author.version
          )
            throw new PackageError('E_EXT_LOAD', 'workspace extension identity does not match its manifest', {
              detail: { reason: 'identity-mismatch', id: extension.id },
            })
          const source = parseSource(`workspace:${extension.path}`)
          const integrity = hashDirectory(dir)
          const fetched: FetchedSource = {
            dir,
            version: pkg.version,
            integrity,
            license: pkg.license,
            dependencies: pkg.dependencies,
          }
          const entry = entryFrom(source, fetched, pkg, author, installed, lock.packages[extension.id])
          verifyInstalledIntegrity(extension.id, entry, dir)
          runTrustGate({
            id: extension.id,
            entry,
            manifest: author,
            ceiling: ceiling(lock),
            now: installed,
            minimumReleaseAgeMin,
          })
          entry.state.trusted = installed
          entry.state.enabled = true
          entries[extension.id] = entry
        }
        for (const [id, entry] of Object.entries(lock.packages))
          if (entry.source.type === 'workspace') delete lock.packages[id]
        Object.assign(lock.packages, entries)
        const hash = hashWorkspace(workspace.deployDir)
        if (hash !== initialHash)
          throw new PackageError('E_LOCK_MISMATCH', 'workspace changed while project trust was evaluated', {
            detail: { reason: 'workspace-changed' },
          })
        lock.workspace = {
          path: workspace.relative,
          hash,
          manifestId: manifest.id,
          trustedAt: installed,
        }
        writeLock(profileDir, lock)
        return { hash }
      })
    },

    async status(profileDir) {
      await manager.recover(profileDir)
      return Object.entries(load(profileDir).packages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, entry]) => ({
          id,
          version: entry.version,
          trust: entry.trust,
          state: entry.state.enabled ? 'enabled' : entry.state.trusted ? 'trusted' : 'installed',
          integrity: entry.integrity,
          source: entry.source,
        }))
    },
  }
  return manager
}
