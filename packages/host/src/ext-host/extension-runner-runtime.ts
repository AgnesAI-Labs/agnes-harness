import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { HostError } from '../errors.js'

const ENTRY = 'hooks-runner.mjs'
const MANIFEST = 'hooks-runner.manifest.json'

type Manifest = {
  schemaVersion: 1
  protocolVersion: 1
  entry: typeof ENTRY
  sha256: string
  node: { minimum: string; major: number }
}

export type NodeRuntimeCandidate = {
  executable: string
  /** Complete immutable runtime roots needed by the executable; never inferred from PATH. */
  readRoots: readonly string[]
}

export type ExtensionRunnerRuntime = {
  source: 'bundled' | 'configured' | 'host'
  executable: string
  runner: string
  readPaths: readonly string[]
  runnerSha256: string
}

type ProbeResult = { node: string; electron?: string }
type Options = {
  artifactDirectory: string
  bundledNode?: NodeRuntimeCandidate
  configuredNode?: NodeRuntimeCandidate
  hostNode?: NodeRuntimeCandidate | false
  probe?: (executable: string) => ProbeResult
}

type RuntimePackageManifest = {
  schemaVersion: 1
  target: string
  node: { version: string; executable: string; sha256: string; upstreamArchiveSha256: string }
  runner: { directory: string; entry: string; sha256: string }
}

function invalid(message: string): HostError {
  return new HostError('E_EXT_LOAD', `E_EXT_ISOLATION_RUNTIME: ${message}`)
}

function canonical(path: string, kind: 'file' | 'root'): string {
  if (!isAbsolute(path)) throw invalid(`${kind} path must be absolute`)
  let result: string
  try {
    result = realpathSync(path)
    const stat = statSync(result)
    if (kind === 'file' && !stat.isFile()) throw invalid('runtime executable is not a file')
    if (kind === 'root' && !stat.isDirectory() && !stat.isFile()) throw invalid('invalid runtime read root')
    if (kind === 'file') accessSync(result, constants.X_OK)
  } catch (error) {
    if (error instanceof HostError) throw error
    throw invalid(`${kind} path is unavailable`)
  }
  return result
}

function artifact(directory: string): { runner: string; manifest: Manifest } {
  const root = canonical(resolve(directory), 'root')
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))
  } catch {
    throw invalid('runner manifest is unavailable')
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest as Manifest).schemaVersion !== 1 ||
    (manifest as Manifest).protocolVersion !== 1 ||
    (manifest as Manifest).entry !== ENTRY ||
    !/^[a-f0-9]{64}$/.test((manifest as Manifest).sha256) ||
    (manifest as Manifest).node?.major !== 24 ||
    (manifest as Manifest).node?.minimum !== '24.10.0'
  )
    throw invalid('runner manifest is invalid')
  const runner = realpathSync(join(root, ENTRY))
  if (dirname(runner) !== root || relative(root, runner).startsWith('..') || !statSync(runner).isFile())
    throw invalid('runner entry escapes its artifact directory')
  const actual = createHash('sha256').update(readFileSync(runner)).digest('hex')
  if (actual !== (manifest as Manifest).sha256) throw invalid('runner digest mismatch')
  return { runner, manifest: manifest as Manifest }
}

/** Read the release package contract and turn it into the resolver's trusted bundled candidate. */
export function loadBundledExtensionRuntime(
  runtimeDirectory: string,
  target: string,
): Pick<Options, 'artifactDirectory' | 'bundledNode'> {
  if (!/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(target)) throw invalid('invalid runtime target')
  const root = canonical(resolve(runtimeDirectory), 'root')
  let manifest: RuntimePackageManifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'runtime.manifest.json'), 'utf8'))
  } catch {
    throw invalid('runtime package manifest is unavailable')
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== target ||
    manifest.node?.version !== '24.10.0' ||
    manifest.node?.executable !== `node/${target}/${target.startsWith('win32-') ? 'node.exe' : 'bin/node'}` ||
    !/^[a-f0-9]{64}$/.test(manifest.node?.sha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.node?.upstreamArchiveSha256) ||
    manifest.runner?.directory !== 'isolation' ||
    manifest.runner?.entry !== ENTRY ||
    !/^[a-f0-9]{64}$/.test(manifest.runner?.sha256)
  )
    throw invalid('runtime package manifest is invalid')
  const executable = canonical(join(root, manifest.node.executable), 'file')
  const nodeRoot = canonical(join(root, 'node', target), 'root')
  if (relative(nodeRoot, executable).startsWith('..') || fileHash(executable) !== manifest.node.sha256)
    throw invalid('packaged Node digest or path mismatch')
  const built = artifact(join(root, manifest.runner.directory))
  if (built.manifest.sha256 !== manifest.runner.sha256) throw invalid('packaged runner digest mismatch')
  return {
    artifactDirectory: join(root, manifest.runner.directory),
    bundledNode: { executable, readRoots: [nodeRoot] },
  }
}

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function defaultProbe(executable: string): ProbeResult {
  const token = randomUUID()
  const script = `process.stdout.write(JSON.stringify({token:${JSON.stringify(token)},node:process.versions.node,electron:process.versions.electron}))`
  const environment = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
  const result = spawnSync(executable, ['--input-type=module', '-e', script], {
    windowsHide: true,
    encoding: 'utf8',
    env: environment,
    timeout: 5_000,
    maxBuffer: 4_096,
  })
  if (result.status !== 0 || result.signal || result.stderr || result.error)
    throw invalid('Node probe failed')
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw invalid('Node probe returned invalid output')
  }
  if (!value || typeof value !== 'object' || (value as { token?: unknown }).token !== token)
    throw invalid('Node probe token mismatch')
  return value as ProbeResult
}

function accepts(result: ProbeResult, required: Manifest['node']): boolean {
  if (result.electron || typeof result.node !== 'string') return false
  const parts = result.node.split('.').map(Number)
  return (
    parts.length === 3 &&
    parts.every(Number.isInteger) &&
    parts[0] === required.major &&
    ((parts[1] ?? -1) > 10 || ((parts[1] ?? -1) === 10 && (parts[2] ?? -1) >= 0))
  )
}

/** Resolve a verified runtime without PATH lookup; Electron and other non-Node.js hosts are deliberately rejected. */
export function resolveExtensionRunnerRuntime(options: Options): ExtensionRunnerRuntime {
  const built = artifact(options.artifactDirectory)
  const host =
    options.hostNode === undefined
      ? { executable: process.execPath, readRoots: [dirname(dirname(process.execPath))] }
      : options.hostNode
  const candidates = [
    ['bundled', options.bundledNode],
    ['configured', options.configuredNode],
    ['host', host],
  ] as const
  const probe = options.probe ?? defaultProbe
  const failures: string[] = []
  for (const [source, candidate] of candidates) {
    if (!candidate) continue
    try {
      const executable = canonical(candidate.executable, 'file')
      const readRoots = candidate.readRoots.map((path) => canonical(path, 'root'))
      if (!readRoots.length || !accepts(probe(executable), built.manifest.node))
        throw invalid('unsupported or Electron-based Node runtime')
      return Object.freeze({
        source,
        executable,
        runner: built.runner,
        readPaths: Object.freeze([...new Set([...readRoots, built.runner])]),
        runnerSha256: built.manifest.sha256,
      })
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : 'probe failed'}`)
    }
  }
  throw invalid(`no supported Node 24 runtime (${failures.join('; ')})`)
}
