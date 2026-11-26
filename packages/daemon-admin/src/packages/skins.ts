import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { packageOfRow } from '@agnes/daemon-foundation/composite-desired'
import type { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import { ConfigurationError, createConfigurationService } from '@agnes/host'
import {
  activeRuntimePinId,
  applicationConsentSnapshot,
  hashDirectoryAsync,
  lockPath,
  type PackageManager,
  type ResolvedSkin,
  type RuntimeSnapshot,
  resolveSkins,
  SKIN_ASSET_EXTENSIONS,
  SKIN_MAX_ASSET_BYTES,
  SKIN_MAX_ASSETS_TOTAL_BYTES,
  SKIN_MAX_CSS_BYTES,
  withLock,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ApplicationState,
  jcs,
  rpcError,
  type SkinChoice,
  type SkinConfigSnapshot,
  SkinIdentity,
  type SkinListResult,
  type SkinReadResult,
  type SkinSelectParams,
  type SkinStoredSnapshot,
  validateAgainst,
} from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { pluginTreeList } from '../plugin-tree-surface.js'
import type { PackageProfileDirectory } from './project.js'

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const binding = (profile: string, identity: SkinIdentity) => sha256(jcs([profile, identity]))
const route = (skin: Candidate) => `/skins/${skin.bindingDigest}/${skin.identity.id}/`
const deny = (reason: string): never => {
  throw rpcError('SEMANTIC_REJECTED', { reason })
}

type FileFact = { file: string; digest: string; stat: Stats }
type Candidate = {
  name: string
  identity: SkinIdentity
  bindingDigest: string
  css: Buffer
  cssPath: string
  files: ReadonlyMap<string, FileFact>
  tokens: ResolvedSkin['tokens']
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}

/** Capture bounded bytes; reject links and files changed during the read. */
function capture(file: string, cap: number): { bytes: Buffer; stat: Stats } {
  if (nativeRealpathSync(file) !== file) throw new Error('skin path changed')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > cap) throw new Error('skin file exceeds its limit')
    const bytes = Buffer.allocUnsafe(stat.size)
    for (let offset = 0; offset < bytes.length; ) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('skin file changed during read')
      offset += count
    }
    if (!sameFile(stat, lstatSync(file))) throw new Error('skin file changed during read')
    return { bytes, stat }
  } finally {
    closeSync(fd)
  }
}

function bindCandidate(
  snapshot: RuntimeSnapshot & { source: NonNullable<RuntimeSnapshot['source']> },
  rowId: string,
  skin: ResolvedSkin,
): Candidate {
  const { bytes: css, stat } = capture(skin.cssPath, SKIN_MAX_CSS_BYTES)
  const cssDigest = sha256(css)
  const files = new Map<string, FileFact>([['skin.css', { file: skin.cssPath, digest: cssDigest, stat }]])
  let total = 0
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      const name = `${prefix}${encodeURIComponent(entry.name)}`
      if (entry.isDirectory()) {
        walk(file, `${name}/`)
      } else {
        if (!entry.isFile() || !SKIN_ASSET_EXTENSIONS.includes(extname(entry.name).slice(1).toLowerCase()))
          throw new Error('skin asset is not allowed')
        const { bytes, stat } = capture(
          file,
          Math.min(SKIN_MAX_ASSET_BYTES, SKIN_MAX_ASSETS_TOTAL_BYTES - total),
        )
        total += bytes.length
        files.set(name, { file, stat, digest: sha256(bytes) })
      }
    }
  }
  if (skin.assetsDir) walk(skin.assetsDir, 'assets/')
  const assetsDigest = sha256(
    jcs(
      [...files]
        .slice(1)
        .map(([name, fact]) => [name, fact.digest])
        .sort(),
    ),
  )
  const checked = validateAgainst<SkinIdentity>(SkinIdentity, {
    packageId: snapshot.packageId,
    id: skin.id,
    rowId,
    source: snapshot.source,
    version: snapshot.version,
    integrity: snapshot.integrity,
    treeIntegrity: snapshot.treeIntegrity,
    cssDigest,
    assetsDigest,
  })
  if (!checked.ok) throw new Error('skin identity is invalid')
  const identity = checked.value
  return {
    name: skin.name,
    identity,
    bindingDigest: binding(snapshot.profile, identity),
    css,
    cssPath: skin.cssPath,
    files,
    tokens: skin.tokens,
  }
}

function publicChoice(profile: string, choice: SkinStoredSnapshot['choice']): SkinChoice {
  return choice.kind === 'skin' ? { kind: 'skin', bindingDigest: binding(profile, choice.identity) } : choice
}

function lockBoundary(directory: string): Promise<string | undefined> {
  return readFile(lockPath(directory), 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
}

export class Skins {
  constructor(
    private readonly options: {
      manager: PackageManager
      home?: string | undefined
      profileDirectory: PackageProfileDirectory
      store(): CompositeTargetStore | undefined
      workerGeneration?(): number | undefined
      application(profile: string): Promise<ApplicationState>
    },
  ) {}

  private config(profile: string, directory: string) {
    return createConfigurationService({
      home: this.options.home ?? dirname(dirname(directory)),
      profile,
      profileDir: directory,
    })
  }

  private observation(profile: string) {
    const store = this.options.store()
    const worker = this.options.workerGeneration?.()
    const actual = store && pluginTreeList(store, profile, worker).actual
    const artifact = store?.desired()
    const report = store?.report()
    return actual?.actual && artifact && report?.ok ? { worker, artifact, report } : undefined
  }

  private async skinRosterInput(profile: string, directory: string, skinId?: string) {
    const observation = this.observation(profile)
    const stamp = jcs(
      observation ? [observation.worker ?? null, observation.artifact.digest, observation.report] : null,
    )
    const currentRuntime = () => {
      const next = this.observation(profile)
      return stamp === jcs(next ? [next.worker ?? null, next.artifact.digest, next.report] : null)
    }
    const { manager } = this.options
    const boundary = await lockBoundary(directory)
    const pinsBefore = await manager.runtimePinRecords(directory)
    const activeRecords = (records: typeof pinsBefore) =>
      jcs(records.pins.filter((pin) => pin.purpose === 'active'))
    const current = async () => {
      const [lock, pins] = await Promise.all([lockBoundary(directory), manager.runtimePinRecords(directory)])
      return lock === boundary && activeRecords(pins) === activeRecords(pinsBefore) && currentRuntime()
    }
    const candidates: Candidate[] = []
    if (!observation) return { candidates, current }
    const inventory = await manager.inventory(directory, { fresh: true })
    const installed = new Map(
      inventory.packages.filter((p) => p.enabled && p.trusted && !p.blockers.length).map((p) => [p.id, p]),
    )
    const activeIds = new Set(
      observation.report.rows.filter((row) => row.state === 'active').map((row) => row.id),
    )
    const active = new Map<string, Map<string, string>>()
    for (const row of decodeRuntimeTargetArtifact(observation.artifact).tree.rows) {
      if (row.disabled || !activeIds.has(row.id) || row.id.startsWith('web:')) continue
      const id = packageOfRow(row.plugin)
      if (id && installed.has(id)) {
        const rows = active.get(id) ?? new Map<string, string>()
        rows.set(row.id, row.entryRevision)
        active.set(id, rows)
      }
    }
    if (
      !active.size ||
      !inventory.packages.some(
        (p) =>
          active.has(p.id) &&
          p.contributions.some((c) => 'skins' in c && c.skins?.some(({ id }) => !skinId || id === skinId)),
      )
    )
      return { candidates, current }
    for (const pin of await manager.listRuntimePins(directory)) {
      const snapshot = pin.snapshot
      const pkg = installed.get(snapshot.packageId)
      const rows = active.get(snapshot.packageId)
      if (
        !pkg ||
        !rows ||
        pin.purpose !== 'active' ||
        pin.pinId !== activeRuntimePinId(snapshot) ||
        snapshot.profile !== profile ||
        !snapshot.source ||
        snapshot.version !== pkg.entry.version ||
        snapshot.integrity !== pkg.entry.integrity ||
        snapshot.treeIntegrity !== pkg.entry.treeIntegrity ||
        snapshot.capabilityHash !== pkg.capabilityHash ||
        jcs(snapshot.source) !== jcs(pkg.entry.source)
      )
        continue
      const packageCandidates: Candidate[] = []
      try {
        for (const descriptor of snapshot.contributions) {
          if (
            descriptor.kind !== 'client' ||
            !descriptor.skins?.length ||
            rows.get(descriptor.rowId) !== snapshot.integrity
          )
            continue
          const skins = skinId ? descriptor.skins.filter(({ id }) => id === skinId) : descriptor.skins
          const dir = resolve(snapshot.directory, descriptor.path.slice(2), '..')
          for (const skin of resolveSkins(dir, { contributes: { skins } })) {
            const candidate = bindCandidate({ ...snapshot, source: snapshot.source }, descriptor.rowId, skin)
            packageCandidates.push(candidate)
          }
        }
        if (!packageCandidates.length) continue
        // Bind the bytes we may publish to a fresh tree proof, not just to a cached metadata observation.
        const root = nativeRealpathSync(snapshot.directory)
        const verifyFiles = new Map<string, Buffer>()
        for (const { cssPath, css } of packageCandidates) {
          const file = relative(root, cssPath).split(sep).join('/')
          const prior = verifyFiles.get(file)
          if (
            !file ||
            file === '..' ||
            file.startsWith('../') ||
            isAbsolute(file) ||
            (prior && !prior.equals(css))
          )
            throw new Error('skin stylesheet observation changed')
          verifyFiles.set(file, css)
        }
        if (
          (await hashDirectoryAsync(snapshot.directory, { exclude: [], verifyFiles })) !==
          snapshot.treeIntegrity
        )
          continue
        if (
          packageCandidates.some((candidate) =>
            [...candidate.files.values()].some(({ file, stat }) => !sameFile(stat, lstatSync(file))),
          )
        )
          continue
        candidates.push(...packageCandidates)
      } catch {
        // A disappearing, oversized or changed tree cannot contribute skin bytes.
      }
    }
    const counts = new Map<string, number>()
    for (const { identity } of candidates) counts.set(identity.id, (counts.get(identity.id) ?? 0) + 1)
    return {
      candidates: candidates
        .filter(({ identity }) => counts.get(identity.id) === 1)
        .sort(
          (a, b) =>
            a.identity.packageId.localeCompare(b.identity.packageId) ||
            a.identity.id.localeCompare(b.identity.id),
        ),
      current,
    }
  }

  private async effective(profile: string, directory: string, skinId?: string) {
    const config = this.config(profile, directory)
    const saved = await config.skin()
    const roster = await this.skinRosterInput(profile, directory, skinId)
    let chosen: { skin: Candidate; kind: 'manual' | 'application' } | undefined
    const choice = publicChoice(profile, saved.choice)
    let app: ApplicationState | undefined
    if (choice.kind === 'skin') {
      const skin = roster.candidates.find(({ bindingDigest }) => bindingDigest === choice.bindingDigest)
      if (skin) chosen = { skin, kind: 'manual' }
    } else if (choice.kind === 'application' && roster.candidates.length) {
      app = await this.options.application(profile).catch(() => undefined)
      const consent =
        app?.status === 'active' && app.selection?.adoptionGeneration
          ? applicationConsentSnapshot(app.selection)
          : undefined
      if (consent?.declaration.presentation?.skin) {
        const skin = roster.candidates.find(
          ({ identity }) =>
            identity.packageId === consent.packageId &&
            identity.id === consent.declaration.presentation?.skin &&
            identity.version === consent.version &&
            identity.integrity === consent.integrity &&
            jcs(identity.source) === jcs(consent.source),
        )
        if (skin) chosen = { skin, kind: 'application' }
      }
    }
    const current = async () => {
      const [unchanged, latest, latestApp] = await Promise.all([
        roster.current(),
        config.skin(),
        app ? config.application() : undefined,
      ])
      return unchanged && latest.revision === saved.revision && (!app || latestApp?.revision === app.revision)
    }
    return { ...roster, chosen, current, choice, revision: saved.revision }
  }

  async list(profile: string): Promise<SkinListResult> {
    const directory = await this.options.profileDirectory(profile)
    const view = await this.effective(profile, directory)
    if (!(await view.current())) return deny('SKIN_ROSTER_STALE')
    const { chosen } = view
    const candidates = view.candidates.slice(0, 128)
    if (chosen && !candidates.includes(chosen.skin)) candidates[127] = chosen.skin
    return {
      profile,
      revision: view.revision,
      choice: view.choice,
      skins: candidates.map(({ identity, name, bindingDigest }) => ({
        id: identity.id,
        packageId: identity.packageId,
        version: identity.version,
        name,
        bindingDigest,
      })),
      selected: chosen
        ? {
            id: chosen.skin.identity.id,
            kind: chosen.kind,
            bindingDigest: chosen.skin.bindingDigest,
            cssUrl: `${route(chosen.skin)}skin.css`,
            css: new TextDecoder('utf-8', { fatal: true }).decode(chosen.skin.css),
            tokens: chosen.skin.tokens,
          }
        : null,
    }
  }

  async read(profile: string, path: string): Promise<SkinReadResult> {
    const skinId = /^\/skins\/[a-f0-9]{64}\/([a-z0-9]+(?:-[a-z0-9]+)*)\//u.exec(path)?.[1]
    if (!skinId) return { found: false }
    try {
      const directory = await this.options.profileDirectory(profile)
      const view = await this.effective(profile, directory, skinId)
      if (!view.chosen) return { found: false }
      const skin = view.chosen.skin
      const base = route(skin)
      if (!path.startsWith(base)) return { found: false }
      const name = path.slice(base.length)
      const fact = skin.files.get(name)
      if (!fact) return { found: false }
      const bytes = name === 'skin.css' ? skin.css : capture(fact.file, SKIN_MAX_ASSET_BYTES).bytes
      if (sha256(bytes) !== fact.digest || !(await view.current())) return { found: false }
      return { found: true, base64: bytes.toString('base64') }
    } catch {
      return { found: false }
    }
  }

  async select(params: SkinSelectParams): Promise<SkinConfigSnapshot> {
    const { profile, expectedRevision, choice } = params
    const directory = await this.options.profileDirectory(profile)
    const config = this.config(profile, directory)
    try {
      if ((await config.skin()).revision !== expectedRevision)
        throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
      if (choice.kind !== 'skin') {
        const next = await config.saveSkin({ revision: expectedRevision, choice })
        return { revision: next.revision, choice }
      }
      const roster = await this.skinRosterInput(profile, directory)
      const candidate = roster.candidates.find(({ bindingDigest }) => bindingDigest === choice.bindingDigest)
      if (!candidate) return deny('SKIN_CHOICE_STALE')
      const next = await withLock(directory, () =>
        config.saveSkin(
          { revision: expectedRevision, choice: { kind: 'skin', identity: candidate.identity } },
          roster.current,
        ),
      )
      return { revision: next.revision, choice }
    } catch (error) {
      if (error instanceof ConfigurationError) return deny(error.code)
      throw error
    }
  }
}
