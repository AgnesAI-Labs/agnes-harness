import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExtensionManifest } from '@agnes/extension-api'
import type { ClientContribution } from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'

/**
 * Installation-time client asset limits. These are fixed cost and size invariants, not deployment
 * settings, so plugins cannot configure them (the same rationale as the limits in skin-assets.ts).
 */
export const CLIENT_MAX_FILE_BYTES = 4194304
export const CLIENT_MAX_TOTAL_BYTES = 16777216
export const CLIENT_ASSET_EXTENSIONS: readonly string[] = Object.freeze([
  'js',
  'mjs',
  'css',
  'map',
  'gltf',
  'glb',
  'bin',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'ktx2',
  'wasm',
])
export const CLIENT_RESOURCE_MAX_FILE_BYTES = 32 * 1024 * 1024
export const CLIENT_RESOURCE_MAX_TOTAL_BYTES = 128 * 1024 * 1024
const CLIENT_ENTRY_EXTENSIONS: readonly string[] = Object.freeze(['js', 'mjs'])
const CLIENT_STYLE_EXTENSIONS: readonly string[] = Object.freeze(['css'])
const PRIVATE_CONFIG_KEY = /(?:credential|secret|token|api[-_]?key|password|authorization)/i

function fail(file: string, why: string, reason: string): never {
  throw new PackageError('E_EXT_LOAD', `${file}: ${why}`, { source: { file }, detail: { reason } })
}

/**
 * Lexically check package-relative paths: reject absolute paths, a leading `/`, backslashes/drive
 * letters, NUL, and empty, `.` or `..` segments. An optional `./` prefix is allowed; everything
 * else must be a plain package-relative path.
 */
function portableClientPath(value: string): boolean {
  if (value === '' || isAbsolute(value) || /[\\:]/.test(value) || value.includes('\0')) return false
  const body = value.startsWith('./') ? value.slice(2) : value
  if (body === '') return false
  return !body.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

/** Normalize to a package-relative path: strip an optional `./` prefix and leave the rest unchanged; validation guarantees syntax. */
function normalizeClientPath(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

/**
 * `publicConfig` is intentionally a manifest-only browser projection.  It is
 * not a generic escape hatch for runtime configuration: reject the credential
 * shaped names and secret-reference values that commonly cross that boundary.
 * This cannot prove a prose string is harmless, but it makes the safe contract
 * explicit and fail-closed for the credential forms Agnes understands.
 */
export function validatePublicClientConfig(value: unknown, path = 'publicConfig'): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    if (/secret:\/\//i.test(value))
      fail(path, 'public client config cannot contain secret references', 'client-public-config-secret')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validatePublicClientConfig(item, `${path}[${index}]`)
    })
    return
  }
  if (!value || typeof value !== 'object')
    fail(path, 'public client config must be JSON data', 'client-public-config')
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_CONFIG_KEY.test(key))
      fail(
        `${path}.${key}`,
        'public client config cannot contain credential-shaped fields',
        'client-public-config-secret',
      )
    validatePublicClientConfig(item, `${path}.${key}`)
  }
}

function decodeUrlPathSegments(segments: readonly string[]): string[] | null {
  const decoded: string[] = []
  for (const segment of segments) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      value === '' ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('\0')
    )
      return null
    decoded.push(value)
  }
  return decoded
}

/**
 * Canonical `client` field for capability snapshots: preserve styles order; deduplicate and sort
 * slots/services/projections; normalize missing arrays to `[]` and paths to package-relative form.
 * Inspect and inventory verification share this function, yielding identical digest bytes.
 */
export type NormalizedClientContribution = {
  requiresBackendRows?: ClientContribution['requiresBackendRows']
  lifetime?: ClientContribution['lifetime']
  homeEntries?: ClientContribution['homeEntries']
  examplePages?: ClientContribution['examplePages']
  assets?: ClientContribution['assets']
  streams?: ClientContribution['streams']
  intelligentComponents?: ClientContribution['intelligentComponents']
  id?: string
  entry: string
  styles: string[]
  slots: string[]
  slotCatalogVersion?: string
  presentationRoles?: ClientContribution['presentationRoles']
  services: string[]
  projections: string[]
  legacyRowIds?: string[]
  /** Immutable author-declared browser metadata. Never copied from a runtime row. */
  publicConfig?: Readonly<Record<string, unknown>>
}

export function normalizeClientContribution(client: ClientContribution): NormalizedClientContribution {
  if (client.publicConfig !== undefined) validatePublicClientConfig(client.publicConfig)
  const set = (values: readonly string[] | undefined): string[] => [...new Set(values ?? [])].sort()
  return {
    ...(client.requiresBackendRows === undefined
      ? {}
      : { requiresBackendRows: set(client.requiresBackendRows) }),
    ...(client.lifetime === undefined ? {} : { lifetime: client.lifetime }),
    ...(client.homeEntries === undefined ? {} : { homeEntries: client.homeEntries }),
    ...(client.examplePages === undefined ? {} : { examplePages: set(client.examplePages) }),
    ...(client.assets === undefined ? {} : { assets: set(client.assets.map(normalizeClientPath)) }),
    ...(client.streams === undefined ? {} : { streams: set(client.streams) }),
    ...(client.presentationRoles ? { presentationRoles: [...client.presentationRoles].sort() } : {}),
    ...(client.id === undefined ? {} : { id: client.id }),
    entry: normalizeClientPath(client.entry),
    ...(client.intelligentComponents ? { intelligentComponents: client.intelligentComponents } : {}),
    styles: (client.styles ?? []).map(normalizeClientPath),
    slots: set(client.slots),
    ...(client.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: client.slotCatalogVersion }),
    services: set(client.services),
    projections: set(client.projections),
    ...(client.legacyRowIds === undefined ? {} : { legacyRowIds: [...new Set(client.legacyRowIds)] }),
    ...(client.publicConfig === undefined ? {} : { publicConfig: client.publicConfig }),
  }
}

/** Validated real file locations (after realpath) for a manifest declaring client entry/styles. */
export type ResolvedClientAssets = {
  /** Absolute client entry path with symlinks resolved. */
  entryPath: string
  /** Absolute stylesheet paths in declaration order with symlinks resolved. */
  stylePaths: string[]
}

/**
 * Verify declared client assets against the package directory: lexical paths, allowed extensions,
 * per-file and total limits, and containment in the install tree (`containedEntry` also refuses
 * escaping symlinks).
 *
 * This is **format validation, not a security boundary**: it neither analyzes the import closure
 * nor scans source contents. Snapshot delivery and trust decisions separately control browser loading.
 *
 * @param dir - Package root directory.
 * @param manifest - Manifest accepted by `checkManifest`.
 * @returns Resolved assets when client is declared, otherwise `undefined`.
 */
export function resolveClientAssets(
  dir: string,
  manifest: ExtensionManifest,
): ResolvedClientAssets | undefined {
  const client = manifest.contributes?.client
  if (client === undefined) return undefined
  if (client.publicConfig !== undefined) validatePublicClientConfig(client.publicConfig)
  const file = join(dir, 'package.json')
  const assets = [
    { path: client.entry, extensions: CLIENT_ENTRY_EXTENSIONS, reason: 'client-entry-extension' },
    ...(client.assets ?? []).map((path) => ({
      path,
      extensions: CLIENT_ASSET_EXTENSIONS,
      reason: 'client-asset-extension',
    })),
    ...(client.styles ?? []).map((path) => ({
      path,
      extensions: CLIENT_STYLE_EXTENSIONS,
      reason: 'client-style-extension',
    })),
  ]
  const resolved: string[] = []
  let total = 0
  for (const asset of assets) {
    const { path } = asset
    if (!portableClientPath(path))
      fail(path, 'client asset is not a portable relative path inside the package', 'client-path')
    const extension = extname(path).slice(1).toLowerCase()
    if (!asset.extensions.includes(extension))
      fail(path, `client asset extension .${extension} is not valid for this field`, asset.reason)
    // containedEntry checks existence, file type and containment after realpath.
    const target = containedEntry(dir, path, 'file', file)
    const bytes = statSync(target).size
    const resource =
      (client.assets ?? []).includes(path) &&
      !CLIENT_ENTRY_EXTENSIONS.includes(extension) &&
      extension !== 'css' &&
      extension !== 'map'
    const limit = client.intelligentComponents
      ? 262144
      : resource
        ? CLIENT_RESOURCE_MAX_FILE_BYTES
        : CLIENT_MAX_FILE_BYTES
    if (bytes > limit)
      fail(path, `client asset is ${bytes} bytes, over the ${limit}-byte cap`, 'client-asset-too-large')
    total += bytes
    resolved.push(target)
  }
  if (total > (client.assets?.length ? CLIENT_RESOURCE_MAX_TOTAL_BYTES : CLIENT_MAX_TOTAL_BYTES))
    fail(
      client.entry,
      `client assets total ${total} bytes, over the ${CLIENT_MAX_TOTAL_BYTES}-byte cap`,
      'client-assets-too-large',
    )
  const entryPath = resolved[0]
  if (entryPath === undefined) fail(client.entry, 'client entry did not resolve', 'client-path')
  return { entryPath, stylePaths: resolved.slice(1 + (client.assets?.length ?? 0)) }
}

/** Reviewed client code and scene resource formats; the immutable snapshot is the file allow-list. */
export const CLIENT_MODULE_SERVABLE_EXTENSIONS: readonly string[] = CLIENT_ASSET_EXTENSIONS

/** Package id syntax (matching the lockfile schema): one segment, or two as `scope/name`. */
const PACKAGE_ID_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/

/**
 * Resolve `/plugins/<packageId>/<revision>/<package-relative-path>` to a snapshot file or `null`.
 * This is the sole resolver for web delivery. Revision segments must not start with `_`:
 * `/plugins/<id>/_api/` is reserved for future plugin HTTP routes. Check containment again after
 * realpath so symlinks inside a snapshot cannot escape its revision directory. The caller supplies
 * the snapshot root; this function knows nothing about the install tree. Misses and refusals return `null`.
 *
 * packageId may occupy one segment (`acme/pkg`) or two (`@scope/pkg`); disambiguate by the
 * existence of the snapshot directory, trying two segments before one.
 *
 * @param snapshotRoot - Daemon-managed snapshot root, organized as `<packageId>/<revision>/`.
 * @param pathname - Request path with query and fragment already removed by the HTTP layer.
 * @returns Absolute canonical path of a regular file, or `null`.
 */
export function resolveClientModuleAsset(snapshotRoot: string, pathname: string): string | null {
  const prefix = '/plugins/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest.includes('\0')) return null
  const segments = rest.split('/')
  for (const idSegments of [2, 1]) {
    // Require the id segments, a revision segment and at least one package-relative path segment.
    if (segments.length < idSegments + 2) continue
    const id = segments.slice(0, idSegments).join('/')
    if (!PACKAGE_ID_PATTERN.test(id)) continue
    const revision = segments[idSegments] as string
    // Reject revisions starting with `_` (including reserved `_api`), `.`, `..` and empty segments
    // under either split, so `/plugins/<id>/_api/…` cannot pass as a one-segment id and normal revision.
    if (revision === '' || revision === '.' || revision === '..' || revision.startsWith('_')) return null
    let base: string
    try {
      base = nativeRealpathSync(join(snapshotRoot, id, revision))
      if (!statSync(base).isDirectory()) continue
      // A revision directory may itself be a symlink escaping the snapshot root after realpath.
      // Prove base is inside the snapshot root before using it as the containment root.
      const canonicalRoot = nativeRealpathSync(snapshotRoot)
      const baseRel = relative(canonicalRoot, base)
      if (baseRel === '' || baseRel === '..' || baseRel.startsWith(`..${sep}`) || isAbsolute(baseRel))
        continue
    } catch {
      continue
    }
    const decodedWithin = decodeUrlPathSegments(segments.slice(idSegments + 1))
    if (!decodedWithin) return null
    const within = decodedWithin.join('/')
    const extension = extname(within).slice(1).toLowerCase()
    if (!CLIENT_MODULE_SERVABLE_EXTENSIONS.includes(extension)) return null
    return canonicalFile(resolve(base, within), base)
  }
  return null
}

/** Canonicalize the target path and check that it is a regular file inside `root` after realpath. */
function canonicalFile(target: string, root: string): string | null {
  let canonical: string
  try {
    canonical = nativeRealpathSync(target)
    if (!statSync(canonical).isFile()) return null
  } catch {
    return null
  }
  const rel = relative(root, canonical)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return canonical
}

/** Resolve row identity without using entry/style paths or declaration order. */
export function clientModuleRowIdForContribution(
  packageId: string,
  _extensionId: string,
  clientCount: number,
  contributionId: string,
): string {
  if (clientCount === 1) return `web:${packageId}`
  const readable = `web:${packageId}:${contributionId}`
  // The browser protocol bounds a row id to 256 bytes while package/extension
  // identifiers have independent maxima. Keep the readable form where it is
  // valid, and use a deterministic full digest rather than truncating either
  // identity (truncation could silently collide and join two lifecycle lanes).
  if (readable.length <= 256) return readable
  return `web:${createHash('sha256').update(`${packageId}\0${contributionId}`).digest('hex')}`
}
