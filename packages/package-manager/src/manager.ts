import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { ExtensionManifest } from '@agnes/extension-api'
import {
  type PackagePreview,
  type PackageProvenance,
  type PackageSourcePolicy,
  validatePackageAdminData,
} from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import type { PackageAuditSink } from './audit.js'
import { copyPackageTreeSync } from './copy-tree.js'
import { packageAdmission, withPackageAdmission } from './effect-admission.js'
import { isPackageError, PackageError } from './errors.js'
import { previewWithExampleParent } from './example-parent.js'
import { inspectStaged } from './inspect.js'
import { canonical, capabilityHash, freezeData, own } from './integrity.js'
import {
  type InstalledInventory,
  type InstalledPackage,
  type InventoryVerificationCache,
  readInventory,
  readInventoryAsync,
} from './inventory.js'
import { readBoundary } from './inventory-boundary.js'
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
import { commitPackage } from './lifecycle-commit.js'
import {
  discoverLocalPlugins,
  LOCAL_PLUGIN_FAILURE,
  type LocalPluginRoots,
  stageLocalPlugin,
} from './local-source.js'
import { type LocalPluginReload, type LocalPluginWatcher, watchLocalPlugins } from './local-watcher.js'
import {
  confirmLocalWorkspace,
  localWorkspaceRoot,
  localWorkspaceTrustHash,
} from './local-workspace-trust.js'
import { type LockEntry, type Lockfile, readLock, withLock, writeLock } from './lockfile.js'
import { readBundledManifest } from './manifest.js'
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'
import { applyReviewedContract, entryFrom, readPackageJson } from './package-record.js'
import { readPluginCapabilityPolicy } from './plugin-capabilities.js'
import { checkCancelled, type OperationOptions, type PackageSourceAdapter, progress } from './ports.js'
import {
  enforcePackageSourcePolicy,
  type fetchNpmProvenance,
  packageSourcePolicy,
  readPackageSourceConfiguration,
  recordProvenance,
  verifyOfficialCatalog,
} from './provenance.js'
import {
  collectRuntimeSnapshotsStore,
  listRuntimePinsStoreAsync,
  pinRuntimeSnapshotsStore,
  type RuntimePin,
  type RuntimeSnapshotCollection,
  type RuntimeSnapshotPinRequest,
  type RuntimeSnapshotStore,
  recoverRuntimeSnapshotStoreAsync,
  releaseRuntimePinStore,
  resolveRuntimePinStore,
  runtimePinBlockers,
} from './runtime-snapshots.js'
import { createRuntimeSourceReader } from './runtime-source-read.js'
import {
  type ExecFn,
  type FetchedSource,
  fetchSource,
  hashDirectory,
  type PackageSource,
  packageDir,
  parseSource,
} from './sources.js'
import { claimStage, clearStage, readyStage, recoverStaging, type StageKind } from './staging.js'
import {
  type PackageCommitPoint,
  previousPackageDir,
  type RuntimeSnapshotCommitPoint,
  recoverPackageStore,
} from './store.js'
import { runTrustGate, verifyInstalledIntegrity } from './trust-gate.js'
import { dependentUpdateBlockers, updatePackages } from './update.js'
import { withoutPackageVerification, withPackageVerification } from './verification-operation.js'
import { hashWorkspace, readDeployManifest, supportsHarness } from './workspace.js'

export type PackageStatus = {
  id: string
  version: string
  trust: 'builtin' | 'trusted'
  state: 'installed' | 'trusted' | 'enabled'
  integrity: string
  source: LockEntry['source']
}

export interface PackageManager {
  provenance(profileDir: string, id: string): Promise<PackageProvenance>
  sourcePolicy(profileDir: string): PackageSourcePolicy
  readonly localPluginRoots: LocalPluginRoots | undefined
  bindLocalPluginReload(reload: LocalPluginReload): void
  reportLocalPluginFailure(profileDir: string, id: string): void

  refreshLocalPlugins(profileDir: string): Promise<readonly string[]>
  watchLocalPlugins(profileDir: string, reload?: LocalPluginReload): LocalPluginWatcher

  inspect(profileDir: string, source: PackageSource, opts?: OperationOptions): Promise<PackagePreview>
  install(
    profileDir: string,
    source: PackageSource,
    opts: OperationOptions & {
      expectedIntegrity: string
      installer?: 'agent' | 'user'
      authoring?: import('@agnes/protocol').AuthoringProvenance
    },
  ): Promise<LockEntry>
  add(profileDir: string, spec: string, opts?: { trust?: 'verify' | 'skip' }): Promise<LockEntry>
  trust(profileDir: string, id: string, decision?: TrustDecision, opts?: OperationOptions): Promise<LockEntry>
  untrust(profileDir: string, id: string, decision: TrustDecision): Promise<LockEntry>
  /** Ordinary concurrent reads share only their in-flight scan. Publication/authorization reads
   * use fresh to establish a new verification boundary. A completed inventory is returned again only
   * to callers that pass `settled`, and only until a package write or a change to the lock, policy
   * or source files: it spares display reads the lock and a full re-hash of the installed trees,
   * and gives up noticing hand edits to installed bytes until the next ordinary or fresh read. */
  inventory(
    profileDir: string,
    opts?: Readonly<{ fresh?: boolean; settled?: boolean }>,
  ): Promise<InstalledInventory>
  /** Lock-free, validated snapshot read for a worker while daemon package effects hold the lock. */
  runtimePluginSnapshots(profileDir: string): Promise<readonly RuntimePluginSnapshot[]>
  recover(profileDir: string): Promise<void>
  pinRuntimeSnapshot(profileDir: string, request: RuntimeSnapshotPinRequest): Promise<RuntimePin>
  /** Pin in order under one lock, manifest read and snapshot verification; a failure keeps earlier pins. */
  pinRuntimeSnapshots(
    profileDir: string,
    requests: readonly RuntimeSnapshotPinRequest[],
    op?: OperationOptions,
  ): Promise<RuntimePin[]>
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
    opts?: Readonly<OperationOptions & { expectedInstalledIntegrity?: string }>,
  ): Promise<LockEntry>
  update(
    profileDir: string,
    id: string,
    source: PackageSource,
    opts: OperationOptions & {
      expectedIntegrity: string
      expectedInstalledIntegrity?: string
      installer?: 'agent' | 'user'
      authoring?: import('@agnes/protocol').AuthoringProvenance
      activation?: PackageLifecycleActivation
      dependents?: readonly {
        id: string
        source: PackageSource
        expectedIntegrity: string
        activation: PackageLifecycleActivation
      }[]
    },
  ): Promise<LockEntry>
  enable(
    profileDir: string,
    id: string,
    enabled: boolean,
    opts?: Readonly<OperationOptions & { expectedInstalledIntegrity?: string }>,
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
  trustWorkspace(profileDir: string, deployDir: string, expectedHash?: string): Promise<{ hash: string }>
  status(profileDir: string): Promise<PackageStatus[]>
}

export type ManagerOptions = {
  localPlugins?: LocalPluginRoots

  dataDir: string
  agnesVersion: string
  now?: () => string
  exec?: ExecFn
  npmProvenance?: typeof fetchNpmProvenance
  extract?: (tarball: string, into: string) => Promise<void>
  minimumReleaseAgeMin?: number
  ceiling?: string[]
  cwd?: string
  references?: PackageReferences
  audit?: PackageAuditSink
  auditActor?: string
  installer?: 'user' | 'agent'
  checkpoint?: (point: PackageCommitPoint) => void
  runtimeCheckpoint?: (point: RuntimeSnapshotCommitPoint) => void
  sourceAdapters?: readonly PackageSourceAdapter[]
  residueCheck?: (id: string) => Promise<string[]>
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export { readBundledManifest } from './manifest.js'

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

function entryOf(lock: Lockfile, id: string): LockEntry {
  const entry = own(lock.packages, id)
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
    root = nativeRealpathSync(profileDir)
    if (lstatSync(deployDir).isSymbolicLink()) throw new Error('symlink')
    deploy = nativeRealpathSync(deployDir)
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
  const verificationCache: InventoryVerificationCache = new Map()
  const inventoryReads = new Map<string, { boundary: string; promise: Promise<InstalledInventory> }>()
  // The last complete read per profile, for `settled` callers only. `inventoryEpoch` counts every
  // event that may change an inventory's content; a read registers itself only if none happened
  // while it ran.
  const settledInventories = new Map<string, { boundary: string; inventory: InstalledInventory }>()
  let inventoryEpoch = 0
  const forgetInventory = (key: string): void => {
    inventoryReads.delete(key)
    settledInventories.delete(key)
    inventoryEpoch++
  }
  const readRuntimePluginSnapshots = createRuntimeSourceReader()
  const profileKey = (directory: string): string =>
    existsSync(directory) ? nativeRealpathSync(directory) : resolve(directory)
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
  const stageFor = (profileDir: string, kind: StageKind = 'fetch'): string => {
    const root = dirname(packageDir(options.dataDir, profileName(profileDir), 'stage'))
    mkdirSync(root, { recursive: true })
    const stage = join(root, `.stage-${randomUUID()}`)
    claimStage(stage, kind)
    return stage
  }
  const annotate = (source: PackageSource, fetched: FetchedSource, profileDir: string): FetchedSource => {
    const tree = hashDirectory(fetched.dir, { exclude: [] })
    const provenance = verifyOfficialCatalog(
      readPackageSourceConfiguration(profileDir),
      readPackageJson(fetched.dir).name,
      recordProvenance(source, fetched, tree),
    )
    enforcePackageSourcePolicy(profileDir, provenance)
    return { ...fetched, provenance: { ...provenance, installer: options.installer ?? 'user' } }
  }
  const fetch = async (
    source: PackageSource,
    stage: string,
    cwd: string,
    profileDir = cwd,
  ): Promise<FetchedSource> =>
    annotate(
      source,
      await fetchSource(source, stage, {
        cwd,
        ...(options.exec ? { exec: options.exec } : {}),
        ...(options.npmProvenance ? { npmProvenance: options.npmProvenance } : {}),
        ...(options.extract ? { extract: options.extract } : {}),
      }),
      profileDir,
    )

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
            ...(options.npmProvenance ? { npmProvenance: options.npmProvenance } : {}),
            ...(options.extract ? { extract: options.extract } : {}),
            ...(op.signal ? { signal: op.signal } : {}),
          })
      checkCancelled(op.signal)
      const acquiredTree = hashDirectory(stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) })
      readyStage(stage)
      progress(op, 'inspecting')
      if (hashDirectory(stage, { exclude: [], ...(op.signal ? { signal: op.signal } : {}) }) !== acquiredTree)
        throw new PackageError('E_LOCK_MISMATCH', 'staging changed during inspection')
      return annotate(source, fetched, profileDir)
    } catch (error) {
      checkCancelled(op.signal)
      throw error
    }
  }
  const storeFor = (profileDir: string): RuntimeSnapshotStore => ({
    ...packageAdmission(),
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
  const readPins = (dir: string) => listRuntimePinsStoreAsync(storeFor(dir), undefined, verificationCache)
  const locked = <T>(
    profileDir: string,
    fn: () => Promise<T>,
    op: OperationOptions & { pin?: boolean } = {},
    ordinaryRead = false,
    // Pin bookkeeping takes the lock but leaves the lockfile and the installed trees alone.
    changesInventory = !ordinaryRead,
  ): Promise<T> => {
    const key = profileKey(profileDir)
    const cut = (): void => {
      if (ordinaryRead) return
      if (changesInventory) forgetInventory(key)
      else inventoryReads.delete(key)
    }
    cut()
    return withPackageAdmission(op.admission, () =>
      (ordinaryRead ? withPackageVerification : withoutPackageVerification)(() =>
        withLock(
          profileDir,
          async () => {
            await op.admission?.verify()
            op.admission?.assertActive()
            if (existsSync(join(profileDir, '.agnes-package-transaction.json'))) {
              withoutPackageVerification(() => recoverPackageStore(storeFor(profileDir)))
            }
            // A clean read validates the same complete snapshot set without entering recovery, and a pin
            // verifies every known snapshot itself first. Journals and abandoned temp state still take
            // the original recovery path.
            const recoveryNeeded = [
              '.agnes-runtime-transaction.json',
              '.agnes-runtime-transaction.json.tmp',
              '.agnes-runtime-snapshots.json.tmp',
            ].some((file) => lstatSync(join(profileDir, file), { throwIfNoEntry: false }) !== undefined)
            if (ordinaryRead && !recoveryNeeded) await readPins(profileDir)
            else if (!op.pin || recoveryNeeded) await recoverRuntimeSnapshotStoreAsync(storeFor(profileDir))
            recoverStaging(dirname(packageDir(options.dataDir, profileName(profileDir), 'stage')))
            await op.admission?.verify()
            op.admission?.assertActive()
            return fn()
          },
          op,
        ),
      ),
    ).finally(cut)
  }
  // Pin bookkeeping takes the lock but leaves the lockfile and the installed trees alone.
  const lockedPins = <T>(
    profileDir: string,
    fn: () => Promise<T>,
    op: OperationOptions & { pin?: boolean } = {},
  ) => locked(profileDir, fn, op, false, false)
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
    const current = own(lock.packages, id)
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
    await commitPackage(storeFor(profileDir), lock, id, entry, operation, stage)
  }
  let localReload: LocalPluginReload | undefined
  const localFailures = new Map<
    string,
    {
      id: string
      source: { type: 'local'; ref: string }
      activation?: boolean
      reason?: string
      declaredCapabilities?: import('@agnes/protocol').PluginCapabilities
      blockers?: InstalledPackage['blockers']
    }
  >()
  // Ids whose committed local change has not been reloaded yet; only a successful reload clears one.
  const localPending = new Set<string>()
  const scanLocal = async (profileDir: string): Promise<string[]> => {
    if (!options.localPlugins) return []
    let lock = load(profileDir)
    writable(lock)
    const changed: string[] = [],
      seen = new Set<string>(),
      ids = new Set<string>()
    for (const candidate of discoverLocalPlugins(options.localPlugins)) {
      lock = load(profileDir)
      seen.add(candidate.source.ref)
      const stage = stageFor(profileDir, 'copy')
      let id = candidate.name
      let declaredCapabilities: import('@agnes/protocol').PluginCapabilities | undefined
      let capabilityBlockers: InstalledPackage['blockers'] = []
      try {
        const prepared = stageLocalPlugin(candidate, stage)
        const pkg = readPackageJson(stage)
        id = pkg.name
        if (ids.has(id)) throw new Error('duplicate local package identity')
        ids.add(id)
        if (
          Object.entries(lock.packages).some(
            ([other, entry]) => other !== id && entry.source.ref === candidate.source.ref,
          )
        )
          throw new Error('local package identity changed; remove its previous installation first')
        const current = own(lock.packages, id)
        if (current && current.source.ref !== candidate.source.ref)
          throw new Error('package identity collision')
        const checked = await inspectStaged({
          dir: stage,
          source: candidate.source,
          fetched: {
            dir: stage,
            version: pkg.version,
            integrity: prepared.integrity,
            license: pkg.license,
            dependencies: pkg.dependencies,
          },
          ceiling: ceiling(lock),
          capabilityPolicy: readPluginCapabilityPolicy(profileDir),
        })
        declaredCapabilities = checked.preview.declaredCapabilities
        capabilityBlockers = checked.preview.blockers
        if (checked.preview.blockers.length) throw new Error('Plugin capability policy blocked activation.')
        if (current?.integrity === prepared.integrity) {
          if (!localFailures.get(candidate.source.ref)?.activation) localFailures.delete(candidate.source.ref)
          continue
        }
        localFailures.delete(candidate.source.ref)
        const entry = entryFrom(
          candidate.source,
          annotate(
            candidate.source,
            {
              dir: stage,
              version: pkg.version,
              integrity: prepared.integrity,
              resolvedLocation: nativeRealpathSync(candidate.directory),
              dependencies: pkg.dependencies,
            },
            profileDir,
          ),
          pkg,
          undefined,
          stamp(),
          current,
        )
        entry.treeIntegrity = checked.treeIntegrity
        applyReviewedContract(entry, checked.preview)
        entry.contributions = checked.preview.contributions
        if (checked.preview.metadata) entry.metadata = checked.preview.metadata
        else delete entry.metadata
        if (checked.preview.declaredCapabilities !== undefined)
          entry.declaredCapabilities = checked.preview.declaredCapabilities
        const capabilityChanged = current && capabilityHash(current) !== capabilityHash(entry)
        const workspaceSource = candidate.source.ref.startsWith('local:workspace/')
        entry.state = {
          installed: current?.state.installed ?? stamp(),
          trusted:
            workspaceSource || capabilityChanged || (current && current.state.trusted === null)
              ? null
              : stamp(),
          enabled: workspaceSource || capabilityChanged ? false : (current?.state.enabled ?? true),
        }
        if (entry.provenance) entry.provenance.trustDecision = entry.state.trusted ? 'confirmed' : 'pending'
        if (entry.state.trusted !== null)
          entry.trustDecision = {
            integrity: entry.integrity,
            capabilityHash: capabilityHash(entry),
            decidedAt: stamp(),
          }
        if (current) entry.previous = previousSnapshot(current)
        readyStage(stage)
        await commitPackage(storeFor(profileDir), lock, id, entry, current ? 'update' : 'install', stage)
        localPending.add(id)
        changed.push(id)
      } catch {
        const installedId = Object.entries(lock.packages).find(
          ([, entry]) => entry.source.ref === candidate.source.ref,
        )?.[0]
        localFailures.set(candidate.source.ref, {
          id: installedId ?? `local-${candidate.source.ref.slice(6).replace('/', '-')}`,
          source: candidate.source,
          ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
          blockers: capabilityBlockers,
          ...(capabilityBlockers.length ? { reason: 'Plugin capability policy blocked activation.' } : {}),
        })
      } finally {
        clearStage(stage)
      }
    }
    lock = load(profileDir)
    for (const [id, entry] of Object.entries(lock.packages)) {
      lock = load(profileDir)
      if (entry.source.type !== 'local' || seen.has(entry.source.ref) || !entry.state.enabled) continue
      await commitPackage(
        storeFor(profileDir),
        lock,
        id,
        { ...entry, state: { ...entry.state, enabled: false } },
        'disable',
      )
      changed.push(id)
      localPending.add(id)
    }
    for (const ref of localFailures.keys()) if (!seen.has(ref)) localFailures.delete(ref)
    return changed
  }
  const projectLocal = (inventory: InstalledInventory): InstalledInventory => {
    if (!options.localPlugins) return inventory
    const rows: InstalledPackage[] = [...inventory.packages]
    for (const failure of localFailures.values()) {
      const index = rows.findIndex((row) => row.entry.source.ref === failure.source.ref)
      const existing = rows[index]
      const entry: LockEntry = existing?.entry ?? {
        source: failure.source,
        version: '0.0.0',
        integrity: `sha256-${'0'.repeat(64)}`,
        trust: 'trusted',
        license: 'UNLICENSED',
        dependencies: {},
        ...(failure.declaredCapabilities === undefined
          ? {}
          : { declaredCapabilities: failure.declaredCapabilities }),
        previous: null,
        state: { installed: new Date(0).toISOString(), trusted: null, enabled: false },
      }
      const row: InstalledPackage = {
        ...(existing ?? {
          id: failure.id,
          entry,
          directory: null,
          capabilityHash: capabilityHash(entry),
          trusted: false,
          enabled: false,
          contributions: [],
          blockers: [],
          verifiedRollbackTarget: null,
        }),
        ...(failure.blockers?.length ? { blockers: failure.blockers } : {}),
        localFailure: failure.reason ?? LOCAL_PLUGIN_FAILURE,
      }
      // Retain the prior valid snapshot for pinned sessions when the editable source is broken.
      if (existing) rows[index] = row
      else rows.push(row)
    }
    const packages = rows.map((row) =>
      row.entry.source.type === 'local' && localPending.has(row.id)
        ? { ...row, localReloadRequired: true }
        : row,
    )
    return freezeData({ ...inventory, packages })
  }
  const manager: PackageManager = {
    sourcePolicy: packageSourcePolicy,
    async provenance(profileDir, id) {
      return locked(profileDir, async () => {
        const row = installed(storeFor(profileDir), load(profileDir), id, false)
        return row.entry.provenance
          ? {
              ...row.entry.provenance,
              trustDecision: row.entry.state.trusted
                ? 'confirmed'
                : row.entry.provenance.trustDecision === 'revoked'
                  ? 'revoked'
                  : 'pending',
            }
          : recordProvenance(
              row.entry.source,
              {
                dir: row.directory ?? '',
                version: row.entry.version,
                integrity: row.entry.integrity,
                dependencies: row.entry.dependencies,
              },
              row.entry.treeIntegrity ?? row.entry.integrity,
            )
      })
    },
    localPluginRoots: options.localPlugins,
    bindLocalPluginReload(reload) {
      localReload = reload
    },
    reportLocalPluginFailure(profileDir, id) {
      forgetInventory(profileKey(profileDir))
      const entry = own(load(profileDir).packages, id)
      if (entry?.source.type === 'local')
        localFailures.set(entry.source.ref, {
          id,
          source: { type: 'local', ref: entry.source.ref },
          activation: true,
        })
    },
    async refreshLocalPlugins(profileDir) {
      return locked(profileDir, async () => scanLocal(profileDir))
    },
    watchLocalPlugins(profileDir, reload) {
      if (!options.localPlugins) throw new Error('Local plugins roots are not configured')
      return watchLocalPlugins({
        roots: options.localPlugins,
        // Rescan also retries every reload still pending (a trust, a lost lock race) unless the
        // plugin itself failed to activate; that failure stays until its source changes.
        scan: async () => {
          const changed = await manager.refreshLocalPlugins(profileDir)
          const failed = new Set([...localFailures.values()].flatMap((f) => (f.activation ? [f.id] : [])))
          return [...new Set([...changed, ...localPending])].filter((id) => !failed.has(id))
        },
        reload: {
          async reloadPlugin(id) {
            const owner = reload ?? localReload
            if (!owner) return
            forgetInventory(profileKey(profileDir))
            await owner.reloadPlugin(id)
            localPending.delete(id)
            forgetInventory(profileKey(profileDir))
          },
        },
        onError(id, error) {
          // A reload that only lost the profile lock race stays pending for the next Rescan.
          if (!id || (isPackageError(error, 'E_LOCK_MISMATCH') && error.detail.reason === 'busy')) return
          manager.reportLocalPluginFailure(profileDir, id)
        },
      })
    },

    async recover(profileDir) {
      if (!existsSync(profileDir)) return
      await locked(profileDir, async () => {})
    },
    async inventory(profileDir, opts = {}) {
      if (opts.settled && !opts.fresh) {
        const kept = settledInventories.get(profileKey(profileDir))
        if (kept && kept.boundary === readBoundary(profileDir)) return kept.inventory
      }
      return (opts.fresh ? withoutPackageVerification : withPackageVerification)(async () => {
        const key = profileKey(profileDir)
        const boundary = readBoundary(profileDir)
        if (opts.fresh) forgetInventory(key)
        const existing = inventoryReads.get(key)
        if (existing?.boundary === boundary) return existing.promise
        const epoch = inventoryEpoch
        let reading: Promise<InstalledInventory>
        const clear = () => {
          if (inventoryReads.get(key)?.promise === reading) inventoryReads.delete(key)
        }
        const read = async () => {
          try {
            const lock = load(profileDir)
            return projectLocal(
              await readInventoryAsync(lock, {
                ...storeFor(profileDir),
                ceiling: ceiling(lock),
                // Static manifest interpretation is reusable only after this read verifies
                // every file again. Fresh admission still has its own digest boundary.
                verificationCache,
              }),
            )
          } finally {
            // No reader may join a finished verification, even before Promise settlement is observed.
            clear()
          }
        }
        const scan = async () => {
          // Let requests already arriving together join before the synchronous tree walk starts.
          await setImmediate()
          return read()
        }
        reading = (
          existsSync(profileDir) ? locked(profileDir, scan, {}, !opts.fresh, false) : scan()
        ).finally(clear)
        // Ordinary readers may join this unfinished verification, including a fresh one.
        // A fresh admission still discards any prior read above and starts independently.
        inventoryReads.set(key, { boundary, promise: reading })
        reading.then(
          (inventory) => {
            try {
              if (epoch === inventoryEpoch && boundary === readBoundary(profileDir))
                settledInventories.set(key, { boundary, inventory })
            } catch {
              /* An unreadable boundary file simply leaves nothing to reuse. */
            }
          },
          () => {
            // A verifying read that failed says the earlier complete one can no longer be trusted.
            if (epoch === inventoryEpoch) settledInventories.delete(key)
          },
        )
        return reading
      })
    },
    async runtimePluginSnapshots(profileDir) {
      return readRuntimePluginSnapshots(profileDir, {
        store: storeFor(profileDir),
        load: () => load(profileDir),
        ceiling,
        verificationCache,
      })
    },
    async pinRuntimeSnapshot(profileDir, request) {
      return ((await manager.pinRuntimeSnapshots(profileDir, [request])) as [RuntimePin])[0]
    },
    async pinRuntimeSnapshots(profileDir, requests, op = {}) {
      if (!requests.length) return []
      const frozen = structuredClone([...requests])
      return lockedPins(
        profileDir,
        async () => {
          const lock = load(profileDir),
            store = storeFor(profileDir)
          writable(lock)
          return pinRuntimeSnapshotsStore(
            store,
            lock,
            frozen,
            (id) => installed(store, lock, id, false, ceiling(lock)),
            ceiling(lock),
          )
        },
        { ...op, pin: true },
      )
    },
    async resolveRuntimePin(profileDir, request) {
      const frozen = { ...request }
      return lockedPins(profileDir, async () => {
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
      await lockedPins(profileDir, async () => releaseRuntimePinStore(storeFor(profileDir), frozen))
    },
    async collectRuntimeSnapshots(profileDir) {
      return lockedPins(profileDir, async () => collectRuntimeSnapshotsStore(storeFor(profileDir)))
    },
    async listRuntimePins(profileDir) {
      return locked(profileDir, async () => readPins(profileDir), {}, true)
    },
    async setEnabled(profileDir, id, enabled, opts) {
      return manager.enable(profileDir, id, enabled, opts)
    },
    async update(profileDir, id, requestedSource, op) {
      const source = { ...requestedSource },
        request = {
          ...op,
          ...(op.activation ? { activation: structuredClone(op.activation) } : {}),
          ...(op.dependents ? { dependents: structuredClone(op.dependents) } : {}),
        }
      return locked(
        profileDir,
        async () => {
          const lock = load(profileDir)
          writable(lock)
          return updatePackages({
            profileDir,
            id,
            source,
            op: request,
            lock,
            store: storeFor(profileDir),
            acquire,
            stageFor,
            ceiling: ceiling(lock),
            minimumReleaseAgeMin,
            ...(options.references ? { references: options.references } : {}),
          })
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
        const previous = own(lock.packages, readPackageJson(stage).name)
        const { preview } = await inspectStaged({
          dir: stage,
          source: fetched.source ?? source,
          fetched,
          ...(previous ? { previous } : {}),
          ceiling: ceiling(lock),
          capabilityPolicy: readPluginCapabilityPolicy(profileDir),
          ...(op.signal ? { signal: op.signal } : {}),
        })
        progress(op, 'completed')
        const checked = previous
          ? {
              ...preview,
              blockers: [...preview.blockers, ...dependentUpdateBlockers(lock, preview.id, preview.version)],
            }
          : preview
        return previewWithExampleParent(checked, () => readInventory(lock, storeFor(profileDir)).packages)
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
            const acquired = await acquire(source, stage, op, profileDir)
            const fetched = op.installer
              ? {
                  ...acquired,
                  provenance: {
                    ...acquired.provenance!,
                    installer: op.installer,
                    ...(op.authoring ? { authoring: op.authoring } : {}),
                  },
                }
              : acquired
            if (fetched.integrity !== expectedIntegrity)
              throw new PackageError('E_LOCK_MISMATCH', 'package preview is stale', {
                code: 'E_PACKAGE_PREVIEW_STALE',
              })
            const { preview, treeIntegrity } = await inspectStaged({
              dir: stage,
              source: fetched.source ?? source,
              fetched,
              ceiling: ceiling(lock),
              capabilityPolicy: readPluginCapabilityPolicy(profileDir),
              ...(op.signal ? { signal: op.signal } : {}),
            })
            if (own(lock.packages, preview.id))
              throw new PackageError('E_EXT_LOAD', 'package is already installed; use update')
            if (preview.blockers.length)
              throw new PackageError('E_API_RANGE', 'package installation is blocked', {
                detail: { blockers: preview.blockers },
              })
            const manifest = undefined
            const entry = entryFrom(
              fetched.source ?? source,
              fetched,
              readPackageJson(stage),
              manifest,
              stamp(),
              undefined,
            )
            entry.contributions = preview.contributions
            applyReviewedContract(entry, preview)
            if (preview.metadata) entry.metadata = preview.metadata
            else delete entry.metadata
            if (preview.declaredCapabilities !== undefined)
              entry.declaredCapabilities = preview.declaredCapabilities
            else delete entry.declaredCapabilities
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
            await commitPackage(storeFor(profileDir), lock, preview.id, entry, 'install', stage)
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
        op,
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
          const fetched = await fetch(source, stage, options.cwd ?? profileDir, profileDir)
          const pkg = readPackageJson(stage)
          if (pkg.version !== fetched.version)
            throw new PackageError('E_LOCK_MISMATCH', 'fetched package version changed before install', {
              detail: { reason: 'version', id: pkg.name },
            })
          const manifest = undefined
          const installed = stamp()
          const entry = entryFrom(
            fetched.source ?? source,
            fetched,
            pkg,
            manifest,
            installed,
            own(lock.packages, pkg.name),
          )
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
          if (own(lock.packages, pkg.name)?.contributions !== undefined)
            throw new PackageError('E_EXT_LOAD', 'modern package requires digest-bound update')
          await commitLegacyStage(profileDir, lock, pkg.name, entry, stage, 'add')
          return entry
        } finally {
          clearStage(stage)
        }
      })
    },

    async trust(profileDir, id, decision, op = {}) {
      return locked(
        profileDir,
        async () => {
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
            await commitPackage(storeFor(profileDir), lock, id, next, 'trust')
            return next
          }
          const dir = packageDir(options.dataDir, profileName(profileDir), id)
          let reference: string | undefined
          try {
            if (entry.source.type === 'npm') {
              reference = stageFor(profileDir)
              const fetched = await fetch(parseSource(entry.source.ref), reference, options.cwd ?? profileDir)
              if (fetched.integrity !== entry.integrity)
                throw new PackageError(
                  'E_LOCK_MISMATCH',
                  `${id} source integrity differs from the lockfile`,
                  {
                    detail: { id, reason: 'integrity' },
                  },
                )
            }
            verifyInstalledIntegrity(id, entry, dir, reference)
            const manifest = undefined
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
            await commitPackage(storeFor(profileDir), lock, id, next, 'trust')
            return next
          } finally {
            if (reference) clearStage(reference)
          }
        },
        op,
      )
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
        if (next.provenance) next.provenance.trustDecision = 'revoked'
        next.state.trusted = null
        next.state.enabled = false
        delete next.trustDecision
        await commitPackage(store, lock, id, next, 'untrust')
        return next
      })
    },

    async enable(profileDir, id, enabled, opts = {}) {
      return locked(
        profileDir,
        async () => {
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
            await commitPackage(store, lock, id, next, enabled ? 'enable' : 'disable')
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
          await commitPackage(storeFor(profileDir), lock, id, next, enabled ? 'enable' : 'disable')
          return next
        },
        opts,
      )
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
          await commitPackage(store, lock, id, null, 'remove')
          return
        }
        if (options.references || lock.workspace)
          await assertNoReferences(store, lock, id, 'remove', options.references)
        const dependents = Object.entries(lock.packages)
          .filter(([candidate, value]) => candidate !== id && Object.hasOwn(value.dependencies, id))
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
        await commitPackage(store, lock, id, null, 'remove')
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
          const stage = stageFor(profileDir, 'copy')
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
            const checked = await inspectStaged({
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
              capabilityPolicy: readPluginCapabilityPolicy(profileDir),
              // Only this integrity-verified retained tree may use historical manifest fields.
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
            await commitPackage(store, lock, id, next, 'rollback', stage)
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
          const fetched = await fetch(source, stage, options.cwd ?? profileDir, profileDir)
          if (fetched.integrity !== current.previous.integrity)
            throw new PackageError('E_LOCK_MISMATCH', `${id} previous source differs from the lockfile`, {
              detail: { id, reason: 'integrity' },
            })
          const pkg = readPackageJson(stage)
          const manifest = undefined
          const trusted = stamp()
          const entry = entryFrom(fetched.source ?? source, fetched, pkg, manifest, trusted, current)
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

    async trustWorkspace(profileDir, requestedDeployDir, expectedHash) {
      // Repository local roots are outside the profile deploy-manifest format.
      // Accept only the configured startup workspace, never an arbitrary path.
      if (
        options.localPlugins &&
        nativeRealpathSync(requestedDeployDir) === localWorkspaceRoot(options.localPlugins)
      ) {
        return locked(profileDir, async () => {
          await scanLocal(profileDir)
          const lock = load(profileDir)
          writable(lock)
          if (lock.policySnapshot.workspacePackages === 'deny')
            throw new PackageError('E_WORKSPACE_UNTRUSTED', 'profile policy denies workspace packages')
          const roots = options.localPlugins!
          if (!expectedHash || localWorkspaceTrustHash(roots, lock) !== expectedHash)
            throw new PackageError('E_LOCK_MISMATCH', 'review the current repository code before trusting', {
              code: 'E_PACKAGE_PREVIEW_STALE',
            })
          if (
            [...localFailures.values()].some((failure) => failure.source.ref.startsWith('local:workspace/'))
          )
            throw new PackageError('E_EXT_LOAD', 'fix local plugin metadata before trusting this workspace')
          const present = new Set(
            discoverLocalPlugins(options.localPlugins!).map((candidate) => candidate.source.ref),
          )
          const rows = readInventory(lock, { ...storeFor(profileDir), ceiling: ceiling(lock) }).packages
          for (const row of rows) {
            if (
              row.entry.source.type !== 'local' ||
              !row.entry.source.ref.startsWith('local:workspace/') ||
              !present.has(row.entry.source.ref)
            )
              continue
            if (row.blockers.length)
              throw new PackageError('E_API_RANGE', 'workspace plugin is blocked', {
                detail: { blockers: row.blockers },
              })
            const entry = own(lock.packages, row.id)!
            // This explicit group decision permits bare local author code too;
            // unlike downloaded packages, its license may be UNLICENSED.
            entry.state.trusted = stamp()
            const previousState = entry.previous?.state
            entry.state.enabled = row.trusted
              ? row.enabled
              : previousState?.trusted
                ? previousState.enabled
                : true
            entry.trustDecision = {
              integrity: entry.integrity,
              capabilityHash: row.capabilityHash,
              decidedAt: stamp(),
            }
            if (entry.provenance) entry.provenance.trustDecision = 'confirmed'
            localPending.add(row.id)
          }
          const hash = confirmLocalWorkspace(profileDir, roots, lock, expectedHash)
          writeLock(profileDir, lock)
          return { hash }
        })
      }
      const workspace = workspacePath(profileDir, requestedDeployDir)
      const manifest = readDeployManifest(workspace.deployDir)
      const initialHash = hashWorkspace(workspace.deployDir)
      if (!supportsHarness(manifest))
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
        // Like the repository workspace above, a confirmation binds to the hash that was reviewed.
        if (expectedHash !== undefined && expectedHash !== initialHash)
          throw new PackageError('E_LOCK_MISMATCH', 'review the current workspace before trusting', {
            code: 'E_PACKAGE_PREVIEW_STALE',
          })
        const installed = stamp()
        const entries: Record<string, LockEntry> = {}
        for (const extension of manifest.extensions) {
          const dir = resolve(workspace.deployDir, extension.path)
          if (!contained(workspace.deployDir, dir))
            throw new PackageError('E_EXT_LOAD', 'workspace extension path escapes its deploy directory', {
              detail: { reason: 'path-escape', id: extension.id },
            })
          // Project trust never replaces a package another source installed; that needs remove first.
          const existing = own(lock.packages, extension.id)
          if (existing && existing.source.type !== 'workspace')
            throw new PackageError('E_EXT_LOAD', 'package is already installed from another source', {
              detail: { reason: 'already-installed', id: extension.id },
            })
          const author = readBundledManifest(dir)
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
          const fetched: FetchedSource = annotate(
            source,
            {
              dir,
              resolvedLocation: nativeRealpathSync(dir),
              version: pkg.version,
              integrity,
              license: pkg.license,
              dependencies: pkg.dependencies,
            },
            profileDir,
          )
          const entry = entryFrom(
            fetched.source ?? source,
            fetched,
            pkg,
            author,
            installed,
            // A workspace entry has no store-retained tree to roll back to.
            undefined,
          )
          verifyInstalledIntegrity(extension.id, entry, dir)
          runTrustGate({
            id: extension.id,
            entry,
            manifest: author,
            ceiling: ceiling(lock),
            now: installed,
            minimumReleaseAgeMin,
          })
          if (entry.provenance) entry.provenance.trustDecision = 'confirmed'
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
