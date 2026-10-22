import { createHash } from 'node:crypto'
import {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runIsolatedCommand } from '@agnes/package-isolation'
import type { PackageProvenance } from '@agnes/protocol'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import {
  bundledExampleSource,
  bundledPluginSource,
  OPTIONAL_BUNDLED_PACKAGES,
} from './bundled-plugin-source.js'
import { copyPackageTreeSync } from './copy-tree.js'
import { PackageError } from './errors.js'
import { hashFileReads, mapFileChecks, walkFileChecks } from './file-read-pool.js'
import { extractPluginArchive } from './plugin-archives.js'
import { checkCancelled } from './ports.js'
import { fetchNpmProvenance } from './provenance.js'
import { claimFetch, readyStage } from './staging.js'

export type PackageSource = {
  type: 'npm' | 'git' | 'file' | 'workspace' | 'market' | 'local' | 'path' | 'url'
  ref: string
}
export type ExecFn = (
  command: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{ stdout: string }>
export type FetchedSource = {
  provenance?: PackageProvenance
  sourceKind?: PackageProvenance['sourceKind']
  resolvedLocation?: string
  dir: string
  source?: PackageSource
  version: string
  integrity: string
  license?: string
  releasedAt?: string
  dependencies: Record<string, string>
}

const MAX_REF = 1024
const MAX_JSON = 1024 * 1024
const SEMVER =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:(?:0|[1-9]\\d*)|(?:\\d*[A-Za-z-][0-9A-Za-z-]*))(?:\\.(?:(?:0|[1-9]\\d*)|(?:\\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?'
const NPM_NAME = '(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*'
const NPM_SOURCE = new RegExp(`^npm:(${NPM_NAME})@(${SEMVER})$`)
const EXACT_VERSION = new RegExp(`^${SEMVER}$`)
const PACKAGE_ID =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/
const PROFILE = /^[a-z][a-z0-9.-]{0,63}$/
const DEFAULT_EXCLUDES = ['node_modules', '.git', 'fixtures/out'] as const

const sourceError = (message: string, reason: string, extraDetail?: Record<string, unknown>): PackageError =>
  new PackageError('E_DEP_MISSING', message, { detail: { reason, ...extraDetail } })

function safeRelative(value: string, prefix: './' | 'extensions/'): boolean {
  if (!value.startsWith(prefix) || value.length === prefix.length || isAbsolute(value)) return false
  if (value.includes('\\') || value.includes('\0') || value.includes(':')) return false
  const rest = prefix === './' ? value.slice(2) : value
  return rest.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function parseSource(spec: string): PackageSource {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > MAX_REF)
    throw sourceError('invalid package source', 'invalid-ref')
  if (spec.startsWith('local:')) {
    if (!/^local:(home|workspace)\/[a-z0-9][a-z0-9._-]*$/.test(spec))
      throw sourceError('invalid local plugin source', 'invalid-local-ref')
    return { type: 'local', ref: spec }
  }
  if (spec.startsWith('npm:')) {
    const match = NPM_SOURCE.exec(spec)
    if (!match?.[2] || match[2].length > 64)
      throw sourceError('npm source needs an exact version', 'exact-version')
    return { type: 'npm', ref: spec }
  }
  if (spec.startsWith('git:') || spec.startsWith('url:')) {
    const type = spec.startsWith('git:') ? 'git' : 'url'
    let url: URL
    try {
      url = new URL(spec.slice(4))
    } catch {
      throw sourceError('Use a credential-free HTTPS URL', 'invalid-url')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      (type === 'url' && url.hash) ||
      (url.hash && !/^#[A-Za-z0-9._/-]+$/.test(url.hash))
    )
      throw sourceError('Use a credential-free HTTPS URL and optional git ref', 'invalid-url')
    return { type, ref: spec }
  }
  if (spec.startsWith('file:') || spec.startsWith('path:')) {
    const raw = spec.slice(5)
    if (!raw || raw.includes('\0') || raw.includes('\\'))
      throw sourceError('Use a folder or archive path', 'invalid-file-ref')
    return { type: spec.startsWith('file:') ? 'file' : 'path', ref: spec }
  }
  if (spec.startsWith('workspace:')) {
    if (!safeRelative(spec.slice(10), 'extensions/'))
      throw sourceError('workspace source must stay below extensions/', 'invalid-workspace-ref')
    return { type: 'workspace', ref: spec }
  }
  if (spec.startsWith('market:'))
    throw new PackageError('E_DEP_MISSING', 'market sources are v0.x', {
      detail: { reason: 'market v0.x' },
    })
  throw sourceError('unknown package source', 'unknown-source')
}

function normalizedExcludes(values: readonly string[]): string[] {
  return values.map((value) => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (
      normalized.length === 0 ||
      normalized.includes('\0') ||
      normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error('invalid hash exclusion')
    return normalized
  })
}

function excluded(rel: string, rules: readonly string[]): boolean {
  const parts = rel.split('/')
  return rules.some((rule) => {
    if (!rule.includes('/') && parts.includes(rule)) return true
    return rel === rule || rel.startsWith(`${rule}/`)
  })
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function hashDirectory(dir: string, opts: { exclude?: string[]; signal?: AbortSignal } = {}): string {
  checkCancelled(opts.signal)
  let root: string
  try {
    if (lstatSync(dir).isSymbolicLink()) throw sourceError('package directory is a symbolic link', 'symlink')
    root = nativeRealpathSync(dir)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory is unavailable', 'directory-unavailable')
  }
  try {
    if (!statSync(root).isDirectory()) throw sourceError('package source is not a directory', 'not-directory')
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory changed while hashing', 'tree-changed')
  }
  const rules = normalizedExcludes(opts.exclude ?? [...DEFAULT_EXCLUDES])
  const files: Array<{ rel: string; file: string }> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      checkCancelled(opts.signal)
      const file = join(current, entry.name)
      const rel = relative(root, file).split(sep).join('/')
      if (excluded(rel, rules)) continue
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw sourceError('package tree contains a symbolic link', 'symlink')
      if (stat.isDirectory()) {
        walk(file)
        continue
      }
      if (!stat.isFile()) throw sourceError('package tree contains a special entry', 'special-entry')
      let actual: string
      try {
        actual = nativeRealpathSync(file)
      } catch {
        throw sourceError('package file changed while hashing', 'tree-changed')
      }
      if (!contained(root, actual)) throw sourceError('package file escapes its source tree', 'path-escape')
      files.push({ rel, file })
    }
  }
  walk(root)
  const outer = createHash('sha256')
  for (const { rel, file } of files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    checkCancelled(opts.signal)
    const inner = createHash('sha256').update(rel).update('\0').update(readFileSync(file)).digest()
    outer.update(inner)
  }
  return `sha256-${outer.digest('hex')}`
}

/** Same wire digest and exclusions as hashDirectory; yields for filesystem IO and streams file bytes. */
export async function hashDirectoryAsync(
  dir: string,
  opts: { exclude?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
  checkCancelled(opts.signal)
  let root: string
  try {
    if ((await asyncFs.lstat(dir)).isSymbolicLink())
      throw sourceError('package directory is a symbolic link', 'symlink')
    root = await asyncFs.realpath(dir)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError('package directory is unavailable', 'directory-unavailable')
  }
  const rootStat = await asyncFs.stat(root)
  if (!rootStat.isDirectory()) throw sourceError('package source is not a directory', 'not-directory')
  const rules = normalizedExcludes(opts.exclude ?? [...DEFAULT_EXCLUDES])
  const files: { rel: string; file: string; observed: Stats }[] = []
  // Reuse the bounded metadata pool for sibling directories too. Nested entry checks stay
  // bounded (four directories, four checks each); file handles/scratch memory are unchanged.
  await walkFileChecks([root], async (current) => {
    const next: string[] = []
    checkCancelled(opts.signal)
    const entries = await asyncFs.readdir(current, { withFileTypes: true })
    const observed = await mapFileChecks(entries, async (entry) => {
      checkCancelled(opts.signal)
      const file = join(current, entry.name)
      const rel = relative(root, file).split(sep).join('/')
      if (excluded(rel, rules)) return undefined
      return { file, rel, stat: await asyncFs.lstat(file) }
    })
    for (const item of observed) {
      if (!item) continue
      const { file, rel, stat } = item
      if (stat.isSymbolicLink()) throw sourceError('package tree contains a symbolic link', 'symlink')
      if (stat.isDirectory()) next.push(file)
      else if (stat.isFile()) files.push({ rel, file, observed: stat })
      else throw sourceError('package tree contains a special entry', 'special-entry')
    }
    return next
  })
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hashFile = async ({ rel, file, observed }: (typeof files)[number], chunk: Uint8Array) => {
    checkCancelled(opts.signal)
    if (!contained(root, await asyncFs.realpath(file)))
      throw sourceError('package file escapes its source tree', 'path-escape')
    const handle = await asyncFs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const before = await handle.stat()
      if (!before.isFile() || !sameFileObservation(before, observed))
        throw sourceError('package file changed while hashing', 'tree-changed')
      const inner = createHash('sha256').update(rel).update('\0')
      for (;;) {
        checkCancelled(opts.signal)
        const { bytesRead } = await handle.read(chunk)
        if (!bytesRead) break
        inner.update(chunk.subarray(0, bytesRead))
      }
      const after = await handle.stat()
      const linked = await asyncFs.lstat(file)
      if (
        linked.isSymbolicLink() ||
        linked.ino !== before.ino ||
        linked.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw sourceError('package file changed while hashing', 'tree-changed')
      return inner.digest()
    } finally {
      await handle.close()
    }
  }
  const digests = await hashFileReads(files, hashFile)
  // A previously closed file can change while a later file yields. Recheck the entire observation,
  // including ctime: same-size writes with a restored mtime must still refuse this traversal.
  await mapFileChecks(files, async ({ file, observed }) => {
    checkCancelled(opts.signal)
    const current = await asyncFs.lstat(file)
    if (
      !current.isFile() ||
      !sameFileObservation(current, observed) ||
      !contained(root, await asyncFs.realpath(file))
    )
      throw sourceError('package file changed while hashing', 'tree-changed')
  })
  const finalRoot = await asyncFs.lstat(dir)
  if (
    finalRoot.isSymbolicLink() ||
    finalRoot.ino !== rootStat.ino ||
    finalRoot.dev !== rootStat.dev ||
    (await asyncFs.realpath(dir)) !== root
  )
    throw sourceError('package directory changed while hashing', 'tree-changed')
  checkCancelled(opts.signal)
  const outer = createHash('sha256')
  for (const digest of digests) outer.update(digest)
  return `sha256-${outer.digest('hex')}`
}

function sameFileObservation(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  )
}

type PackageJson = {
  name: string
  version: string
  license?: string
  dependencies: Record<string, string>
}

export function readPackageJson(dir: string): PackageJson {
  const file = join(dir, 'package.json')
  let text: string
  try {
    if (statSync(file).size > MAX_JSON) throw new Error('too large')
    text = readFileSync(file, 'utf8')
  } catch {
    throw sourceError('package source has no readable package.json', 'package-json')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw sourceError('package source has invalid package.json', 'package-json')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw sourceError('package source has invalid package.json', 'package-json')
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !PACKAGE_ID.test(record.name))
    throw sourceError('package source has invalid name', 'package-name')
  if (typeof record.version !== 'string' || record.version.length > 64 || !EXACT_VERSION.test(record.version))
    throw sourceError('package source has invalid version', 'package-version')
  if (record.license !== undefined && (typeof record.license !== 'string' || record.license.length > 64))
    throw sourceError('package source has invalid license', 'package-license')
  const dependencies: Record<string, string> = {}
  if (record.dependencies !== undefined) {
    if (
      record.dependencies === null ||
      typeof record.dependencies !== 'object' ||
      Array.isArray(record.dependencies)
    )
      throw sourceError('package source has invalid dependencies', 'package-dependencies')
    for (const [name, version] of Object.entries(record.dependencies)) {
      if (!PACKAGE_ID.test(name) || typeof version !== 'string' || version.length > MAX_REF)
        throw sourceError('package source has invalid dependencies', 'package-dependencies')
      dependencies[name] = version
    }
  }
  return {
    name: record.name,
    version: record.version,
    ...(typeof record.license === 'string' ? { license: record.license } : {}),
    dependencies,
  }
}

const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
  // Git/curl consume lower-case proxy names; preserve explicit lower-case precedence.
  env.http_proxy ??= env.HTTP_PROXY
  env.https_proxy ??= env.HTTPS_PROXY ?? env.http_proxy
  env.no_proxy ??= env.NO_PROXY
  return env
}

export const defaultExec: ExecFn = (command, args, opts) =>
  runIsolatedCommand(command, args, {
    ...opts,
    env: childEnvironment(),
    timeoutMs: 120_000,
    maxOutputBytes: MAX_JSON,
    windowsBatch: command === 'npm' ? 'argv-proxy' : 'script',
  })

function assertArchivePaths(listing: string): void {
  const names = listing.split('\n').filter(Boolean)
  if (names.length === 0) throw sourceError('npm archive is empty', 'archive-empty')
  for (const name of names) {
    const parts = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/')
    if (
      name.includes('\\') ||
      name.includes('\0') ||
      isAbsolute(name) ||
      !name.startsWith('package/') ||
      parts.some((part) => part === '' || part === '.' || part === '..')
    )
      throw sourceError('npm archive contains an unsafe path', 'archive-path')
  }
}

function assertArchiveEntryTypes(listing: string): void {
  for (const line of listing.split('\n').filter(Boolean)) {
    // GNU tar and bsdtar both expose the entry type in the first mode character. Refusing
    // links and special entries prevents one archive entry redirecting a later extraction.
    if (line[0] !== '-' && line[0] !== 'd')
      throw sourceError('npm archive contains a link or special entry', 'archive-entry')
  }
}

async function defaultExtract(tarball: string, into: string, signal?: AbortSignal): Promise<void> {
  const listed = await defaultExec('tar', ['-tzf', tarball], {
    cwd: dirname(tarball),
    ...(signal ? { signal } : {}),
  })
  assertArchivePaths(listed.stdout)
  const verbose = await defaultExec('tar', ['-tvzf', tarball], {
    cwd: dirname(tarball),
    ...(signal ? { signal } : {}),
  })
  assertArchiveEntryTypes(verbose.stdout)
  mkdirSync(into, { recursive: true })
  await defaultExec(
    'tar',
    ['-xzf', tarball, '-C', into, '--strip-components=1', '--no-same-owner', '--no-same-permissions'],
    { cwd: dirname(tarball), ...(signal ? { signal } : {}) },
  )
}

function parseJson(text: string, reason: string): unknown {
  if (Buffer.byteLength(text) > MAX_JSON) throw sourceError('package command output is too large', reason)
  try {
    return JSON.parse(text)
  } catch {
    throw sourceError('package command returned invalid JSON', reason)
  }
}

function validTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    )
  if (!match?.[1] || !match[2] || !match[3] || Number(match[1]) === 0) return false
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate()
}

function npmCoordinates(ref: string): { name: string; version: string; spec: string } {
  const match = NPM_SOURCE.exec(ref)
  if (!match?.[1] || !match[2]) throw sourceError('npm source needs an exact version', 'exact-version')
  return { name: match[1], version: match[2], spec: ref.slice(4) }
}

function metadata(fetchedDir: string, expected?: { name?: string; version?: string }): PackageJson {
  // hashDirectory is also the post-extraction tree validator: it refuses symlinks, devices and
  // paths whose real target left the package.
  hashDirectory(fetchedDir)
  const pkg = readPackageJson(fetchedDir)
  if (expected?.name !== undefined && pkg.name !== expected.name)
    throw sourceError('fetched package identity does not match its source', 'package-name-mismatch')
  if (expected?.version !== undefined && pkg.version !== expected.version)
    throw sourceError('fetched package version does not match its source', 'package-version-mismatch')
  return pkg
}

function localSource(src: PackageSource, cwd: string): string {
  const example = bundledExampleSource(src.ref) ?? bundledPluginSource(src.ref)
  cwd = example?.root ?? cwd
  const raw = example?.path ?? src.ref.slice(src.ref.indexOf(':') + 1)
  // Resolved separately so a missing/escaping source can still name the root it was
  // checked against, which is rarely the process's own cwd (the daemon that fetches
  // this may have started in a different directory than whoever is calling it).
  let cwdRoot: string
  try {
    cwdRoot = nativeRealpathSync(cwd)
  } catch {
    throw sourceError('package workspace root is unavailable', 'workspace-unavailable')
  }
  let from: string
  try {
    const candidate = resolve(cwdRoot, raw)
    if (lstatSync(candidate).isSymbolicLink())
      throw sourceError('local package source is a symbolic link', 'symlink', { workspaceRoot: cwdRoot })
    from = nativeRealpathSync(candidate)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError(
      `local package source is unavailable relative to the package workspace root (${cwdRoot}); ` +
        `file: and workspace: sources resolve against that root, not the CLI's own current directory`,
      'source-unavailable',
      { workspaceRoot: cwdRoot },
    )
  }
  if (src.type === 'workspace' && !contained(cwdRoot, from))
    throw sourceError('local package source is outside cwd', 'source-escape', { workspaceRoot: cwdRoot })
  requireGeneratedEntry(src.ref, from)
  return from
}

/** A bundled package whose entry is generated says how to build it when a checkout has not yet. */
export function requireGeneratedEntry(ref: string, directory: string): void {
  const build = OPTIONAL_BUNDLED_PACKAGES.find((item) => item.ref === ref)?.build
  if (!build) return
  let entry: unknown
  try {
    entry = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).exports
  } catch {
    return
  }
  if (typeof entry !== 'string') return
  try {
    statSync(resolve(directory, entry))
    return
  } catch {
    // Missing: fall through to the hint.
  }
  throw sourceError(
    `the bundled package at ${ref} has no generated ${entry}; in a development checkout build it with \`${build}\``,
    'bundled-entry-missing',
  )
}

async function copyLocal(from: string, into: string, signal?: AbortSignal): Promise<string> {
  // Validate before copying and again afterwards. The second pass is what catches a source swapped
  // to a link during the copy rather than trusting a preflight snapshot.
  const before = await hashDirectoryAsync(from, { ...(signal ? { signal } : {}) })
  copyPackageTreeSync(from, into, (path) => {
    checkCancelled(signal)
    const rel = relative(from, path).split(sep).join('/')
    return rel === '' || !excluded(rel, DEFAULT_EXCLUDES)
  })
  const sourceAfter = await hashDirectoryAsync(from, { ...(signal ? { signal } : {}) })
  const copied = await hashDirectoryAsync(into, { ...(signal ? { signal } : {}) })
  if (before !== sourceAfter || copied !== sourceAfter)
    throw sourceError('local package source changed while copying', 'source-changed')
  return copied
}

function ensureEmptyDestination(into: string): void {
  try {
    lstatSync(into)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw sourceError('package destination cannot be inspected', 'destination-unavailable')
  }
  // A dangling symlink is occupied too; existsSync would incorrectly call it empty.
  throw sourceError('package destination exists', 'destination-exists')
}

export async function fetchSource(
  src: PackageSource,
  into: string,
  opts: {
    cwd: string
    exec?: ExecFn
    npmProvenance?: typeof fetchNpmProvenance
    extract?: (tarball: string, into: string, signal?: AbortSignal) => Promise<void>
    signal?: AbortSignal
  },
): Promise<FetchedSource> {
  checkCancelled(opts.signal)
  // Never trust a hand-built PackageSource that bypassed parseSource.
  const checked = parseSource(src.ref)
  if (checked.type !== src.type) throw sourceError('package source type differs from its ref', 'source-type')
  if (src.type === 'local')
    throw sourceError('Local plugins are discovered from configured roots', 'local-discovery-only')
  const target = resolve(into)
  ensureEmptyDestination(target)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  // The destination leaf does not exist yet; canonicalize its existing parent so an 8.3/subst
  // spelling cannot hide a destination inside the native-resolved source tree.
  const canonicalTarget = join(nativeRealpathSync(parent), basename(target))
  const work = mkdtempSync(join(parent, '.agnes-fetch-'))
  const payload = join(work, 'payload')
  const run = opts.exec ?? defaultExec
  const exec: ExecFn = async (command, args, options) => {
    checkCancelled(opts.signal)
    try {
      const result = await run(command, args, { ...options, ...(opts.signal ? { signal: opts.signal } : {}) })
      checkCancelled(opts.signal)
      return result
    } catch (error) {
      checkCancelled(opts.signal)
      throw error
    }
  }
  const extract = opts.extract ?? defaultExtract
  try {
    claimFetch(work)
    let pkg: PackageJson
    let integrity: string
    let releasedAt: string | undefined
    let resolvedSource: PackageSource | undefined
    let resolvedLocation: string | undefined
    let sourceKind: PackageProvenance['sourceKind']
    switch (checked.type) {
      case 'file':
      case 'path':
      case 'workspace': {
        const from = localSource(checked, opts.cwd)
        resolvedLocation = from
        sourceKind = lstatSync(from).isFile() ? 'tarball' : 'local-folder'
        if (contained(from, canonicalTarget))
          throw sourceError('package destination is inside its source', 'destination-inside-source')
        if (statSync(from).isFile()) {
          await extractPluginArchive(from, payload, exec, opts.signal)
          integrity = hashDirectory(payload)
        } else integrity = await copyLocal(from, payload, opts.signal)
        pkg = metadata(payload)
        break
      }
      case 'npm': {
        const expected = npmCoordinates(checked.ref)
        const packDir = join(work, 'pack')
        mkdirSync(packDir)
        const packedValue = parseJson(
          (
            await exec(
              'npm',
              ['pack', expected.spec, '--pack-destination', packDir, '--ignore-scripts', '--json'],
              { cwd: opts.cwd },
            )
          ).stdout,
          'npm-pack-json',
        )
        if (!Array.isArray(packedValue) || packedValue.length !== 1)
          throw sourceError('npm pack returned an unexpected result', 'npm-pack-result')
        const packed = packedValue[0]
        if (packed === null || typeof packed !== 'object' || Array.isArray(packed))
          throw sourceError('npm pack returned an unexpected result', 'npm-pack-result')
        const row = packed as Record<string, unknown>
        if (
          typeof row.filename !== 'string' ||
          row.filename.length === 0 ||
          row.filename.includes('/') ||
          row.filename.includes('\\') ||
          row.filename.includes('\0') ||
          row.filename === '.' ||
          row.filename === '..' ||
          row.filename.startsWith('-') ||
          basename(row.filename) !== row.filename ||
          typeof row.integrity !== 'string' ||
          !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(row.integrity) ||
          row.version !== expected.version
        )
          throw sourceError('npm pack returned unsafe metadata', 'npm-pack-result')
        const tarball = join(packDir, row.filename)
        let bytes: Buffer
        try {
          const archiveStat = lstatSync(tarball)
          const archiveRealpath = nativeRealpathSync(tarball)
          if (!archiveStat.isFile() || !contained(nativeRealpathSync(packDir), archiveRealpath))
            throw new Error('unsafe archive')
          bytes = readFileSync(tarball)
        } catch {
          throw sourceError('npm pack did not produce its declared archive', 'npm-pack-archive')
        }
        const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        if (actual !== row.integrity)
          throw new PackageError('E_LOCK_MISMATCH', 'npm archive integrity does not match pack metadata', {
            detail: { reason: 'integrity' },
          })
        await extract(tarball, payload, opts.signal)
        checkCancelled(opts.signal)
        pkg = metadata(payload, { name: expected.name, version: expected.version })
        integrity = actual
        const timesValue = parseJson(
          (await exec('npm', ['view', expected.spec, 'time', '--json'], { cwd: opts.cwd })).stdout,
          'npm-time-json',
        )
        if (timesValue === null || typeof timesValue !== 'object' || Array.isArray(timesValue))
          throw sourceError('npm view returned invalid release metadata', 'npm-time-result')
        const time = (timesValue as Record<string, unknown>)[expected.version]
        if (typeof time !== 'string' || !validTimestamp(time))
          throw sourceError('npm view omitted the pinned release time', 'npm-time-result')
        releasedAt = time
        break
      }
      case 'git': {
        const raw = checked.ref.slice(4)
        const split = raw.lastIndexOf('#')
        const url = split < 0 ? raw : raw.slice(0, split)
        const requested = split < 0 ? 'HEAD' : raw.slice(split + 1)
        let commit = requested
        mkdirSync(payload)
        const prefix = [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'protocol.file.allow=never',
        ]
        const git = (args: string[]): Promise<{ stdout: string }> =>
          exec('git', [...prefix, ...args], { cwd: opts.cwd })
        if (!/^[a-f0-9]{40}$/.test(commit)) {
          const refs = (
            await git([
              'ls-remote',
              '--',
              url,
              requested === 'HEAD' ? 'HEAD' : 'refs/heads/' + requested,
              'refs/tags/' + requested,
              'refs/tags/' + requested + '^{}',
            ])
          ).stdout
          const rows = refs
            .trim()
            .split('\n')
            .map((line) => line.split(/\s+/))
            .filter((row) => /^[a-f0-9]{40}$/.test(row[0] ?? ''))
          const selected = rows.find((row) => row[1]?.endsWith('^{}')) ?? rows[0]
          if (!selected?.[0] || (rows.length > 1 && !rows.some((row) => row[1]?.endsWith('^{}'))))
            throw sourceError('Git ref is unavailable or ambiguous; supply a commit', 'git-ref')
          commit = selected[0]
        }
        resolvedSource = { type: 'git', ref: 'git:' + url + '#' + commit }
        await git(['init', '--quiet', payload])
        await git(['-C', payload, 'remote', 'add', 'origin', url])
        await git(['-C', payload, 'fetch', '--quiet', '--depth', '1', 'origin', commit])
        await git(['-C', payload, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
        const head = (await git(['-C', payload, 'rev-parse', 'HEAD'])).stdout.trim()
        if (head !== commit)
          throw new PackageError('E_LOCK_MISMATCH', 'git checkout differs from the pinned commit', {
            detail: { reason: 'commit' },
          })
        rmSync(join(payload, '.git'), { recursive: true, force: true })
        pkg = metadata(payload)
        integrity = hashDirectory(payload)
        break
      }
      case 'url': {
        const response = await deploymentFetch(checked.ref.slice(4), {
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(120000), ...(opts.signal ? [opts.signal] : [])]),
        })
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 256 * 1024 * 1024)
          throw sourceError('Archive download failed or is too large', 'archive-download')
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body ?? []) {
          size += chunk.length
          if (size > 256 * 1024 * 1024) throw sourceError('Archive is too large', 'archive-size')
          chunks.push(chunk)
        }
        const archive = join(work, 'download')
        writeFileSync(archive, Buffer.concat(chunks))
        await extractPluginArchive(archive, payload, exec, opts.signal)
        pkg = metadata(payload)
        integrity = hashDirectory(payload)
        break
      }
      case 'local':
        throw sourceError('Local plugins are discovery-only', 'local-discovery-only')
      case 'market':
        throw new PackageError('E_DEP_MISSING', 'market sources are v0.x', {
          detail: { reason: 'market v0.x' },
        })
    }
    checkCancelled(opts.signal)
    ensureEmptyDestination(target)
    const provenance =
      checked.type === 'npm'
        ? await (opts.npmProvenance ?? fetchNpmProvenance)(
            pkg.name,
            pkg.version,
            integrity,
            opts.signal,
            join(work, 'sigstore-cache'),
          )
        : undefined
    // Local copies now yield too. A destination created while hashing is still occupied.
    ensureEmptyDestination(target)
    readyStage(target)
    renameSync(payload, target)
    return {
      ...(provenance
        ? {
            provenance: {
              source: (resolvedSource ?? checked) as PackageProvenance['source'],
              integrity,
              ...provenance,
            },
          }
        : {}),
      ...(sourceKind ? { sourceKind } : {}),
      ...(resolvedLocation ? { resolvedLocation } : {}),
      dir: target,
      ...(resolvedSource ? { source: resolvedSource } : {}),
      version: pkg.version,
      integrity,
      ...(pkg.license === undefined ? {} : { license: pkg.license }),
      ...(releasedAt === undefined ? {} : { releasedAt }),
      dependencies: pkg.dependencies,
    }
  } catch (error) {
    checkCancelled(opts.signal)
    throw error
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** `<dataDir>/profiles/<profile>/packages/<id>`, with a package scope separator flattened. */
export function packageDir(dataDir: string, profile: string, id: string): string {
  if (!PROFILE.test(profile)) throw new Error(`invalid profile name: ${profile}`)
  if (id.split('/').some((part) => part === '.' || part === '..'))
    throw new Error(`package id escapes packages dir: ${id}`)
  if (!PACKAGE_ID.test(id)) throw new Error(`invalid package id: ${id}`)
  const root = join(dataDir, 'profiles', profile, 'packages')
  const target = join(root, id.replaceAll('/', '__'))
  if (!contained(resolve(root), resolve(target))) throw new Error(`package id escapes packages dir: ${id}`)
  return target
}
