import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeWireTypes } from '@agnes/protocol/runtime'
import {
  acceptWire,
  appendRecovery,
  candidateDataRef,
  DEFAULT_SOURCE_PROVIDER_ID,
  emptySnapshot,
  hasPartialArchive,
  type IdentifiedPackage,
  identifyPackage,
  installedDir,
  manifestDataRef,
  PACKAGE_SOURCE_CONTRACT,
  type PackageOutcome,
  pageCandidates,
  provenance,
  type RecoveryRecord,
  readPackageTree,
  readSnapshot,
  readStagedBytes,
  refuse,
  type SnapshotCandidate,
  type SourceSnapshotDocument,
  sha256Hex,
  stagedDataRef,
  unpackTar,
  versionSatisfies,
  writePartialArchive,
  writeSnapshot,
  writeVerifiedArchive,
} from '../source-snapshot.js'

export interface PackageBytes {
  readonly status: number
  readonly body: Buffer
}

export interface PackageTransport {
  get(url: string): Promise<PackageBytes>
}

export type GitRunner = (args: readonly string[], cwd?: string) => string

export interface PackageSourceOptions {
  readonly providerId?: string
  readonly cacheDir: string
  readonly localRoots?: Readonly<Record<string, string>>
  readonly npmRegistries?: Readonly<Record<string, string>>
  readonly gitRepositories?: Readonly<Record<string, string>>
  readonly allowedFeatures?: readonly string[]
  readonly allowedScopes?: readonly string[]
  readonly transport?: PackageTransport
  readonly git?: GitRunner
  readonly stageByteLimit?: number | null
}

export interface PackageSourceProvider {
  readonly providerId: string
  readonly contract: typeof PACKAGE_SOURCE_CONTRACT
  networkReads(): number
  processSpawns(): number
  executedEntries(): readonly string[]
  discover(input: unknown): PackageOutcome<RuntimeWireTypes['PackageSourceDiscoverResult']>
  resolveMetadata(input: unknown): PackageOutcome<RuntimeWireTypes['PackageSourceResolveMetadataResult']>
  fetch(input: unknown): Promise<PackageOutcome<RuntimeWireTypes['PackageSourceFetchResult']>>
  refreshCatalog(
    input: unknown,
  ): Promise<PackageOutcome<RuntimeWireTypes['PackageSourceRefreshCatalogResult']>>
  cancel(): void
  dispose(): void
}

interface NpmArchive {
  readonly body: Buffer
  readonly integrity: string | null
}

interface GitCatalogEntry {
  readonly packageId: string
  readonly version: string
  readonly commit: string
  readonly subdirectory: string
}

function defaultGit(args: readonly string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function defaultTransport(url: string): Promise<PackageBytes> {
  const response = await fetch(url)
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
}

function candidateOf(
  identified: IdentifiedPackage,
  locator: RuntimeWireTypes['PackageLocator'],
): SnapshotCandidate {
  return {
    packageId: identified.packageId,
    version: identified.version,
    treeDigest: identified.treeDigest,
    archiveDigest: identified.archiveDigest,
    manifestDigest: identified.manifestDigest,
    integrity: identified.integrity,
    locator,
    manifest: identified.manifest,
    dependencies: identified.dependencies,
    requiredFeatures: identified.requiredFeatures,
    scopes: identified.scopes,
    definitions: identified.definitions,
    contractRefs: identified.contractRefs,
    privatePaths: identified.privatePaths,
    entry: identified.entry,
  }
}

function wants(
  requirements: readonly RuntimeWireTypes['PackageRequirement'][],
  sourceId: string,
  packageId: string,
  version: string,
): boolean {
  return requirements.some(
    (requirement) =>
      requirement.packageId === packageId &&
      versionSatisfies(version, requirement.versionRange) &&
      (requirement.sourceIds.length === 0 || requirement.sourceIds.includes(sourceId)),
  )
}

function diagnostic(detailCode: string, packageId: string): string {
  return `${detailCode}:${packageId}`.slice(0, 256)
}

function identifyTree(root: string): PackageOutcome<IdentifiedPackage> {
  const tree = readPackageTree(root)
  if (!tree.ok) return tree
  return identifyPackage(tree.value)
}

async function loadNpmArchive(
  registry: string,
  name: string,
  version: string,
  transport: PackageTransport,
  count: () => void,
): Promise<PackageOutcome<NpmArchive>> {
  const base = registry.replace(/\/$/, '')
  count()
  let meta: PackageBytes
  try {
    meta = await transport.get(`${base}/${encodeURIComponent(name)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'registry request failed'
    return refuse('denied', 'source_unavailable', message)
  }
  if (meta.status !== 200) return refuse('denied', 'source_unavailable', 'npm metadata request failed')
  let parsed: unknown
  try {
    parsed = JSON.parse(meta.body.toString('utf8'))
  } catch {
    return refuse('denied', 'schema_invalid', 'npm metadata is not JSON')
  }
  const versions =
    typeof parsed === 'object' && parsed !== null ? (parsed as { versions?: unknown }).versions : undefined
  const selected =
    typeof versions === 'object' && versions !== null
      ? (versions as Record<string, { integrity?: unknown; dist?: { tarball?: unknown } } | undefined>)[
          version
        ]
      : undefined
  const tarball = selected?.dist?.tarball
  if (typeof tarball !== 'string') return refuse('denied', 'source_unavailable', 'npm version has no archive')
  count()
  let archive: PackageBytes
  try {
    archive = await transport.get(tarball)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'archive request failed'
    return refuse('denied', 'source_unavailable', message)
  }
  if (archive.status !== 200) return refuse('denied', 'source_unavailable', 'npm archive request failed')
  const integrity = typeof selected?.integrity === 'string' ? selected.integrity : null
  return { ok: true, value: { body: archive.body, integrity } }
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function checkoutGit(
  repository: string,
  commit: string,
  subdirectory: string,
  git: GitRunner,
  count: () => void,
): PackageOutcome<IdentifiedPackage> {
  if (subdirectory !== '.' && (subdirectory.startsWith('/') || subdirectory.split('/').includes('..'))) {
    return refuse('denied', 'path_escape', 'git subdirectory escapes the repository')
  }
  const dest = mkdtempSync(join(tmpdir(), 'pkg-git-'))
  try {
    count()
    git(['clone', '--quiet', repository, dest])
    count()
    git(['checkout', '--detach', commit], dest)
    const root = subdirectory === '.' ? dest : join(dest, subdirectory)
    if (!contained(dest, root))
      return refuse('denied', 'path_escape', 'git subdirectory escapes the repository')
    return identifyTree(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git checkout failed'
    return refuse('denied', 'source_unavailable', message)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

function readGitCatalog(
  repository: string,
  git: GitRunner,
  count: () => void,
): PackageOutcome<GitCatalogEntry[]> {
  let text = ''
  try {
    count()
    text = git(['show', 'HEAD:catalog.json'], repository)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'git catalog is unreadable'
    return refuse('denied', 'source_unavailable', message)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return refuse('denied', 'schema_invalid', 'git catalog is not JSON')
  }
  const packages =
    typeof parsed === 'object' && parsed !== null ? (parsed as { packages?: unknown }).packages : undefined
  if (!Array.isArray(packages)) return refuse('denied', 'schema_invalid', 'git catalog has no package list')
  const entries: GitCatalogEntry[] = []
  for (const item of packages) {
    if (typeof item !== 'object' || item === null) {
      return refuse('denied', 'schema_invalid', 'git catalog entry is not an object')
    }
    const record = item as Record<string, unknown>
    if (
      typeof record.packageId !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.commit !== 'string' ||
      typeof record.subdirectory !== 'string'
    ) {
      return refuse('denied', 'schema_invalid', 'git catalog entry is incomplete')
    }
    entries.push({
      packageId: record.packageId,
      version: record.version,
      commit: record.commit,
      subdirectory: record.subdirectory,
    })
  }
  return { ok: true, value: entries }
}

function identifiedFromArchive(bytes: Buffer): PackageOutcome<IdentifiedPackage> {
  const unpacked = unpackTar(bytes)
  if (!unpacked.ok) return unpacked
  return identifyPackage(unpacked.value)
}

export function createPackageSourceProvider(options: PackageSourceOptions): PackageSourceProvider {
  const providerId = options.providerId ?? DEFAULT_SOURCE_PROVIDER_ID
  const transport: PackageTransport = options.transport ?? { get: defaultTransport }
  const git = options.git ?? defaultGit
  const localRoots = options.localRoots ?? {}
  const npmRegistries = options.npmRegistries ?? {}
  const gitRepositories = options.gitRepositories ?? {}
  const loaded = readSnapshot(options.cacheDir)
  let current: SourceSnapshotDocument = loaded.ok
    ? loaded.value
    : emptySnapshot(options.allowedFeatures ?? [], options.allowedScopes ?? [])
  if (!loaded.ok) writeSnapshot(options.cacheDir, current)
  let disposed = false
  let cancelled = false
  let networkReads = 0
  let processSpawns = 0
  const executedEntries: string[] = []

  const gate = (): PackageOutcome<null> => {
    if (disposed) return refuse('internal', 'provider_disposed', 'package source provider is disposed')
    if (cancelled) return refuse('cancelled', 'operation_cancelled', 'package source operation is cancelled')
    return { ok: true, value: null }
  }
  const save = (next: SourceSnapshotDocument): void => {
    current = next
    writeSnapshot(options.cacheDir, next)
  }
  const note = (record: RecoveryRecord): void => save(appendRecovery(current, record))
  const countNetwork = (): void => {
    networkReads += 1
  }
  const countSpawn = (): void => {
    processSpawns += 1
  }

  const stage = (
    identified: IdentifiedPackage,
    sourceKind: RecoveryRecord['sourceKind'],
  ): PackageOutcome<RuntimeWireTypes['PackageSourceFetchResult']> => {
    const limit = options.stageByteLimit
    if (limit !== null && limit !== undefined && identified.archive.length > limit) {
      writePartialArchive(
        options.cacheDir,
        identified.treeDigest,
        identified.archive.subarray(0, limit),
        providerId,
      )
      note({
        sourceKind,
        packageId: identified.packageId,
        phase: 'interrupted',
        bytes: limit,
        digest: identified.treeDigest,
      })
      return refuse(
        'cancelled',
        'operation_cancelled',
        'package fetch was interrupted before staging completed',
      )
    }
    const existing = readStagedBytes(options.cacheDir, identified.treeDigest)
    const phase =
      existing !== null && sha256Hex(existing) === identified.archiveDigest ? 'reused' : 'verified'
    if (phase === 'verified') {
      writeVerifiedArchive(options.cacheDir, identified.treeDigest, identified.archive, providerId)
    }
    note({
      sourceKind,
      packageId: identified.packageId,
      phase,
      bytes: identified.archive.length,
      digest: identified.treeDigest,
    })
    return acceptWire('PackageSourceFetchResult', {
      stagedPackageRef: stagedDataRef(
        providerId,
        identified.packageId,
        identified.archiveDigest,
        identified.archive.length,
      ),
      verifiedDigest: identified.treeDigest,
    })
  }

  const reuseOrRead = async (
    expectedDigest: string,
    sourceKind: RecoveryRecord['sourceKind'],
    readLive: () => Promise<PackageOutcome<IdentifiedPackage>>,
  ): Promise<PackageOutcome<RuntimeWireTypes['PackageSourceFetchResult']>> => {
    const staged = readStagedBytes(options.cacheDir, expectedDigest)
    if (staged !== null) {
      const identified = identifiedFromArchive(staged)
      if (!identified.ok) return identified
      if (identified.value.treeDigest !== expectedDigest) {
        return refuse('denied', 'digest_mismatch', 'staged package bytes do not match the requested digest')
      }
      return stage(identified.value, sourceKind)
    }
    if (hasPartialArchive(options.cacheDir, expectedDigest)) {
      note({ sourceKind, packageId: expectedDigest, phase: 'interrupted', bytes: 0, digest: expectedDigest })
    }
    const live = await readLive()
    if (!live.ok) return live
    if (live.value.treeDigest !== expectedDigest) {
      return refuse('denied', 'digest_mismatch', 'package tree digest does not match the requested digest')
    }
    if (executedEntries.length !== 0) {
      return refuse('denied', 'entry_executed', 'package entry was executed while reading the manifest')
    }
    return stage(live.value, sourceKind)
  }

  return {
    providerId,
    contract: PACKAGE_SOURCE_CONTRACT,
    networkReads: () => networkReads,
    processSpawns: () => processSpawns,
    executedEntries: () => executedEntries.slice(),
    discover(input) {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceDiscoverRequest', input)
      if (!request.ok) return request
      const reads = networkReads
      const spawns = processSpawns
      const page = pageCandidates(
        current.candidates,
        request.value.query,
        request.value.cursor,
        request.value.limit,
        current.snapshotId,
      )
      if (networkReads !== reads || processSpawns !== spawns) {
        return refuse(
          'denied',
          'network_not_authorized',
          'discover read a source outside the authorized cache',
        )
      }
      return page
    },
    resolveMetadata(input) {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceResolveMetadataRequest', input)
      if (!request.ok) return request
      const found = current.candidates.filter(
        (candidate) =>
          candidate.packageId === request.value.packageId && candidate.version === request.value.version,
      )
      if (found.length === 0)
        return refuse('denied', 'cache_miss', 'package metadata is not in the authorized cache')
      const digests = new Set(found.map((candidate) => candidate.treeDigest))
      if (digests.size > 1) {
        return refuse(
          'conflict',
          'content_identity_mismatch',
          'one package version has more than one tree digest',
        )
      }
      const candidate = found[0]
      if (candidate === undefined)
        return refuse('denied', 'cache_miss', 'package metadata is not in the authorized cache')
      const manifest = manifestDataRef(candidate.manifest, candidate.manifestDigest)
      if (!manifest.ok) return manifest
      return acceptWire('PackageSourceResolveMetadataResult', {
        manifestRef: manifest.value,
        digest: candidate.treeDigest,
        provenance: provenance(providerId, candidate.locator.sourceId),
      })
    },
    async fetch(input) {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceFetchRequest', input)
      if (!request.ok) return request
      const locator = request.value.locator
      if (locator.digest !== request.value.expectedDigest) {
        return refuse('denied', 'digest_mismatch', 'locator digest does not match the requested digest')
      }
      if (locator.kind === 'local') {
        return reuseOrRead(request.value.expectedDigest, 'local', async () => {
          const root = localRoots[locator.sourceId]
          if (root === undefined)
            return refuse('denied', 'source_not_allowed', 'local source is not configured')
          const separator = locator.pathRef.lastIndexOf('@')
          if (separator <= 0)
            return refuse('invalid_input', 'schema_invalid', 'local package path is missing a version')
          return identifyTree(
            join(root, locator.pathRef.slice(0, separator), locator.pathRef.slice(separator + 1)),
          )
        })
      }
      if (locator.kind === 'npm') {
        return reuseOrRead(request.value.expectedDigest, 'npm', async () => {
          const registry = npmRegistries[locator.sourceId]
          if (registry === undefined)
            return refuse('denied', 'source_not_allowed', 'npm registry is not configured')
          const loaded = await loadNpmArchive(
            registry,
            locator.name,
            locator.version,
            transport,
            countNetwork,
          )
          if (!loaded.ok) return loaded
          if (cancelled) return refuse('cancelled', 'operation_cancelled', 'package fetch was cancelled')
          const archiveDigest = sha256Hex(loaded.value.body)
          if (loaded.value.integrity !== null && loaded.value.integrity !== `sha256-${archiveDigest}`) {
            return refuse('denied', 'integrity_mismatch', 'npm archive integrity does not match its bytes')
          }
          const identified = identifiedFromArchive(loaded.value.body)
          if (!identified.ok) return identified
          if (locator.integrity !== identified.value.integrity) {
            return refuse('denied', 'integrity_mismatch', 'npm locator integrity does not match the archive')
          }
          return identified
        })
      }
      return reuseOrRead(request.value.expectedDigest, 'git', async () => {
        const repository = gitRepositories[locator.sourceId]
        if (repository === undefined || resolve(repository) !== resolve(locator.repository)) {
          return refuse('denied', 'source_not_allowed', 'git repository is not configured')
        }
        if (!/^[0-9a-f]{40}$/.test(locator.commit)) {
          return refuse('denied', 'git_ref_not_commit', 'git source requires a full commit')
        }
        return checkoutGit(repository, locator.commit, locator.subdirectory, git, countSpawn)
      })
    },
    async refreshCatalog(input) {
      const open = gate()
      if (!open.ok) return open
      const request = acceptWire('PackageSourceRefreshCatalogRequest', input)
      if (!request.ok) return request
      const sourceId = request.value.sourceId
      const requirements = request.value.requirements
      const diagnostics: string[] = []
      const admitted: SnapshotCandidate[] = []
      if (sourceId in localRoots) {
        const root = localRoots[sourceId] ?? ''
        admitLocal(root, sourceId, requirements, admitted, diagnostics)
      } else if (sourceId in npmRegistries) {
        const registry = npmRegistries[sourceId] ?? ''
        const npm = await admitNpm(
          registry,
          sourceId,
          requirements,
          admitted,
          diagnostics,
          transport,
          countNetwork,
          options.cacheDir,
          providerId,
        )
        if (!npm.ok) return npm
      } else if (sourceId in gitRepositories) {
        const repository = gitRepositories[sourceId] ?? ''
        const gitResult = admitGit(
          repository,
          sourceId,
          requirements,
          admitted,
          diagnostics,
          git,
          countSpawn,
          options.cacheDir,
          providerId,
        )
        if (!gitResult.ok) return gitResult
      } else {
        return refuse('denied', 'source_not_allowed', 'package source is not configured')
      }
      const revision = current.revision + 1
      save({
        ...current,
        snapshotId: `snapshot-${revision}`,
        revision,
        allowedFeatures: options.allowedFeatures ?? current.allowedFeatures,
        allowedScopes: options.allowedScopes ?? current.allowedScopes,
        candidates: [
          ...current.candidates.filter((candidate) => candidate.locator.sourceId !== sourceId),
          ...admitted,
        ],
      })
      const refs = admitted.map((candidate) => candidateDataRef(candidate))
      return acceptWire('PackageSourceRefreshCatalogResult', {
        catalogRevision: revision,
        candidateRefs: refs,
        diagnosticIds: diagnostics,
      })
    },
    cancel() {
      cancelled = true
    },
    dispose() {
      disposed = true
      cancelled = true
    },
  }

  function admitLocal(
    root: string,
    sourceId: string,
    requirements: readonly RuntimeWireTypes['PackageRequirement'][],
    admitted: SnapshotCandidate[],
    diagnostics: string[],
  ): void {
    let packageNames: string[]
    try {
      packageNames = readdirSync(root)
    } catch {
      diagnostics.push('source-unavailable')
      return
    }
    for (const packageId of packageNames) {
      let versions: string[]
      try {
        versions = readdirSync(join(root, packageId))
      } catch {
        continue
      }
      for (const version of versions) {
        if (!wants(requirements, sourceId, packageId, version)) continue
        const identified = identifyTree(join(root, packageId, version))
        if (!identified.ok) {
          diagnostics.push(diagnostic(identified.detailCode, packageId))
          continue
        }
        if (identified.value.packageId !== packageId || identified.value.version !== version) {
          diagnostics.push(diagnostic('identity_mismatch', packageId))
          continue
        }
        admitted.push(
          candidateOf(identified.value, {
            kind: 'local',
            sourceId,
            pathRef: `${packageId}@${version}`,
            digest: identified.value.treeDigest,
          }),
        )
        writeVerifiedArchive(
          options.cacheDir,
          identified.value.treeDigest,
          identified.value.archive,
          providerId,
        )
      }
    }
  }
}

async function admitNpm(
  registry: string,
  sourceId: string,
  requirements: readonly RuntimeWireTypes['PackageRequirement'][],
  admitted: SnapshotCandidate[],
  diagnostics: string[],
  transport: PackageTransport,
  count: () => void,
  cacheDir: string,
  providerId: string,
): Promise<PackageOutcome<null>> {
  const names = [...new Set(requirements.map((requirement) => requirement.packageId))]
  for (const name of names) {
    const base = registry.replace(/\/$/, '')
    count()
    let meta: PackageBytes
    try {
      meta = await transport.get(`${base}/${encodeURIComponent(name)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'registry request failed'
      return refuse('denied', 'source_unavailable', message)
    }
    if (meta.status !== 200) {
      diagnostics.push(diagnostic('source_unavailable', name))
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(meta.body.toString('utf8'))
    } catch {
      diagnostics.push(diagnostic('schema_invalid', name))
      continue
    }
    const versions =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { versions?: Record<string, { integrity?: unknown; dist?: { tarball?: unknown } }> })
            .versions
        : undefined
    for (const [version, selected] of Object.entries(versions ?? {})) {
      if (!wants(requirements, sourceId, name, version)) continue
      const tarball = selected?.dist?.tarball
      if (typeof tarball !== 'string') {
        diagnostics.push(diagnostic('source_unavailable', name))
        continue
      }
      count()
      let archive: PackageBytes
      try {
        archive = await transport.get(tarball)
      } catch {
        diagnostics.push(diagnostic('source_unavailable', name))
        continue
      }
      if (archive.status !== 200) {
        diagnostics.push(diagnostic('source_unavailable', name))
        continue
      }
      const identified = identifiedFromArchive(archive.body)
      if (!identified.ok) {
        diagnostics.push(diagnostic(identified.detailCode, name))
        continue
      }
      const claimed = typeof selected?.integrity === 'string' ? selected.integrity : null
      if (claimed !== null && claimed !== `sha256-${sha256Hex(archive.body)}`) {
        diagnostics.push(diagnostic('integrity_mismatch', name))
        continue
      }
      admitted.push(
        candidateOf(identified.value, {
          kind: 'npm',
          sourceId,
          name,
          version,
          integrity: identified.value.integrity,
          digest: identified.value.treeDigest,
        }),
      )
      writeVerifiedArchive(cacheDir, identified.value.treeDigest, identified.value.archive, providerId)
    }
  }
  return { ok: true, value: null }
}

function admitGit(
  repository: string,
  sourceId: string,
  requirements: readonly RuntimeWireTypes['PackageRequirement'][],
  admitted: SnapshotCandidate[],
  diagnostics: string[],
  git: GitRunner,
  count: () => void,
  cacheDir: string,
  providerId: string,
): PackageOutcome<null> {
  const catalog = readGitCatalog(repository, git, count)
  if (!catalog.ok) return catalog
  for (const entry of catalog.value) {
    if (!wants(requirements, sourceId, entry.packageId, entry.version)) continue
    if (!/^[0-9a-f]{40}$/.test(entry.commit)) {
      diagnostics.push(diagnostic('git_ref_not_commit', entry.packageId))
      continue
    }
    const identified = checkoutGit(repository, entry.commit, entry.subdirectory, git, count)
    if (!identified.ok) {
      diagnostics.push(diagnostic(identified.detailCode, entry.packageId))
      continue
    }
    if (identified.value.packageId !== entry.packageId || identified.value.version !== entry.version) {
      diagnostics.push(diagnostic('identity_mismatch', entry.packageId))
      continue
    }
    admitted.push(
      candidateOf(identified.value, {
        kind: 'git',
        sourceId,
        repository,
        commit: entry.commit,
        subdirectory: entry.subdirectory,
        digest: identified.value.treeDigest,
      }),
    )
    writeVerifiedArchive(cacheDir, identified.value.treeDigest, identified.value.archive, providerId)
  }
  return { ok: true, value: null }
}

function holdFetch(cacheDir: string, treeDigest: string, bytesFile: string): void {
  const bytes = readFileSync(bytesFile)
  writePartialArchive(
    cacheDir,
    treeDigest,
    bytes.subarray(0, Math.min(8, bytes.length)),
    DEFAULT_SOURCE_PROVIDER_ID,
  )
  process.stdout.write('READY\n')
  setInterval(() => undefined, 1000)
}

function recoverFetch(cacheDir: string, treeDigest: string, bytesFile: string): void {
  const bytes = readFileSync(bytesFile)
  writeVerifiedArchive(cacheDir, treeDigest, bytes, DEFAULT_SOURCE_PROVIDER_ID)
  if (existsSync(installedDir(cacheDir))) {
    process.stderr.write('installed package appeared\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(`STAGED ${treeDigest} ${sha256Hex(bytes)}\n`)
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  const command = process.argv[2]
  const cacheDir = process.argv[3]
  const treeDigest = process.argv[4]
  const bytesFile = process.argv[5]
  if (
    command === 'hold-fetch' &&
    cacheDir !== undefined &&
    treeDigest !== undefined &&
    bytesFile !== undefined
  ) {
    holdFetch(cacheDir, treeDigest, bytesFile)
  } else if (
    command === 'recover-fetch' &&
    cacheDir !== undefined &&
    treeDigest !== undefined &&
    bytesFile !== undefined
  ) {
    recoverFetch(cacheDir, treeDigest, bytesFile)
  } else {
    process.stderr.write('unknown package source command\n')
    process.exitCode = 1
  }
}

export { installedDir }
