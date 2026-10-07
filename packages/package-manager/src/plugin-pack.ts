import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { build as Esbuild } from 'esbuild'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'
import { inspectStaged } from './inspect.js'
import { readStaticJson } from './integrity.js'
import { defaultExec, fetchSource, hashDirectory, readPackageJson } from './sources.js'

function entryTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  return entryTarget(row.import) ?? entryTarget(row.node) ?? entryTarget(row.default)
}

/** Bundle third-party dependencies, retain Host SDK imports, then validate the distributable tree. */
export async function packPlugin(folder: string, output?: string): Promise<string> {
  const source = resolve(folder)
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())
    throw new PackageError(
      'E_DEP_MISSING',
      'Pack expects a real plugin folder. See docs/guide/packages.md#sharing',
    )
  const pkg = readPackageJson(source)
  const target = resolve(output ?? `${pkg.name.replaceAll('/', '-')}-${pkg.version}.tgz`)
  const inside = relative(source, target)
  if (
    inside === '' ||
    (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) ||
    existsSync(target)
  )
    throw new PackageError(
      'E_DEP_MISSING',
      'Choose a new archive path outside the plugin folder. See docs/guide/packages.md#sharing',
    )
  const work = mkdtempSync(join(tmpdir(), 'agh-plugin-pack-'))
  try {
    const tree = join(work, 'package')
    await fetchSource({ type: 'file', ref: 'file:' + source }, tree, { cwd: source })
    const manifest = readStaticJson(join(tree, 'package.json'))
    const agnes = manifest.agnes as
      | {
          clientDescriptors?: { path: string }[]
          hostProvidedExternals?: Record<string, string>
        }
      | undefined
    const declaredExternals = agnes?.hostProvidedExternals
    if (
      declaredExternals !== undefined &&
      (!declaredExternals ||
        typeof declaredExternals !== 'object' ||
        Array.isArray(declaredExternals) ||
        Object.keys(declaredExternals).length > 128 ||
        Object.entries(declaredExternals).some(
          ([name, range]) =>
            !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(name) ||
            typeof range !== 'string' ||
            !range ||
            range.length > 64,
        ))
    )
      throw new PackageError(
        'E_EXT_LOAD',
        'Host external declaration schema is invalid. See docs/guide/packages.md#sharing',
      )
    // Host checks availability and versions and loads namespaces from the author declaration.
    const externals = declaredExternals === undefined ? ['@agnes/*'] : Object.keys(declaredExternals)
    const exports = manifest.exports
    const targetEntry =
      entryTarget(
        exports && typeof exports === 'object' && '.' in exports
          ? (exports as Record<string, unknown>)['.']
          : exports,
      ) ?? entryTarget(manifest.main)
    if (!targetEntry)
      throw new PackageError(
        'E_EXT_LOAD',
        'Plugin export is missing; set package.json exports. See docs/guide/packages.md#troubleshooting',
      )
    const input = containedEntry(source, targetEntry, 'file', 'package.json')
    const destination = join(tree, '.agnes-packed-entry.mjs')
    const requireBundler = createRequire(import.meta.url)
    let build: typeof Esbuild
    try {
      build = (requireBundler('esbuild') as typeof import('esbuild')).build
    } catch {
      // npx delivery moves runtime node_modules into vendor/.
      build = (
        requireBundler(
          fileURLToPath(new URL('./vendor/esbuild/lib/main.js', import.meta.url)),
        ) as typeof import('esbuild')
      ).build
    }
    const bundled = await build({
      entryPoints: [input],
      outfile: destination,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: [...externals, 'node:*'],
      metafile: true,
      legalComments: 'eof',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __aghCreateRequire } from 'node:module'; var require = __aghCreateRequire(import.meta.url);",
      },
    })
    manifest.exports =
      exports && typeof exports === 'object' && '.' in exports
        ? { ...exports, '.': './.agnes-packed-entry.mjs' }
        : './.agnes-packed-entry.mjs'
    manifest.main = './.agnes-packed-entry.mjs'
    writeFileSync(join(tree, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (
      bundled.warnings.some(
        (warning) =>
          warning.id === 'unsupported-require-call' || warning.id === 'require-resolve-not-external',
      )
    )
      throw new PackageError(
        'E_EXT_LOAD',
        'Dependency uses dynamic require; use static imports before sharing. See docs/guide/packages.md#sharing',
      )
    const inputs = { ...bundled.metafile?.inputs }
    for (const descriptor of agnes?.clientDescriptors ?? []) {
      const descriptorFile = containedEntry(source, descriptor.path, 'file', 'package.json')
      const client = readStaticJson(descriptorFile).client as { entry?: string } | undefined
      if (!client?.entry) continue
      const entry = containedEntry(dirname(descriptorFile), client.entry, 'file', descriptor.path)
      const output = join(tree, relative(source, entry))
      const browser = await build({
        entryPoints: [entry],
        outfile: output,
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        external: externals,
        metafile: true,
        legalComments: 'eof',
        logLevel: 'silent',
      })
      Object.assign(inputs, browser.metafile?.inputs)
    }
    // esbuild retains legal comments. Also ship each bundled dependency's license/notice files.
    const noticeDir = join(tree, 'THIRD-PARTY-NOTICES')
    const seen = new Set<string>()
    for (const inputFile of Object.keys(inputs)) {
      let dir = dirname(resolve(inputFile))
      while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
      if (!dir.includes('node_modules') || seen.has(dir)) continue
      seen.add(dir)
      const dep = readStaticJson(join(dir, 'package.json'))
      mkdirSync(noticeDir, { recursive: true })
      for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE'])
        if (existsSync(join(dir, name)))
          writeFileSync(
            join(noticeDir, String(dep.name).replaceAll('/', '-') + '-' + name),
            readFileSync(join(dir, name)),
          )
    }
    const integrity = hashDirectory(tree)
    const result = inspectStaged({
      dir: tree,
      source: { type: 'file', ref: 'file:' + source },
      fetched: {
        dir: tree,
        version: pkg.version,
        integrity,
        ...(pkg.license === undefined ? {} : { license: pkg.license }),
        dependencies: pkg.dependencies,
      },
      ceiling: [],
    })
    if (result.preview.blockers.length)
      throw new PackageError(
        'E_EXT_LOAD',
        'Plugin manifest is blocked; fix declarations before packing. See docs/guide/packages.md#sharing',
      )
    mkdirSync(dirname(target), { recursive: true })
    const archive = join(work, 'plugin.tgz')
    await defaultExec('tar', ['-czf', archive, '-C', work, 'package'], { cwd: work })
    // Copy through an exclusive file so another process's output is never overwritten.
    writeFileSync(target, readFileSync(archive), { flag: 'wx' })
    return target
  } catch (error) {
    if (error instanceof PackageError) throw error
    throw new PackageError(
      'E_EXT_LOAD',
      'Plugin could not be packed; check exports, installed dependencies and static imports. See docs/guide/packages.md#sharing',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
