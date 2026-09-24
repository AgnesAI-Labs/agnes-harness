import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_VERSION,
  type ExtensionManifest as AuthorManifest,
  checkManifest,
  satisfiesApiRange,
} from '@agnes/extension-api'
import { containedEntry, resolveEntry as resolvePackageEntry } from '@agnes/package-manager'
import { HostError } from '../errors.js'
import { compat } from '../packages/compat.js'

/** The file a bundled extension declares itself in. It is read before its entry is executed. */
export const MANIFEST_FILE = 'agnes.extension.json'

/**
 * What a manifest grants on the tool surface. `names: null` means the declared prefix is the only
 * bound; a list means a closed set, and a name outside it is refused even when it carries the
 * prefix. An extension that declares no tools at all gets an empty list, which grants nothing.
 */
export type ToolAuthority = { prefix: string; names: readonly string[] | null }
export type ExtensionManifest = {
  id: string
  version: string
  apiRange: string
  entry: string
  tools: ToolAuthority
}

function fail(file: string, why: string, detail: Record<string, unknown> = {}): never {
  throw new HostError('E_EXT_LOAD', `${file}: ${why}`, { detail: { file, ...detail } })
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function readJsonFile(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    fail(file, `cannot be read (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`, {
      reason: 'unreadable',
      errno: (e as NodeJS.ErrnoException).code,
    })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail(file, 'is not valid JSON', { reason: 'not-json' })
  }
  if (!isObject(value)) fail(file, 'must be a JSON object', { reason: 'not-an-object' })
  return value
}

function stringField(file: string, o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v === '')
    fail(file, `${key} must be a non-empty string`, { reason: 'bad-field', field: key })
  return v
}

/** Author API owns range semantics; host retains its diagnostic error boundary. */
export function checkApiRange(file: string, range: string, apiVersion: string = API_VERSION): void {
  if (!satisfiesApiRange(range, apiVersion))
    throw new HostError('E_API_RANGE', `${file}: extension API version is incompatible`, {
      detail: { file, range, apiVersion },
    })
}

/**
 * Return the checked canonical target, never an unresolved fallback. This is a loading boundary,
 * not protection against a concurrent writer changing the filesystem after the check.
 */
const contained = compat(containedEntry)
export const resolveEntry = compat(resolvePackageEntry)

function toolAuthority(file: string, capabilities: unknown): ToolAuthority {
  if (!isObject(capabilities)) fail(file, 'capabilities must be an object', { reason: 'bad-capabilities' })
  const t = capabilities.tools
  // No tools block is a manifest that asks for no tool authority, which is a different statement
  // from an empty prefix: every registerTool call is then refused.
  if (t === undefined) return { prefix: '', names: [] }
  if (!isObject(t)) fail(file, 'capabilities.tools must be an object', { reason: 'bad-capabilities' })
  // An empty prefix is a real declaration, not a missing one: the core tools are declared with no
  // prefix at all, so this cannot go through the non-empty-string check the other fields use.
  if (t.prefix !== undefined && typeof t.prefix !== 'string')
    fail(file, 'capabilities.tools.prefix must be a string', { reason: 'bad-capabilities' })
  const prefix = typeof t.prefix === 'string' ? t.prefix : ''
  if (t.names === undefined) return { prefix, names: null }
  if (!Array.isArray(t.names))
    fail(file, 'capabilities.tools.names must be an array of strings', { reason: 'bad-capabilities' })
  const names: string[] = []
  for (const n of t.names) {
    if (typeof n !== 'string' || n === '')
      fail(file, 'capabilities.tools.names must be an array of strings', { reason: 'bad-capabilities' })
    // A declared name that does not carry the declared prefix is a manifest at odds with itself:
    // one of the two rules would have to lose at registration time, and which one is not written
    // down anywhere.
    if (!n.startsWith(prefix))
      fail(file, `capabilities.tools.names has ${n}, which lacks the declared prefix ${prefix}`, {
        reason: 'bad-capabilities',
        tool: n,
      })
    names.push(n)
  }
  return { prefix, names }
}

/** Reads and checks one extension's manifest. Nothing in the extension has been executed yet. */
export function readExtensionManifest(dir: string): ExtensionManifest {
  const file = join(dir, MANIFEST_FILE)
  const raw = readJsonFile(file)
  const apiRange = stringField(file, raw, 'apiRange')
  checkApiRange(file, apiRange)
  const entry = stringField(file, raw, 'entry')
  // Checked here as well as at load time, so a manifest that points outside its own directory is
  // refused by whoever reads it rather than only by whoever imports it.
  resolveEntry(dir, entry)
  return {
    id: stringField(file, raw, 'id'),
    version: stringField(file, raw, 'version'),
    apiRange,
    entry,
    tools: toolAuthority(file, raw.capabilities),
  }
}

/**
 * The extension directories one package bundles, taken from its own `package.json`. Discovery is
 * never a directory scan: a package is what the lockfile pins, and this list is a declaration
 * inside that pin, so dropping a directory into `extensions/` does not make it run. A package
 * carrying no declaration bundles no extensions.
 */
export function readBundledExtensionDirs(pkgDir: string, allowBuiltinDescriptors = false): string[] {
  const file = join(pkgDir, 'package.json')
  let raw: Record<string, unknown>
  try {
    raw = readJsonFile(file)
  } catch (e) {
    // A package directory with no package.json is a directory host was pointed at, not a package
    // that declared something host then failed to read; a malformed one is the second and is loud.
    if ((e as HostError).detail?.reason === 'unreadable' && (e as HostError).detail?.errno === 'ENOENT')
      return []
    throw e
  }
  const agnes = raw.agnes
  if (agnes === undefined) return []
  if (!isObject(agnes)) fail(file, 'agnes must be an object', { reason: 'bad-package' })
  if (!allowBuiltinDescriptors && agnes.extensions !== undefined)
    fail(file, 'third-party agnes.extensions is retired; migrate the backend to agnes.plugins', {
      reason: 'legacy-extension-format',
    })
  const list = agnes.extensions
  if (list === undefined) return []
  if (!Array.isArray(list))
    fail(file, 'agnes.extensions must be an array of directories', { reason: 'bad-package' })
  return list.map((entry) => {
    if (typeof entry !== 'string' || entry === '')
      fail(file, 'agnes.extensions must be an array of directories', { reason: 'bad-package' })
    return contained(pkgDir, entry, 'directory', file)
  })
}

/** Full contract for the planned loader; the legacy tool-only reader is retired at assembly migration. */
export function readAuthorManifest(dir: string, apiVersion: string = API_VERSION): AuthorManifest {
  const file = join(dir, MANIFEST_FILE)
  const checked = checkManifest(readJsonFile(file))
  if (!checked.ok) fail(file, 'invalid extension manifest', { reason: 'invalid-manifest' })
  checkApiRange(file, checked.value.apiRange, apiVersion)
  return checked.value
}
