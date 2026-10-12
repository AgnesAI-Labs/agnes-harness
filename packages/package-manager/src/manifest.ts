import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bundledExtensionManifest, checkManifest, type ExtensionManifest } from '@agnes/extension-api'
import { resolveClientAssets } from './client-assets.js'
import { resolveEntry } from './entry-path.js'
import { PackageError } from './errors.js'
import { parseAgnesPluginEntries } from './plugin-manifest.js'
import { resolveSkins } from './skin-assets.js'

const MAX_JSON_BYTES = 1048576

/** Parsed `package.json` of one bundled plugin directory, bounded and checked as plain data. */
export function readBundledPackageJson(dir: string): Record<string, unknown> | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    if (statSync(file).size > MAX_JSON_BYTES) throw new Error('too large')
    const text = readFileSync(file, 'utf8')
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('too large')
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new PackageError('E_EXT_LOAD', 'package.json is not valid JSON', {
      source: { file },
      detail: { reason: 'invalid-manifest' },
    })
  }
}

/** Full manifest of a bundled plugin directory, checked without executing its entry. */
export function readBundledManifest(dir: string): ExtensionManifest | undefined {
  const file = join(dir, 'package.json')
  const pkg = readBundledPackageJson(dir)
  if (pkg === undefined) return undefined
  const raw = bundledExtensionManifest(pkg)
  if (raw === undefined) return undefined
  parseAgnesPluginEntries(String(pkg.name), (pkg.agnes as { plugins?: unknown }).plugins, { bundled: true })
  const checked = checkManifest(raw)
  if (!checked.ok)
    throw new PackageError('E_EXT_LOAD', 'the bundled plugin manifest does not validate', {
      source: { file },
      detail: { reason: 'invalid-manifest', problems: checked.problems },
    })
  resolveEntry(dir, checked.value.entry)
  // Filesystem truth (stylesheet bytes, asset allowlist, asset totals) is checked here, so a skin
  // that passes the lexical manifest rules but ships oversized or disallowed files fails at load.
  resolveSkins(dir, checked.value)
  // Same treatment for client modules: path form, extension allowlist, size caps and existence are
  // filesystem truth, so a client contribution that passes the lexical rules but ships bad files
  // fails here at load, not when the page asks for it.
  resolveClientAssets(dir, checked.value)
  return checked.value
}
