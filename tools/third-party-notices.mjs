import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const packLicenseRoot = join(import.meta.dirname, '../third-party/pack-licenses')

function packageFromInput(workingDirectory, input) {
  const absolute = resolve(workingDirectory, input)
  const segments = absolute.split(sep)
  let nodeModules = -1
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] === 'node_modules') nodeModules = index
  }
  if (nodeModules < 0) return undefined

  const first = segments[nodeModules + 1]
  const scopedName = segments[nodeModules + 2]
  if (!first || (first.startsWith('@') && !scopedName)) return undefined
  const name = first.startsWith('@') ? `${first}/${scopedName}` : first
  if (name === '@agnes' || name.startsWith('@agnes/')) return undefined

  const packageSegments = first.startsWith('@') ? [first, scopedName] : [first]
  return {
    name,
    directory: join(segments.slice(0, nodeModules + 1).join(sep), ...packageSegments),
  }
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Copy licenses for packages present in esbuild's bundle graphs; record every required notice. */
export async function collectThirdPartyNotices(
  workingDirectory,
  outputDirectory,
  builds,
  fallbackLicenses = {},
) {
  const licenseSources = JSON.parse(await readFile(join(packLicenseRoot, 'sources.json'), 'utf8'))
  const destination = join(outputDirectory, 'THIRD-PARTY-NOTICES')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const packages = new Map()
  const inputs = new Set(builds.flatMap((result) => Object.keys(result.metafile?.inputs ?? {})))
  for (const input of [...inputs].sort()) {
    const resolved = packageFromInput(workingDirectory, input)
    if (resolved && !packages.has(resolved.name)) packages.set(resolved.name, resolved.directory)
  }

  const inventory = []
  for (const [name, directory] of [...packages].sort(([left], [right]) => compare(left, right))) {
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (metadata.name !== name) {
      throw new Error(`[third-party-notices] Could not resolve package metadata for ${name}`)
    }
    const files = await readdir(directory)
    const license = files
      .filter((file) => /^licen[sc]e(?:[.-]|$)/i.test(file))
      .sort((left, right) => {
        if (left.toLowerCase() === 'license') return -1
        if (right.toLowerCase() === 'license') return 1
        return compare(left, right)
      })[0]
    const cached = licenseSources.find((entry) => entry.name === name && entry.version === metadata.version)
    const fallback = Object.hasOwn(fallbackLicenses, name)
      ? fallbackLicenses[name]
      : cached
        ? join(packLicenseRoot, cached.file)
        : undefined
    if (!license && !fallback) {
      throw new Error(`[third-party-notices] No LICENSE file found for ${name}@${metadata.version}`)
    }

    const fileName = `${name.replace(/^@/, '').replaceAll('/', '-')}.txt`
    await writeFile(
      join(destination, fileName),
      await readFile(license ? join(directory, license) : fallback),
    )
    inventory.push({ name, version: metadata.version, license: metadata.license, file: fileName })
  }
  await writeFile(join(destination, 'index.json'), `${JSON.stringify(inventory, null, 2)}\n`)
}
