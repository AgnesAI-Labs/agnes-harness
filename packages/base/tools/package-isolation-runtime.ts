import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildHooksIsolationRunner, HOOKS_RUNNER_ENTRY } from './build-isolation-runner.js'
import { beginRuntimeDirectory } from './runtime-directory.js'

const NODE_VERSION = '24.10.0'
const RELEASE = `https://nodejs.org/dist/v${NODE_VERSION}`

export type RuntimeTarget = keyof typeof DISTRIBUTIONS
export type NodeDistribution = { archive: string; sha256: string; directory: string; executable: string }

export const DISTRIBUTIONS = {
  'darwin-arm64': node(
    'darwin-arm64',
    'tar.xz',
    '0ba4910a69a256798729d5a3a42539d0b72670c052b67519b5f79f246121084a',
  ),
  'darwin-x64': node(
    'darwin-x64',
    'tar.xz',
    '4e2ff8e9148659052a6cad50c3b10e6f02af1298dfa9a8ee65e010044f05726f',
  ),
  'linux-arm64': node(
    'linux-arm64',
    'tar.xz',
    '07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8',
  ),
  'linux-x64': node(
    'linux-x64',
    'tar.xz',
    '2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17',
  ),
  'win32-arm64': node('win-arm64', 'zip', 'ff9d2c151dedba7f814d8a71038b0ff2063e838799c916f782c96c52592a2cd7'),
  'win32-x64': node('win-x64', 'zip', 'adc1a2d5ca79c92e94f3a58c3ec0efa76bdb488769ba4d4b50990e4c84896060'),
} as const

function node(platform: string, extension: string, sha256: string): NodeDistribution {
  const directory = `node-v${NODE_VERSION}-${platform}`
  return {
    archive: `${directory}.${extension}`,
    sha256,
    directory,
    executable: platform.startsWith('win-') ? 'node.exe' : 'bin/node',
  }
}

const hash = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex')

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`Node distribution download failed (${response.status})`)
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 })
}

async function obtainArchive(
  distribution: NodeDistribution,
  cacheDirectory: string,
  supplied?: string,
): Promise<string> {
  if (supplied) {
    if ((await hash(supplied)) !== distribution.sha256)
      throw new Error('supplied Node archive digest mismatch')
    return supplied
  }
  await mkdir(cacheDirectory, { recursive: true })
  const archive = join(cacheDirectory, distribution.archive)
  try {
    if ((await hash(archive)) === distribution.sha256) return archive
  } catch {
    // Cache miss: download to a process-owned temporary file before publishing it.
  }
  const temporary = `${archive}.tmp-${process.pid}`
  try {
    await download(`${RELEASE}/${distribution.archive}`, temporary)
    if ((await hash(temporary)) !== distribution.sha256)
      throw new Error('downloaded Node archive digest mismatch')
    await rm(archive, { force: true })
    await rename(temporary, archive)
    return archive
  } finally {
    await rm(temporary, { force: true })
  }
}

export type RuntimePackageManifest = {
  schemaVersion: 1
  target: RuntimeTarget
  node: { version: typeof NODE_VERSION; executable: string; sha256: string; upstreamArchiveSha256: string }
  runner: { directory: 'isolation'; entry: typeof HOOKS_RUNNER_ENTRY; sha256: string }
}

/** Assemble the release-owned Node executable and runner artifact without retaining npm or headers. */
export async function packageIsolationRuntime(options: {
  outputDirectory: string
  target: RuntimeTarget
  distribution?: NodeDistribution
  cacheDirectory?: string
  archivePath?: string
}): Promise<RuntimePackageManifest> {
  const distribution = options.distribution ?? DISTRIBUTIONS[options.target]
  const root = resolve(options.outputDirectory)
  const transaction = await beginRuntimeDirectory(root)
  const temporary = transaction.staging
  let extraction: string | undefined
  const cache =
    options.cacheDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.agnes-tmp/node')
  try {
    extraction = await mkdtemp(join(tmpdir(), 'agnes-node-extract-'))
    const archive = await obtainArchive(
      distribution,
      cache,
      options.archivePath ?? process.env.AGNES_NODE_ARCHIVE,
    )
    const unpacked = spawnSync('tar', ['-xf', archive, '-C', extraction], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (unpacked.status !== 0 || unpacked.error) throw new Error('unable to extract Node distribution')
    const sourceRoot = join(extraction, distribution.directory)
    const sourceNode = join(sourceRoot, distribution.executable)
    const relativeNode = `node/${options.target}/${distribution.executable}`
    const packagedNode = join(temporary, relativeNode)
    await mkdir(dirname(packagedNode), { recursive: true })
    await copyFile(sourceNode, packagedNode)
    await chmod(packagedNode, 0o755)
    await copyFile(join(sourceRoot, 'LICENSE'), join(temporary, 'node', options.target, 'LICENSE'))
    const probe = spawnSync(packagedNode, ['-p', 'JSON.stringify(process.versions)'], {
      encoding: 'utf8',
      windowsHide: true,
      env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      timeout: 5_000,
    })
    let versions: { node?: string; electron?: string } = {}
    try {
      versions = JSON.parse(probe.stdout)
    } catch {
      // The common failure below is intentionally stable and does not expose child output.
    }
    if (probe.status !== 0 || versions.node !== NODE_VERSION || versions.electron)
      throw new Error('packaged Node runtime probe failed')
    const runner = await buildHooksIsolationRunner(join(temporary, 'isolation'))
    const result: RuntimePackageManifest = {
      schemaVersion: 1,
      target: options.target,
      node: {
        version: NODE_VERSION,
        executable: relativeNode,
        sha256: await hash(packagedNode),
        upstreamArchiveSha256: distribution.sha256,
      },
      runner: { directory: 'isolation', entry: HOOKS_RUNNER_ENTRY, sha256: runner.sha256 },
    }
    await writeFile(join(temporary, 'runtime.manifest.json'), `${JSON.stringify(result, null, 2)}\n`)
    await transaction.commit()
    return result
  } finally {
    try {
      if (extraction) await rm(extraction, { recursive: true, force: true })
    } finally {
      await transaction.dispose()
    }
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (invoked) {
  const defaultTarget = `${process.platform}-${process.arch}` // guards-allow-platform: release packager.
  const target = (argument('--target') ?? defaultTarget) as RuntimeTarget
  if (!Object.hasOwn(DISTRIBUTIONS, target)) throw new Error(`unsupported runtime package target: ${target}`)
  const output = argument('--output')
  if (!output) throw new Error('usage: package-isolation-runtime --output <directory> [--target <target>]')
  await packageIsolationRuntime({ outputDirectory: output, target })
}
