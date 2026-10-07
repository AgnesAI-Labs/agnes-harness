#!/usr/bin/env node
import { cp, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Preview-only SDK links for optional compilation/tests. Safe to repeat on the same package. */
async function link(source, target, type) {
  try {
    await symlink(source, target, type)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let current
    try {
      current = await readlink(target)
    } catch {
      throw new Error(`Cannot link ${target}: an existing non-link occupies this SDK path`)
    }
    if (resolve(dirname(target), current) !== resolve(dirname(target), source))
      throw new Error(`Cannot link ${target}: it points to a different SDK; choose a fresh destination`)
  }
}
export async function linkLocal(destination) {
  const target = resolve(destination)
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  await mkdir(join(target, 'node_modules'), { recursive: true })
  await mkdir(join(target, 'node_modules/@agnes'), { recursive: true })
  const names = new Set(['cordis', 'cosmokit', 'extension-api', 'protocol', 'plugin-runtime'])
  for (const name of Object.keys(dependencies))
    if (name.startsWith('@agnes/') && name !== '@agnes/host') names.add(name.slice('@agnes/'.length))
  for (const name of names) {
    const source = join(repo, 'packages', name)
    const published = join(target, 'node_modules/@agnes', name)
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    await mkdir(published, { recursive: true })
    try {
      await cp(join(source, 'dist'), join(published, 'dist'), { recursive: true })
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(`Build the preview SDK first: pnpm exec tsc -b packages/${name}`)
      throw error
    }
    // Runtime tests use source through tsx; consumer compilation uses built declarations.
    for (const dir of ['src', 'testkit', 'gen']) {
      try {
        await link(join(source, dir), join(published, dir), 'dir')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const exports = Object.fromEntries(
      Object.entries(metadata.exports).map(([key, path]) => [
        key,
        { types: path.replace('./', './dist/').replace(/\.ts$/, '.d.ts'), default: path },
      ]),
    )
    await writeFile(join(published, 'package.json'), JSON.stringify({ ...metadata, exports }, null, 2))
  }
  if (dependencies['@agnes/host'])
    await link(join(repo, 'packages/host'), join(target, 'node_modules/@agnes/host'), 'dir')
  await mkdir(join(target, 'node_modules/@sinclair'), { recursive: true })
  await link(
    join(repo, 'packages/plugin-runtime/node_modules/@sinclair/typebox'),
    join(target, 'node_modules/@sinclair/typebox'),
    'dir',
  )
  for (const name of ['@types', 'typescript', 'tsx'])
    await link(join(repo, 'node_modules', name), join(target, 'node_modules', name), 'dir')
  await mkdir(join(target, 'node_modules/.bin'), { recursive: true })
  await link('../typescript/bin/tsc', join(target, 'node_modules/.bin/tsc'))
  return target
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || process.argv.length !== 3)
      throw new TypeError('Usage: node templates/link-local.mjs <new-plugin-directory>')
    console.log(`Linked preview SDK into ${await linkLocal(process.argv[2])}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
