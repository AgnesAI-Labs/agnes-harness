import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

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

/** Copy licenses for packages present in esbuild's browser bundle graphs. */
export async function collectThirdPartyNotices(workingDirectory, outputDirectory, builds) {
  const destination = join(outputDirectory, 'THIRD-PARTY-NOTICES')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const packages = new Map()
  const inputs = new Set(builds.flatMap((result) => Object.keys(result.metafile?.inputs ?? {})))
  for (const input of [...inputs].sort()) {
    const resolved = packageFromInput(workingDirectory, input)
    if (resolved && !packages.has(resolved.name)) packages.set(resolved.name, resolved.directory)
  }

  for (const [name, directory] of [...packages].sort(([left], [right]) => compare(left, right))) {
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (metadata.name !== name) {
      console.warn(`[third-party-notices] Could not resolve package metadata for ${name}`)
      continue
    }
    const files = await readdir(directory)
    const license = files
      .filter((file) => /^license(?:[.-]|$)/i.test(file))
      .sort((left, right) => {
        if (left.toLowerCase() === 'license') return -1
        if (right.toLowerCase() === 'license') return 1
        return compare(left, right)
      })[0]
    if (!license) {
      console.warn(`[third-party-notices] No LICENSE file found for ${name}`)
      continue
    }

    const fileName = `${name.replace(/^@/, '').replaceAll('/', '-')}.txt`
    await writeFile(join(destination, fileName), await readFile(join(directory, license)))
  }
}
