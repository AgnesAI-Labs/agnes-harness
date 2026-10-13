import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_RUNTIME_ROOTS } from './image-runtime-roots.mjs'

export { IMAGE_RUNTIME_ROOTS }

const baseDirectory = fileURLToPath(new URL('../../base/', import.meta.url))

/** The prebuilt codec package sharp loads on this build host. */
export function hostImageCodecPackage(): string {
  const platform = process.platform // guards-allow-platform: build-time codec selection.
  const arch = process.arch // guards-allow-platform: build-time codec selection.
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
  const musl = platform === 'linux' && !header?.glibcVersionRuntime
  return `@img/sharp-${musl ? 'linuxmusl' : platform}-${arch}`
}

/**
 * Whether `path` lies inside `directory`, both canonicalised by the same realpath. The module loader
 * reports paths through the JavaScript realpath, which keeps Windows 8.3 short names that the native
 * realpath expands, so mixing the two would put a loaded module outside its own directory.
 */
export function isInsideDirectory(
  directory: string,
  path: string,
  canonical: (path: string) => string = realpathSync,
): boolean {
  const location = relative(canonical(directory), canonical(path))
  return location !== '' && !location.startsWith('..') && !isAbsolute(location)
}

/** Load sharp from the distribution in a separate Node process and decode a generated image there. */
export function probeImageRuntime(
  outputDirectory: string,
  node = process.execPath,
): { resolved: string; width: number } {
  const directory = resolve(outputDirectory)
  const script = `
    const load = require('node:module').createRequire(require('node:path').join(process.argv[1], 'worker.mjs'))
    const sharp = load('sharp')
    sharp({ create: { width: 4, height: 3, channels: 3, background: '#808080' } }).png().toBuffer()
      .then((png) => sharp(png).metadata())
      .then((meta) => process.stdout.write(JSON.stringify({ resolved: load.resolve('sharp'), width: meta.width })))
  `
  let output: string
  try {
    output = execFileSync(node, ['-e', script, directory], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    const detail = stderr ? `:\n${stderr.slice(-4000)}` : ''
    throw new Error(`Image runtime probe failed for ${directory}${detail}`, { cause: error })
  }
  return JSON.parse(output) as { resolved: string; width: number }
}

/** Preserve sharp's native codec, runtime dependencies and bundled license notices together. */
export async function copyImageRuntime(target: string, from = baseDirectory): Promise<void> {
  const outputDirectory = resolve(target)
  // Native optional packages export only their binary and version subpaths, not package.json.
  // Walk the node_modules hierarchy only: NODE_PATH and global folders (pnpm sets NODE_PATH to its
  // hoisted store) must never supply a package the install did not place beside sharp.
  async function manifestFor(packageDirectory: string, name: string): Promise<string | undefined> {
    for (let directory = packageDirectory; ; directory = dirname(directory)) {
      if (basename(directory) !== 'node_modules') {
        const candidate = join(directory, 'node_modules', name, 'package.json')
        try {
          await access(candidate)
          return await realpath(candidate)
        } catch {
          /* Try the next ancestor. */
        }
      }
      if (dirname(directory) === directory) return undefined
    }
  }
  const copied = new Set<string>()
  async function copy(manifest: string): Promise<void> {
    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    if (copied.has(metadata.name)) return
    const root = metadata.name.startsWith('@') ? metadata.name.split('/')[0] : metadata.name
    if (!root || !IMAGE_RUNTIME_ROOTS.includes(root))
      throw new Error(`Image runtime package ${metadata.name} is outside IMAGE_RUNTIME_ROOTS`)
    copied.add(metadata.name)
    const source = dirname(manifest)
    const destination = join(outputDirectory, 'node_modules', metadata.name)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
    })
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      const dependency = await manifestFor(source, name)
      if (!dependency) throw new Error(`Image runtime dependency is missing: ${name}`)
      await copy(dependency)
    }
    for (const name of Object.keys(metadata.optionalDependencies ?? {})) {
      const optional = await manifestFor(source, name)
      if (optional) await copy(optional)
    }
  }
  const rootManifest = await manifestFor(resolve(from), 'sharp')
  if (!rootManifest) throw new Error(`Image runtime package sharp is not installed for ${from}`)
  await copy(rootManifest)
  // Optional platform packages are skipped silently by installs that omit them; never ship no codec.
  const codec = hostImageCodecPackage()
  if (!copied.has(codec))
    throw new Error(`Image runtime codec ${codec} is not installed; run pnpm install on this platform`)
  const probe = probeImageRuntime(outputDirectory)
  if (probe.width !== 4 || !isInsideDirectory(outputDirectory, probe.resolved))
    throw new Error(`Image runtime did not load from ${outputDirectory}: ${JSON.stringify(probe)}`)
}
