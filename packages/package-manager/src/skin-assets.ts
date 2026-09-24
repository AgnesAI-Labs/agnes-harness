import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExtensionManifest } from '@agnes/extension-api'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'
import type { InstalledInventory } from './inventory.js'
import { readManifestIn } from './manifest.js'

/**
 * Install-time skin limits. These are security and cost invariants rather than deployment tunables,
 * so they are fixed here instead of being exposed as plugin config.
 */
export const SKIN_MAX_CSS_BYTES = 131072
export const SKIN_MAX_ASSET_BYTES = 2097152
export const SKIN_MAX_ASSETS_TOTAL_BYTES = 8388608
export const SKIN_ASSET_EXTENSIONS: readonly string[] = Object.freeze([
  'webp',
  'png',
  'jpg',
  'jpeg',
  'avif',
  'woff2',
  'woff',
])

/** One skin with its containment-checked, size-checked file locations. Paths are symlink-resolved. */
export type ResolvedSkin = {
  id: string
  name: string
  /** Absolute, symlink-resolved path of the skin stylesheet. */
  cssPath: string
  /** Absolute, symlink-resolved `assets/` directory beside the stylesheet, when it exists. */
  assetsDir?: string
  tokens: Record<string, { light: string; dark: string }>
}

function fail(file: string, why: string, reason: string): never {
  throw new PackageError('E_EXT_LOAD', `${file}: ${why}`, { source: { file }, detail: { reason } })
}

/** Recursively collect regular files under `dir` as paths relative to it, using `/` separators. */
function collectFiles(dir: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...collectFiles(join(dir, entry.name), relative))
    else if (entry.isFile()) found.push(relative)
  }
  return found
}

/**
 * Resolve every skin a manifest declares against the package directory, enforcing the stylesheet
 * byte cap, the asset extension allowlist, the per-asset cap and the per-skin asset total.
 * The manifest's lexical checks and the token whitelist belong to `checkManifest`; this owns the
 * filesystem truth, so it is the step that makes a bad skin fail at install rather than at paint.
 * @param dir - Package root directory.
 * @param manifest - Manifest that already passed `checkManifest`.
 * @returns One entry per declared skin, in declaration order.
 */
export function resolveSkins(dir: string, manifest: ExtensionManifest): ResolvedSkin[] {
  const skins = manifest.contributes?.skins ?? []
  if (skins.length === 0) return []
  const file = join(dir, 'agnes.extension.json')
  return skins.map((skin) => {
    const cssPath = containedEntry(dir, skin.css, 'file', file)
    const cssBytes = statSync(cssPath).size
    if (cssBytes > SKIN_MAX_CSS_BYTES)
      fail(
        skin.css,
        `stylesheet is ${cssBytes} bytes, over the ${SKIN_MAX_CSS_BYTES}-byte cap`,
        'skin-css-too-large',
      )

    // The stylesheet's own directory owns its assets, so a skin never reaches a sibling skin's files.
    const cssRelative = skin.css.slice(2)
    const separator = cssRelative.lastIndexOf('/')
    const skinDir = separator === -1 ? '' : cssRelative.slice(0, separator)
    const assetsRelative = skinDir === '' ? './assets' : `./${skinDir}/assets`
    let resolvedAssetsDir: string | undefined
    if (existsSync(join(dir, assetsRelative.slice(2)))) {
      resolvedAssetsDir = containedEntry(dir, assetsRelative, 'directory', file)
      let total = 0
      for (const relative of collectFiles(resolvedAssetsDir)) {
        const extension = extname(relative).slice(1).toLowerCase()
        if (!SKIN_ASSET_EXTENSIONS.includes(extension))
          fail(
            `assets/${relative}`,
            `asset extension .${extension} is not in the skin allowlist`,
            'skin-asset-extension',
          )
        const bytes = statSync(join(resolvedAssetsDir, relative)).size
        if (bytes > SKIN_MAX_ASSET_BYTES)
          fail(
            `assets/${relative}`,
            `asset is ${bytes} bytes, over the ${SKIN_MAX_ASSET_BYTES}-byte cap`,
            'skin-asset-too-large',
          )
        total += bytes
      }
      if (total > SKIN_MAX_ASSETS_TOTAL_BYTES)
        fail(
          `${skin.id}/assets`,
          `assets total ${total} bytes, over the ${SKIN_MAX_ASSETS_TOTAL_BYTES}-byte cap`,
          'skin-assets-too-large',
        )
    }

    return {
      id: skin.id,
      name: skin.name,
      cssPath,
      ...(resolvedAssetsDir === undefined ? {} : { assetsDir: resolvedAssetsDir }),
      tokens: skin.tokens ?? {},
    }
  })
}

/**
 * Extension directories a package bundles, from its own `package.json` `agnes.extensions`.
 *
 * A package's author manifests live here, not at its root: `@agnes/base` and every checked-in
 * example declare `agnes.extensions` and keep each manifest in its own subdirectory. Reading only
 * the package root would therefore find no manifest at all for a real package — and quietly
 * contribute no skins, which is the failure mode this function exists to prevent.
 */
function bundledExtensionDirs(pkgDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      agnes?: { extensions?: unknown }
    }
    const list = raw.agnes?.extensions
    if (!Array.isArray(list)) return []
    return list.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('./'))
  } catch {
    // A directory host was pointed at need not be a package; only a declared list adds manifests.
    return []
  }
}

/**
 * One selectable skin, with the package that owns it.
 *
 * A skin resolved from disk carries `cssPath`; a skin that came from the build (`embeddedSkins`)
 * carries `css` text instead, because a packaged distribution has no source tree to read from.
 * Exactly one of the two is present, and `tokens` is always present.
 */
export type SkinRosterEntry = {
  id: string
  name: string
  packageName: string
  /** Absolute resolved stylesheet path, when the skin came from a package directory. */
  cssPath?: string
  /** Stylesheet text, when the skin came from the build rather than a file. */
  css?: string
  /** Absolute resolved `assets/` directory beside the stylesheet, when it exists on disk. */
  assetsDir?: string
  tokens: Record<string, { light: string; dark: string }>
}

/**
 * A skin carried by the build instead of the filesystem.
 *
 * The packaged distribution compiles builtin packages into the executable and hands their
 * directories no source tree, so the same mechanism that embeds extension manifests
 * (`PackageModule.embeddedExtensions`) has to embed skin data too.
 */
export type EmbeddedSkin = {
  /** Package the skin belongs to, so attribution matches a disk-resolved skin. */
  packageId: string
  id: string
  name: string
  css: string
  tokens?: Record<string, { light: string; dark: string }>
}

/** The complete selectable set plus the evidence a client needs to notice it changed. */
export type SkinRoster = {
  /** Content digest of the roster; a client re-fetches and re-applies when it moves. */
  revision: string
  skins: SkinRosterEntry[]
  /** Skin ids a later package declared but could not own, as `packageName#id`. */
  shadowed: string[]
}

/**
 * Build the selectable skin roster from an installed inventory. Only enabled and trusted packages
 * that resolve to a directory contribute; ids are unique across the roster, so a client addresses a
 * skin by id alone. Two packages claiming one id is not an install error — the lexicographically
 * first package id keeps it and the loser is reported in `shadowed` rather than silently dropped.
 * @param inventory - Immutable installed inventory from the package manager.
 * @returns Roster in package-id order, with a digest over exactly what a client renders from.
 */
export function collectSkinRoster(
  inventory: InstalledInventory,
  embedded: readonly EmbeddedSkin[] = [],
  activeBackendRows: ReadonlySet<string> = new Set(),
): SkinRoster {
  const ordered = [...inventory.packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const skins: SkinRosterEntry[] = []
  const shadowed: string[] = []
  const claimed = new Set<string>()
  /** Claim one skin id for a package, reporting a contested id rather than dropping it silently. */
  const claim = (packageName: string, entry: SkinRosterEntry): void => {
    if (claimed.has(entry.id)) {
      shadowed.push(`${packageName}#${entry.id}`)
      return
    }
    claimed.add(entry.id)
    skins.push(entry)
  }
  // A packaged distribution points every builtin at one directory, and two packages sharing a
  // directory must not each read it: the second read would re-claim the first's skins as conflicts.
  const read = new Set<string>()
  for (const pkg of ordered) {
    if (!pkg.enabled || !pkg.trusted) continue
    let fromDisk = 0
    if (pkg.directory !== null && !read.has(pkg.directory)) {
      read.add(pkg.directory)
      // The package root first, then each bundled extension directory: both patterns are in use, and
      // a skin is contributed by whichever directory carries the manifest that declares it.
      const directories =
        pkg.entry.trust === 'builtin'
          ? [
              pkg.directory,
              ...bundledExtensionDirs(pkg.directory).map((relative) =>
                resolve(pkg.directory as string, relative),
              ),
            ]
          : []
      for (const directory of directories) {
        const manifest = readManifestIn(directory)
        if (manifest === undefined) continue
        for (const skin of resolveSkins(directory, manifest)) {
          fromDisk += 1
          claim(pkg.id, { ...skin, packageName: pkg.id })
        }
      }
      // Client descriptors are data in the same verified snapshot as their backend row. The
      // install/inventory pass already checked the descriptor and every asset; resolve again here
      // from the immutable package directory so the existing skin asset route keeps its limits.
      for (const descriptor of pkg.contributions) {
        if (
          descriptor.kind !== 'client' ||
          !descriptor.skins?.length ||
          !activeBackendRows.has(`${descriptor.rowId}\0${pkg.id}\0${pkg.entry.integrity}`)
        )
          continue
        const directory = resolve(pkg.directory, descriptor.path.slice(2), '..')
        const manifest = { contributes: { skins: descriptor.skins } } as ExtensionManifest
        for (const skin of resolveSkins(directory, manifest)) {
          fromDisk += 1
          claim(pkg.id, { ...skin, packageName: pkg.id })
        }
      }
    }
    // Fallback, not a merge: a packaged distribution carries its builtin skins in the build and has
    // no directory to read, while a source checkout reads them from disk. Merging would double-count.
    if (fromDisk > 0) continue
    for (const skin of embedded) {
      if (skin.packageId !== pkg.id) continue
      claim(pkg.id, {
        id: skin.id,
        name: skin.name,
        packageName: pkg.id,
        css: skin.css,
        tokens: skin.tokens ?? {},
      })
    }
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        inventory.profile,
        skins.map((skin) => [skin.packageName, skin.id, skin.name, skin.tokens, skin.css ?? skin.cssPath]),
        shadowed,
      ]),
    )
    .digest('hex')
  return { revision: `sha256-${digest}`, skins, shadowed }
}

/** Extensions the skin HTTP route may serve, mapped from the file the resolver returns. */
export const SKIN_SERVABLE_EXTENSIONS: readonly string[] = Object.freeze(['css', ...SKIN_ASSET_EXTENSIONS])

/**
 * Map one same-origin request path to the file it serves, or `null` when nothing may be served.
 * This is the whole authority for the skin asset route: it accepts only `/skins/<id>/skin.css` and
 * `/skins/<id>/assets/<relative>`, resolves the result through `realpath`, and re-checks containment
 * after that resolution so a symlink planted inside the assets directory cannot escape the package.
 * @param roster - Roster built by {@link collectSkinRoster}; ids in it are unique.
 * @param pathname - Request pathname, already stripped of query and fragment by the HTTP layer.
 * @returns Absolute canonical path of a regular file, or `null`.
 */
export function resolveSkinAsset(roster: SkinRoster, pathname: string): string | null {
  const prefix = '/skins/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  let id: string
  try {
    id = decodeURIComponent(rest.slice(0, slash))
  } catch {
    return null
  }
  const skin = roster.skins.find((entry) => entry.id === id)
  // An embedded skin has no file behind it; only disk-resolved skins have anything to serve.
  if (skin === undefined || skin.cssPath === undefined) return null
  const cssPath = skin.cssPath
  const tail = rest.slice(slash + 1)
  if (tail === 'skin.css') return canonicalFile(cssPath, undefined)
  if (skin.assetsDir === undefined || !tail.startsWith('assets/')) return null
  const within = tail.slice('assets/'.length)
  if (within === '' || within.includes('\0')) return null
  return canonicalFile(resolve(skin.assetsDir, within), skin.assetsDir)
}

/** Canonicalise and confirm the target is a file, optionally still inside `root` after resolution. */
function canonicalFile(target: string, root: string | undefined): string | null {
  let canonical: string
  try {
    canonical = realpathSync(target)
    if (!statSync(canonical).isFile()) return null
  } catch {
    return null
  }
  if (root === undefined) return canonical
  const rel = relative(root, canonical)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return canonical
}

/** The route a skin's stylesheet is served from; also the base relative references resolve against. */
export function skinCssUrl(id: string): string {
  return `/skins/${id}/skin.css`
}

/**
 * A `url()` reference that already carries its own origin: absolute path, fragment, `data:`, or any
 * `scheme:` form. These must survive untouched.
 */
const ABSOLUTE_URL_REFERENCE = /^(?:[/#]|[a-zA-Z][a-zA-Z0-9+.-]*:)/

/**
 * Rewrite the *relative* `url()` references of a skin stylesheet so they resolve under that skin's
 * own route, and leave every other reference exactly as written.
 *
 * Why this exists: the client applies the stylesheet as **inline text** through
 * `CSSStyleSheet.replaceSync` for a flash-free first paint, and a constructible sheet's base URL is
 * the *document*, not the stylesheet. So an author's `url('assets/aurora.png')` was resolved against
 * the page root and 404'd, even though the asset route served the file perfectly (design §21).
 * Rewriting here — once, in the projection — makes the inline path agree with the `<link href=cssUrl>`
 * fallback, where the browser resolves the same reference against the stylesheet URL.
 *
 * The result is authoritative only for *where the browser looks*; whether anything is served is
 * `resolveSkinAsset`'s decision, so a reference escaping `/skins/<id>/` still 404s rather than
 * becoming reachable.
 * @param css - Stylesheet text exactly as the package author wrote it.
 * @param id - Skin id, which is also its route segment.
 * @returns Stylesheet text whose relative references are absolute skin-route paths.
 */
export function rewriteSkinAssetUrls(css: string, id: string): string {
  const base = `http://skin.invalid${skinCssUrl(id)}`
  return css.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
    (whole: string, quote: string, reference: string) => {
      const trimmed = reference.trim()
      if (trimmed === '' || ABSOLUTE_URL_REFERENCE.test(trimmed)) return whole
      let resolved: URL
      try {
        resolved = new URL(trimmed, base)
      } catch {
        // Unparseable reference: leave it alone rather than emit a half-rewritten URL.
        return whole
      }
      return `url(${quote}${resolved.pathname}${resolved.search}${resolved.hash}${quote})`
    },
  )
}
