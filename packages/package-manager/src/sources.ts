import { createHash } from 'node:crypto'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runIsolatedCommand } from '@agnes/package-isolation'
import { bundledPluginSourceRoot } from './bundled-plugin-source.js'
import { PackageError } from './errors.js'
import { checkCancelled } from './ports.js'
import { claimFetch, readyStage } from './staging.js'

export type PackageSource = {
  type: 'npm' | 'git' | 'file' | 'workspace' | 'market'
  ref: string
}
export type ExecFn = (
  command: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{ stdout: string }>
export type FetchedSource = {
  dir: string
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
  if (spec.startsWith('npm:')) {
    const match = NPM_SOURCE.exec(spec)
    if (!match?.[2] || match[2].length > 64)
      throw sourceError('npm source needs an exact version', 'exact-version')
    return { type: 'npm', ref: spec }
  }
  if (spec.startsWith('git:')) {
    const raw = spec.slice(4)
    const hashAt = raw.lastIndexOf('#')
    const commit = raw.slice(hashAt + 1)
    let url: URL
    try {
      url = new URL(raw.slice(0, hashAt))
    } catch {
      throw sourceError('git source needs a credential-free HTTPS URL and full commit', 'invalid-git-ref')
    }
    if (
      hashAt <= 0 ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      throw sourceError('git source needs a credential-free HTTPS URL and full commit', 'invalid-git-ref')
    return { type: 'git', ref: spec }
  }
  if (spec.startsWith('file:')) {
    if (!safeRelative(spec.slice(5), './'))
      throw sourceError('file source must be a contained ./ relative path', 'invalid-file-ref')
    return { type: 'file', ref: spec }
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
    root = realpathSync(dir)
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
        actual = realpathSync(file)
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

type PackageJson = {
  name: string
  version: string
  license?: string
  dependencies: Record<string, string>
}

function readPackageJson(dir: string): PackageJson {
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

const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'] as const
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
  return env
}

const defaultExec: ExecFn = (command, args, opts) =>
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
  cwd = bundledPluginSourceRoot(src.ref) ?? cwd
  const raw = src.ref.slice(src.ref.indexOf(':') + 1)
  // Resolved separately so a missing/escaping source can still name the root it was
  // checked against, which is rarely the process's own cwd (the daemon that fetches
  // this may have started in a different directory than whoever is calling it).
  let cwdRoot: string
  try {
    cwdRoot = realpathSync(cwd)
  } catch {
    throw sourceError('package workspace root is unavailable', 'workspace-unavailable')
  }
  let from: string
  try {
    const candidate = resolve(cwdRoot, raw)
    if (lstatSync(candidate).isSymbolicLink())
      throw sourceError('local package source is a symbolic link', 'symlink', { workspaceRoot: cwdRoot })
    from = realpathSync(candidate)
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw sourceError(
      `local package source is unavailable relative to the package workspace root (${cwdRoot}); ` +
        `file: and workspace: sources resolve against that root, not the CLI's own current directory`,
      'source-unavailable',
      { workspaceRoot: cwdRoot },
    )
  }
  if (!contained(cwdRoot, from))
    throw sourceError('local package source is outside cwd', 'source-escape', { workspaceRoot: cwdRoot })
  return from
}

function copyLocal(from: string, into: string, signal?: AbortSignal): string {
  // Validate before copying and again afterwards. The second pass is what catches a source swapped
  // to a link during the copy rather than trusting a preflight snapshot.
  const before = hashDirectory(from, { ...(signal ? { signal } : {}) })
  cpSync(from, into, {
    recursive: true,
    filter: (path) => {
      checkCancelled(signal)
      const rel = relative(from, path).split(sep).join('/')
      return rel === '' || !excluded(rel, DEFAULT_EXCLUDES)
    },
  })
  const sourceAfter = hashDirectory(from, { ...(signal ? { signal } : {}) })
  const copied = hashDirectory(into, { ...(signal ? { signal } : {}) })
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
    extract?: (tarball: string, into: string, signal?: AbortSignal) => Promise<void>
    signal?: AbortSignal
  },
): Promise<FetchedSource> {
  checkCancelled(opts.signal)
  // Never trust a hand-built PackageSource that bypassed parseSource.
  const checked = parseSource(src.ref)
  if (checked.type !== src.type) throw sourceError('package source type differs from its ref', 'source-type')
  const target = resolve(into)
  ensureEmptyDestination(target)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
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
    switch (checked.type) {
      case 'file':
      case 'workspace': {
        const from = localSource(checked, opts.cwd)
        if (contained(from, target))
          throw sourceError('package destination is inside its source', 'destination-inside-source')
        integrity = copyLocal(from, payload, opts.signal)
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
          const archiveRealpath = realpathSync(tarball)
          if (!archiveStat.isFile() || !contained(realpathSync(packDir), archiveRealpath))
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
        const url = raw.slice(0, split)
        const commit = raw.slice(split + 1)
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
      case 'market':
        throw new PackageError('E_DEP_MISSING', 'market sources are v0.x', {
          detail: { reason: 'market v0.x' },
        })
    }
    checkCancelled(opts.signal)
    ensureEmptyDestination(target)
    readyStage(target)
    renameSync(payload, target)
    return {
      dir: target,
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
