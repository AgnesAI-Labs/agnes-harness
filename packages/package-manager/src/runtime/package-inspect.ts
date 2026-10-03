import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { jcs } from '@agnes/protocol'
import { validateRuntime, type RuntimeWireTypes as Wire } from '@agnes/protocol/runtime'
import {
  digestJson,
  MANIFEST_FILE,
  type PackageOutcome,
  type PackageRefusal,
  readPackageTree,
  refuse,
  sha256Hex,
  type TreeFile,
  ZERO_DIGEST,
} from './source-snapshot.js'

type Manifest = Wire['RuntimePluginManifest']
type Target = Exclude<keyof Manifest['entries'], 'runtime'>

/** Source declaration, deliberately separate from the generated manifest's build metadata. */
export interface SourceBuildDeclaration {
  readonly script: string
  readonly network: readonly string[]
  readonly readPaths: readonly string[]
  readonly writePaths: readonly string[]
  readonly secretEnv?: readonly string[]
}

/** The source owner supplies bytes and the identity actually fetched, never a branch/tag alias. */
export interface AcquiredPackage {
  readonly locator: Wire['PackageLocator']
  readonly content: { readonly root: string } | { readonly archive: Buffer }
  readonly build?: SourceBuildDeclaration
}

export interface PackageBuildPlan {
  readonly packageId: string
  readonly version: string
  readonly packageDigest: string
  readonly manifestDigest: string
  readonly locator: Wire['PackageLocator']
  readonly archiveIntegrity: string | null
  readonly steps: readonly SourceBuildDeclaration[]
  readonly status: 'no-build' | 'approval-required'
  readonly digest: string
}

export interface PackageInspection {
  readonly manifest: Manifest
  readonly packageDigest: string
  readonly manifestDigest: string
  readonly archiveIntegrity: string | null
  readonly productionDependencies: Manifest['dependencies']
  readonly buildPlan: PackageBuildPlan
}

export interface PackageInspectInput {
  readonly lock: Wire['PackageLockEntry']
  readonly acquire: (signal?: AbortSignal) => Promise<PackageOutcome<AcquiredPackage>>
  readonly requiredUi?: readonly { readonly target: Target; readonly rendererId?: string }[]
  readonly signal?: AbortSignal
}

const deny = (detail: string): PackageRefusal => refuse('denied', detail, 'package inspection refused')
const cancelled = (): PackageRefusal => refuse('cancelled', 'download_cancelled', 'acquisition cancelled')
const portable = (path: string): boolean =>
  path !== '' &&
  !/[\\:]/.test(path) &&
  !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  !path.split('/').some((part) => part === '' || part === '.' || part === '..')
const utf8Order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

function readJson(file: TreeFile | undefined): unknown {
  if (!file) return null
  try {
    return JSON.parse(file.bytes.toString('utf8')) as unknown
  } catch {
    return null
  }
}

function treeOf(content: AcquiredPackage['content']): PackageOutcome<TreeFile[]> {
  if ('root' in content) return readPackageTree(content.root)
  if (content.archive.length > 32 * 1024 * 1024) return deny('package_too_large')
  let bytes = content.archive
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      bytes = gunzipSync(bytes, { maxOutputLength: 40 * 1024 * 1024 })
  } catch {
    return deny('archive_invalid')
  }
  if (bytes.length % 512 !== 0 || bytes.length < 1024 || !bytes.subarray(-1024).every((byte) => byte === 0))
    return deny('archive_invalid')
  const files: TreeFile[] = []
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) {
      if (!bytes.subarray(offset).every((byte) => byte === 0)) return deny('archive_invalid')
      break
    }
    const number = (start: number, length: number): number => {
      const text = header
        .toString('ascii', start, start + length)
        .replace(/\0.*$/, '')
        .trim()
      return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN
    }
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (number(148, 8) !== sum) return deny('archive_invalid')
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
    const path = prefix ? `${prefix}/${name}` : name
    const type = header[156]
    if (type === 0x31 || type === 0x32) return deny('symlink_escape')
    if (type !== 0 && type !== 0x30 && type !== 0x35) return deny('special_entry')
    const canonical = type === 0x35 && path.endsWith('/') ? path.slice(0, -1) : path
    if (!portable(canonical)) return deny('path_escape')
    const size = number(124, 12),
      mode = number(100, 8)
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(mode) ||
      offset + size + ((512 - (size % 512)) % 512) > bytes.length - 1024
    )
      return deny('archive_invalid')
    if (type === 0x35 && size !== 0) return deny('archive_invalid')
    if (type !== 0x35)
      files.push({
        path,
        mode: mode & 0o111 ? 'executable' : 'file',
        bytes: Buffer.from(bytes.subarray(offset, offset + size)),
      })
    offset += size + ((512 - (size % 512)) % 512)
    if (files.length > 4098) return deny('package_too_large')
  }
  // npm's package/ wrapper is transport metadata, removed consistently before locking the tree.
  const wrapped = files.length > 0 && files.every((file) => file.path.startsWith('package/'))
  return {
    ok: true,
    value: files.map((file) => ({
      ...file,
      path: wrapped ? file.path.slice('package/'.length) : file.path,
    })),
  }
}

function checkTree(files: readonly TreeFile[]): PackageRefusal | null {
  const folded = new Set<string>()
  const filePaths = new Set(files.map((file) => file.path))
  let bytes = 0
  if (files.length > 4098) return deny('package_too_large')
  for (const file of files) {
    if (!portable(file.path)) return deny('path_escape')
    // Include directory prefixes so A/x and a/y conflict on case insensitive filesystems too.
    const parts = file.path.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/')
      if (index < parts.length && filePaths.has(path)) return deny('path_conflict')
    }
    if (folded.has(file.path.toLowerCase())) return deny('case_conflict')
    folded.add(file.path.toLowerCase())
    if (file.bytes.length > 8 * 1024 * 1024) return deny('package_too_large')
    bytes += file.bytes.length
  }
  const paths = new Map<string, string>()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/'),
        key = path.toLowerCase()
      if (paths.has(key) && paths.get(key) !== path) return deny('case_conflict')
      paths.set(key, path)
    }
  }
  return bytes > 32 * 1024 * 1024 ? deny('package_too_large') : null
}

function checkFiles(manifest: Manifest, files: readonly TreeFile[]): PackageRefusal | null {
  const listed = new Set<string>(),
    folded = new Set<string>()
  for (const row of manifest.files) {
    const path = row.path.slice(2)
    if (!row.path.startsWith('./') || !portable(path)) return deny('path_escape')
    if (path === MANIFEST_FILE || path === 'agnes.client.json') return deny('metadata_in_files')
    if (folded.has(path.toLowerCase())) return deny('case_conflict')
    folded.add(path.toLowerCase())
    listed.add(path)
    const file = files.find((item) => item.path === path)
    if (!file) return deny('file_missing')
    if (file.bytes.length !== row.bytes || sha256Hex(file.bytes) !== row.digest)
      return deny('file_digest_mismatch')
  }
  if (
    files.some(
      (file) => file.path !== MANIFEST_FILE && file.path !== 'agnes.client.json' && !listed.has(file.path),
    )
  )
    return deny('file_unlisted')
  const references = [
    ...Object.values(manifest.entries),
    ...manifest.providers.map((provider) => provider.factory.entry),
    ...manifest.domains.flatMap((domain) => [
      domain.reducer.entry,
      domain.selectAuthorized.entry,
      ...domain.commands.map((command) => command.handler.entry),
    ]),
    ...manifest.renderers.map((renderer) => renderer.entry),
    ...manifest.clientServices.map((service) => service.entry.entry),
    ...(manifest.interceptors ?? []).map((interceptor) => interceptor.handler.entry),
  ]
  for (const path of references) {
    if (!path.startsWith('./') || !portable(path.slice(2))) return deny('path_escape')
    if (!files.some((file) => `./${file.path}` === path)) return deny('entry_missing')
    if (!listed.has(path.slice(2))) return deny('entry_unlisted')
  }
  for (const schema of manifest.schemas) {
    if (!listed.has(schema.path.slice(2))) return deny('schema_unlisted')
    const document = readJson(files.find((file) => `./${file.path}` === schema.path))
    if (!document || digestJson(document) !== schema.ref.digest) return deny('schema_digest_mismatch')
  }
  const styles = new Set<string>()
  for (const style of 'clientAssets' in manifest ? manifest.clientAssets.styles : []) {
    if (!style.path.startsWith('./') || !portable(style.path.slice(2))) return deny('path_escape')
    if (!style.path.endsWith('.css') || !listed.has(style.path.slice(2))) return deny('ui_asset_missing')
    if (styles.has(style.path)) return deny('ui_asset_conflict')
    styles.add(style.path)
    if (style.kind === 'skin') {
      const file = files.find((item) => `./${item.path}` === style.path)
      if ((file?.bytes.length ?? 0) > 128 * 1024) return deny('skin_too_large')
      // Skin resource closure and theme projection need the owning UI bundle validator.
      return deny('skin_assets_unqualified')
    }
  }
  for (const requests of [
    ...manifest.providers.map((provider) => provider.descriptor.capabilities),
    ...(manifest.interceptors ?? []).map((interceptor) => interceptor.permissions),
  ]) {
    for (const requested of requests) {
      if (
        !manifest.permissions.runtime.some(
          (upper) =>
            upper.capability === requested.capability &&
            requested.resourceTypes.every((type) => upper.resourceTypes.includes(type)) &&
            requested.operations.every((operation) => upper.operations.includes(operation)),
        )
      )
        return deny('permission_escalation')
    }
  }
  return null
}

/** Only schema-owned self references are zeroed; arbitrary user packageDigest keys stay hashed. */
function zeroManifest(manifest: Manifest): unknown {
  return {
    ...manifest,
    packageDigest: ZERO_DIGEST,
    providers: manifest.providers.map((row) => ({
      ...row,
      descriptor: { ...row.descriptor, packageDigest: ZERO_DIGEST },
    })),
    renderers: manifest.renderers.map((row) => ({ ...row, packageDigest: ZERO_DIGEST })),
    clientServices: manifest.clientServices.map((row) => ({ ...row, packageDigest: ZERO_DIGEST })),
  }
}

function checkLockIdentity(lock: Wire['PackageLockEntry']): PackageRefusal | null {
  if (lock.locator.digest !== lock.digest) return deny('package_digest_mismatch')
  if (lock.locator.kind === 'git' && !/^[a-f0-9]{40}$/.test(lock.locator.commit))
    return deny('git_commit_unlocked')
  if (
    lock.locator.kind === 'npm' &&
    (lock.locator.name !== lock.packageId || lock.locator.version !== lock.version)
  )
    return deny('npm_version_unlocked')
  return null
}

function checkIdentity(lock: Wire['PackageLockEntry'], acquired: AcquiredPackage): PackageRefusal | null {
  if (!validateRuntime('PackageLocator', acquired.locator).ok) return deny('source_identity_mismatch')
  if (jcs(lock.locator) !== jcs(acquired.locator)) return deny('source_identity_mismatch')
  if (lock.locator.kind === 'npm') {
    if (!('archive' in acquired.content)) return deny('archive_integrity_missing')
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(lock.locator.integrity)
    if (!match) return deny('archive_integrity_invalid')
    const hash = createHash(match[1] ?? '').update(acquired.content.archive)
    const actual = hash.digest()
    const claimed = match[2] ?? ''
    // The existing source provider uses sha256 hex; npm SRI uses base64. Both remain byte identities.
    if (
      claimed !== actual.toString('base64') &&
      !(match[1] === 'sha256' && claimed === actual.toString('hex'))
    )
      return deny('archive_integrity_mismatch')
  }
  return null
}

function checkDependencies(manifest: Manifest, files: readonly TreeFile[]): PackageRefusal | null {
  const identities = new Map<string, string>()
  for (const dependency of manifest.dependencies) {
    const prior = identities.get(dependency.packageId)
    if (prior && prior !== `${dependency.kind}:${dependency.versionRange}`) return deny('dependency_conflict')
    identities.set(dependency.packageId, `${dependency.kind}:${dependency.versionRange}`)
  }
  const packageFile = files.find((file) => file.path === 'package.json')
  if (!packageFile) return null
  const raw = readJson(packageFile)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny('package_json_invalid')
  const source = raw as Record<string, unknown>
  const expected = new Map<string, string>()
  for (const [field, kind] of [
    ['dependencies', 'runtime'],
    ['peerDependencies', 'peer'],
  ] as const) {
    const rows = source[field] ?? {}
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return deny('dependency_invalid')
    for (const [id, range] of Object.entries(rows)) {
      if (typeof range !== 'string') return deny('dependency_invalid')
      expected.set(id, `${kind}:${range}`)
      if (identities.get(id) !== `${kind}:${range}`) return deny('dependency_mismatch')
    }
  }
  // External contract references are allowed, but dev-only packages cannot enter the runtime graph.
  if (source.devDependencies && typeof source.devDependencies === 'object') {
    for (const id of Object.keys(source.devDependencies))
      if (!expected.has(id) && identities.has(id)) return deny('dev_dependency_in_runtime')
  }
  return null
}

function buildPlan(
  manifest: Manifest,
  manifestDigest: string,
  acquired: AcquiredPackage,
  archiveIntegrity: string | null,
): PackageOutcome<PackageBuildPlan> {
  const build = acquired.build
  if (
    build &&
    (Object.keys(build).some(
      (key) => !['script', 'network', 'readPaths', 'writePaths', 'secretEnv'].includes(key),
    ) ||
      typeof build.script !== 'string' ||
      build.script.trim() === '' ||
      ![build.network, build.readPaths, build.writePaths, build.secretEnv ?? []].every(
        (rows) => Array.isArray(rows) && rows.every((row) => typeof row === 'string' && row !== ''),
      ))
  )
    return deny('build_declaration_invalid')
  if (
    build &&
    [...build.readPaths, ...build.writePaths].some(
      (path) => path !== './' && (!path.startsWith('./') || !portable(path.slice(2))),
    )
  )
    return deny('build_path_escape')
  const body = {
    packageId: manifest.id,
    version: manifest.version,
    packageDigest: manifest.packageDigest,
    manifestDigest,
    locator: acquired.locator,
    archiveIntegrity,
    steps: build ? [build] : [],
    status: build ? ('approval-required' as const) : ('no-build' as const),
  }
  return { ok: true, value: { ...body, digest: digestJson(body) } }
}

/** Read-only static gate shared by local/npm/Git after exact source locking. Never imports an entry. */
export async function inspectLockedPackage(
  input: PackageInspectInput,
): Promise<PackageOutcome<PackageInspection>> {
  if (input.signal?.aborted) return cancelled()
  if (!validateRuntime('PackageLockEntry', input.lock).ok) return deny('lock_invalid')
  const lockIdentity = checkLockIdentity(input.lock)
  if (lockIdentity) return lockIdentity
  let acquisition: PackageOutcome<AcquiredPackage>
  let onAbort: (() => void) | undefined
  try {
    const abort = new Promise<PackageOutcome<AcquiredPackage>>((resolve) => {
      onAbort = () => resolve(cancelled())
      input.signal?.addEventListener('abort', onAbort, { once: true })
    })
    acquisition = await Promise.race([input.acquire(input.signal), abort])
  } catch {
    return input.signal?.aborted ? cancelled() : deny('source_unavailable')
  } finally {
    if (onAbort) input.signal?.removeEventListener('abort', onAbort)
  }
  if (input.signal?.aborted) return cancelled()
  if (!acquisition.ok) return acquisition
  const acquired = acquisition.value
  const identity = checkIdentity(input.lock, acquired)
  if (identity) return identity
  const tree = treeOf(acquired.content)
  if (!tree.ok) return tree
  const treeFailure = checkTree(tree.value)
  if (treeFailure) return treeFailure
  const parsed = validateRuntime(
    'RuntimePluginManifest',
    readJson(tree.value.find((file) => file.path === MANIFEST_FILE)),
  )
  if (!parsed.ok) return deny('manifest_invalid')
  const manifest = parsed.value
  if (manifest.build.reproducible) return deny('reproducibility_unverified')
  if (manifest.id !== input.lock.packageId || manifest.version !== input.lock.version)
    return deny('package_identity_mismatch')
  const filesFailure = checkFiles(manifest, tree.value)
  if (filesFailure) return filesFailure
  const dependencies = checkDependencies(manifest, tree.value)
  if (dependencies) return dependencies
  for (const contribution of [...manifest.renderers, ...manifest.clientServices]) {
    if (contribution.targets.some((target) => !manifest.entries[target])) return deny('required_ui_missing')
  }
  for (const request of input.requiredUi ?? []) {
    if (
      !manifest.entries[request.target] ||
      (request.rendererId &&
        !manifest.renderers.some(
          (row) => row.id === request.rendererId && row.targets.includes(request.target),
        ))
    )
      return deny('required_ui_missing')
  }
  // No public runtime schema for the generated legacy client descriptor is delivered yet.
  // Refuse it rather than recursively zeroing arbitrary JSON or accepting an unverified projection.
  if (tree.value.some((file) => file.path === 'agnes.client.json'))
    return deny('client_descriptor_unqualified')
  const records = tree.value
    .slice()
    .sort((a, b) => utf8Order(a.path, b.path))
    .map((file) => {
      const bytes = file.path === MANIFEST_FILE ? Buffer.from(jcs(zeroManifest(manifest))) : file.bytes
      return { path: file.path, mode: file.mode, bytes: bytes.length, digest: sha256Hex(bytes) }
    })
  const packageDigest = digestJson(records),
    manifestDigest = digestJson(manifest)
  if (manifest.packageDigest !== packageDigest || input.lock.digest !== packageDigest)
    return deny('package_digest_mismatch')
  if (
    [
      ...manifest.renderers,
      ...manifest.clientServices,
      ...manifest.providers.map((row) => row.descriptor),
    ].some((row) => row.packageDigest !== packageDigest)
  )
    return deny('self_digest_mismatch')
  const ref = input.lock.manifestRef
  const expectedManifestDigest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
  if (
    expectedManifestDigest !== manifestDigest ||
    (ref.kind === 'inline' &&
      (jcs(ref.value) !== jcs(manifest) || ref.bytes !== Buffer.byteLength(jcs(manifest))))
  )
    return deny('manifest_digest_mismatch')
  const archiveIntegrity =
    acquired.locator.kind === 'npm'
      ? acquired.locator.integrity
      : 'archive' in acquired.content
        ? `sha256-${sha256Hex(acquired.content.archive)}`
        : null
  const plan = buildPlan(manifest, manifestDigest, acquired, archiveIntegrity)
  if (!plan.ok) return plan
  return {
    ok: true,
    value: {
      manifest,
      packageDigest,
      manifestDigest,
      archiveIntegrity,
      productionDependencies: manifest.dependencies,
      buildPlan: plan.value,
    },
  }
}

/** Preflight only. An approved plan still cannot execute until qualified Sandbox/Exec are delivered. */
export function checkPackageBuildExecution(
  plan: PackageBuildPlan,
  approvedPlanDigest: string | null,
): PackageOutcome<never> {
  const { digest, ...body } = plan
  if (digestJson(body) !== digest) return deny('build_plan_changed')
  if (plan.steps.some((step) => (step.secretEnv?.length ?? 0) > 0)) return deny('secret_consumer_unavailable')
  if (plan.steps.length === 0) return deny('build_not_required')
  if (approvedPlanDigest !== digest) return deny('build_unapproved')
  return deny('sandbox_unavailable')
}
