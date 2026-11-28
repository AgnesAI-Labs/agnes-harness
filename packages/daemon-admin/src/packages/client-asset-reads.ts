import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import {
  CLIENT_RESOURCE_MAX_FILE_BYTES,
  hashDirectoryAsync,
  type InstalledInventory,
  resolveClientModuleAsset,
  type VerifiedClientTree,
} from '@agnes/package-manager'
import type { ClientModuleReadParams, ClientModuleReadResult } from '@agnes/protocol'
import { admissionDigest, type ClientAdmission, type PresentationObservation } from './client-admission.js'
import {
  digest,
  encodedRevision,
  type ProfileState,
  pruneUntracked,
  readState,
  sameAsset,
  type VerifiedAsset,
  verifySnapshot,
} from './client-module-snapshots.js'
import type { ClientModuleRegistry, ClientModuleRegistryOptions } from './client-modules.js'
import type { PackageActivationObservation } from './handler.js'

type ReadContext = Parameters<ClientModuleRegistry['list']>[0]
export type ReadInput = ReadContext & Pick<ClientModuleReadParams, 'path' | 'purpose'>
export type PendingRead = { input: ReadInput; resolve(result: ClientModuleReadResult): void }
export type ObservationStatus = 'current' | 'presentation-changed' | 'runtime-changed'
export type AssetPurpose = ClientModuleReadParams['purpose']
export type SourceTreeProof = Pick<VerifiedClientTree, 'directory' | 'treeIntegrity'>
export type RowAssets = {
  rowId: string
  packageId: string
  revision: string
  purpose: AssetPurpose
  admission: Exclude<ClientAdmission, { kind: 'denied' }>
  files: readonly VerifiedAsset[]
}
export type SelectedAsset = {
  file: VerifiedAsset
  packageId: string
  revision: string
  expiresAt?: number
}
type ReadSelection = {
  root: string
  asset: SelectedAsset
  kind: 'approved' | 'current' | 'retained'
}

export const MAX_BATCH_READS = 32
const MAX_BATCH_BYTES = CLIENT_RESOURCE_MAX_FILE_BYTES
const strictSourceFiles: ReadonlyMap<string, Uint8Array> = new Map()

export function assetRoute(packageId: string, revision: string, path: string): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `/plugins/${packageId}/${encodedRevision(revision)}/${encodedPath}`
}

export function sameReadAdapters(left: ReadContext, right: ReadContext): boolean {
  return (
    (left.assetAdapterScope !== undefined && left.assetAdapterScope === right.assetAdapterScope) ||
    (left.actual === right.actual &&
      left.refreshInventory === right.refreshInventory &&
      left.presentation === right.presentation)
  )
}

export function runtimeObservation(
  artifacts: ReturnType<NonNullable<ClientModuleRegistryOptions['runtimeArtifacts']>>,
) {
  return JSON.stringify([
    artifacts?.desired?.digest,
    artifacts?.previous?.digest,
    artifacts?.lastGood?.digest,
    [...(artifacts?.activeBackendRows ?? [])].sort(),
  ])
}

export function sameActivation(
  left: PackageActivationObservation | undefined,
  right: PackageActivationObservation | undefined,
): boolean {
  return (
    left?.actual === right?.actual &&
    left?.actualIntegrity === right?.actualIntegrity &&
    left?.actualVersion === right?.actualVersion
  )
}

async function readBytes(root: string, path: string, { file, packageId, revision }: SelectedAsset) {
  const snapshot = await verifySnapshot(root, packageId, revision)
  const recorded = snapshot?.manifest.files.find((item) => item.path === file.path)
  if (!sameAsset(recorded, file)) return
  const resolved = resolveClientModuleAsset(root, path)
  if (!resolved) return
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.bytes) return
    // Read one byte past the expected end without an unbounded allocation if the file grew.
    const buffer = Buffer.allocUnsafe(file.bytes + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== file.bytes) return
    const bytes = buffer.subarray(0, size)
    if (digest(bytes) === file.sha256) return bytes
  } finally {
    await handle.close()
  }
}

export async function readAssetBatch(
  reads: readonly PendingRead[],
  select: (input: ReadInput) => ReadSelection | undefined | Promise<ReadSelection | undefined>,
  checkCurrent: (includePresentation: boolean) => Promise<ObservationStatus>,
  delivery: {
    closed(): boolean
    settle(read: PendingRead, result?: ClientModuleReadResult): void
    now(): number
  },
): Promise<void> {
  const ready: { read: PendingRead; bytes: Buffer; approved: boolean }[] = []
  let buffered = 0
  const complete = async (): Promise<boolean> => {
    if (delivery.closed()) return false
    if (!ready.length) return true
    const freshness = await checkCurrent(ready.some(({ approved }) => approved))
    if (delivery.closed() || freshness === 'runtime-changed') return false
    for (const { read, bytes, approved } of ready) {
      if (!approved || freshness === 'current')
        delivery.settle(read, { found: true, base64: bytes.toString('base64') })
      else delivery.settle(read)
    }
    ready.length = 0
    buffered = 0
    return true
  }
  for (const read of reads) {
    if (delivery.closed()) return
    const { input } = read
    let selected: ReadSelection | undefined
    try {
      selected = await select(input)
    } catch {
      continue
    }
    if (!selected || delivery.closed()) continue
    const { root, asset, kind } = selected
    if ((kind === 'retained' || buffered + asset.file.bytes > MAX_BATCH_BYTES) && !(await complete())) return
    const bytes = await readBytes(root, input.path, asset).catch(() => undefined)
    if (!bytes || delivery.closed()) continue
    if (kind === 'retained') {
      if (
        (await checkCurrent(false)) === 'current' &&
        !delivery.closed() &&
        (asset.expiresAt === undefined || delivery.now() < asset.expiresAt)
      )
        delivery.settle(read, { found: true, base64: bytes.toString('base64') })
    } else {
      ready.push({ read, bytes, approved: kind === 'approved' })
      buffered += bytes.length
    }
  }
  await complete()
}

function inventoryIdentity(inventory: InstalledInventory): string {
  return admissionDigest([
    inventory.profile,
    inventory.hash,
    inventory.packages.map((row) => [
      row.id,
      row.directory,
      row.verifiedRollbackTarget?.directory ?? null,
      row.localFailure ?? null,
      row.localReloadRequired ?? false,
      row.localFailure ? row.blockers : null,
    ]),
  ])
}

const presentationIdentity = ({ revision, grants }: PresentationObservation) =>
  admissionDigest([revision, grants])

function compositionIdentity(selection: ReturnType<NonNullable<ClientModuleRegistryOptions['composition']>>) {
  return admissionDigest([
    selection?.packages ?? null,
    selection?.uiModules ?? null,
    selection?.shell ?? null,
    selection?.surfaces ?? null,
  ])
}

async function checkState(root: string, profile: string, stateDigest: string) {
  const state = await readState(root, profile)
  if (state && admissionDigest(state) === stateDigest) return state
}

type PublishedSelection = ReadSelection & { approvals: readonly string[] }
type PublishedReadFailure =
  | { kind: 'terminal' }
  | { kind: 'reselect'; inventory: InstalledInventory; paths: ReadonlySet<string> }

type PublishedAssetHint = {
  root: string
  profileDirectory: string
  inventory: string
  composition: string
  runtime: string
  epoch: number | undefined
  presentation: string
  actual: ReadonlyMap<string, PackageActivationObservation | undefined>
  stateDigest: string
  expiresAt: number
  snapshots: ReadonlyMap<string, ReadonlyMap<string, VerifiedAsset>>
  sources: readonly SourceTreeProof[]
  paths: ReadonlyMap<string, PublishedSelection>
}

/** Exact paths into existing snapshots. The observation data is only a comparison baseline. */
export function createPublishedAssetReads(options: ClientModuleRegistryOptions, now: () => number) {
  const hints = new Map<string, PublishedAssetHint>()
  const composition = (profile: string) => compositionIdentity(options.composition?.(profile))
  const sameRuntime = (hint: PublishedAssetHint, profile: string) =>
    options.activationEpoch?.() === hint.epoch &&
    runtimeObservation(options.runtimeArtifacts?.(profile)) === hint.runtime

  return {
    invalidate: (profile: string) => hints.delete(profile),
    clear: () => hints.clear(),
    remember(
      input: ReadContext,
      root: string,
      state: ProfileState,
      grants: readonly RowAssets[],
      selection: ReturnType<NonNullable<ClientModuleRegistryOptions['composition']>>,
      visibleRows: ReadonlySet<string>,
      observed: {
        runtime: string
        epoch: number | undefined
        presentation: PresentationObservation
        actual: ReadonlyMap<string, PackageActivationObservation | undefined>
        sources: readonly SourceTreeProof[]
      },
    ) {
      if (input.archive || input.sessionId !== undefined) return
      const paths = new Map<string, PublishedSelection>()
      const otherPaths = new Set<string>()
      const snapshots = new Map<string, Map<string, VerifiedAsset>>()
      for (const { packageId, revision, files, rowId, admission, purpose } of grants) {
        if (state.packages[packageId]?.current !== revision) continue
        let expected = snapshots.get(packageId)
        if (!expected) snapshots.set(packageId, (expected = new Map()))
        const approvals =
          admission.kind === 'native' && admission.source === 'approved-presentation'
            ? admission.grants.map(admissionDigest)
            : undefined
        for (const file of files) {
          expected.set(file.path, file)
          if (purpose !== 'document' || !visibleRows.has(rowId)) continue
          const path = assetRoute(packageId, revision, file.path)
          if (approvals) {
            const prior = paths.get(path)
            paths.set(path, {
              root,
              asset: { file, packageId, revision },
              kind: 'approved',
              approvals: prior ? [...prior.approvals, ...approvals] : approvals,
            })
          } else otherPaths.add(path)
        }
      }
      for (const path of otherPaths) paths.delete(path)
      if (!paths.size) return
      let expiresAt = Infinity
      for (const { retained } of Object.values(state.packages))
        for (const entry of retained)
          if (entry.expiresAt !== undefined) expiresAt = Math.min(expiresAt, Date.parse(entry.expiresAt))
      hints.set(input.profile, {
        root,
        profileDirectory: input.profileDirectory,
        inventory: inventoryIdentity(input.inventory),
        composition: compositionIdentity(selection),
        runtime: observed.runtime,
        epoch: observed.epoch,
        presentation: presentationIdentity(observed.presentation),
        actual: observed.actual,
        stateDigest: admissionDigest(state),
        expiresAt,
        snapshots,
        sources: observed.sources,
        paths,
      })
    },
    async batch(input: ReadInput, reads: readonly PendingRead[]) {
      const { profile, presentation } = input
      const hint = hints.get(profile)
      if (
        !hint ||
        !presentation ||
        input.archive ||
        input.sessionId !== undefined ||
        input.profileDirectory !== hint.profileDirectory ||
        reads.some(({ input }) => input.purpose !== 'document' || !hint.paths.has(input.path))
      )
        return
      try {
        if (
          now() >= hint.expiresAt ||
          composition(profile) !== hint.composition ||
          !sameRuntime(hint, profile) ||
          options.snapshotDirectory(profile, input.profileDirectory) !== hint.root ||
          inventoryIdentity(input.inventory) !== hint.inventory
        )
          return
        const state = await checkState(hint.root, profile, hint.stateDigest)
        if (!state || (await pruneUntracked(hint.root, state, 'detect'))) return
        // Reconciliation verifies every tracked snapshot, not just the requested package.
        for (const [packageId, { current, retained }] of Object.entries(state.packages)) {
          if (current) {
            const snapshot = await verifySnapshot(hint.root, packageId, current)
            if (!snapshot) return
            const expected = hint.snapshots.get(packageId)
            if (expected) {
              const records = new Map(snapshot.manifest.files.map((file) => [file.path, file]))
              for (const [path, file] of expected) if (!sameAsset(records.get(path), file)) return
            }
          }
          for (const { revision } of retained)
            if (!(await verifySnapshot(hint.root, packageId, revision))) return
        }
        // An ordinary inventory refresh can reuse tree digests. This pass must reopen each source file.
        for (const { directory, treeIntegrity } of hint.sources) {
          if (
            (await hashDirectoryAsync(directory, { exclude: [], verifyFiles: strictSourceFiles })) !==
            treeIntegrity
          )
            return
        }
      } catch {
        return
      }
      let failure: PublishedReadFailure | undefined
      return {
        select: (read: ReadInput) => hint.paths.get(read.path),
        failure: () => failure,
        checkCurrent: async (): Promise<ObservationStatus> => {
          try {
            const fresh = await input.refreshInventory()
            if (inventoryIdentity(fresh) !== hint.inventory) return refuse()
            const current = await presentation(fresh)
            let sameActual = true
            for (const [id, prior] of hint.actual)
              if (!sameActivation(await input.actual(id), prior)) sameActual = false
            const state = await readState(hint.root, profile)
            if (!state || !(await current.current()) || !sameRuntime(hint, profile)) return refuse()
            if (
              sameActual &&
              presentationIdentity(current) === hint.presentation &&
              admissionDigest(state) === hint.stateDigest &&
              composition(profile) === hint.composition
            )
              return 'current'
            const grants = new Set(current.grants.map(admissionDigest))
            const paths = new Set<string>()
            for (const { input: { path } } of reads)
              if (hint.paths.get(path)?.approvals.some((approval) => grants.has(approval))) paths.add(path)
            if (paths.size) failure = { kind: 'reselect', inventory: fresh, paths }
          } catch {
            return refuse()
          }
          return refuse()
        },
      }
      function refuse(): ObservationStatus {
        failure ??= { kind: 'terminal' }
        hints.delete(profile)
        return 'runtime-changed'
      }
    },
  }
}
