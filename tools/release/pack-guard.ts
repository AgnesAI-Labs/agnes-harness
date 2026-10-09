import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { PUBLIC_PACKAGE_NAME, PUBLIC_PACKAGE_VERSION, publishableManifest } from './npx-package.js'

/** Build tools intentionally shipped for plugin authoring (esbuild) are runtime dependencies. */
const devOnly =
  /^(?:vitest|@vitest\/.*|tsx|typescript|@types\/.*|@biomejs\/.*|@playwright\/.*|@axe-core\/.*|eslint|@eslint\/.*|prettier|ts-node|happy-dom)$/

export async function packageFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const paths: string[] = []
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        const path = posix.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Pack contains a symlink: ${path}`)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) paths.push(path)
        else throw new Error(`Pack contains a special file: ${path}`)
      }),
    )
  }
  await walk('')
  let cursor = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const path = paths[cursor++]
        if (path === undefined) return
        // Native libraries and OCR data can be large; only textual contracts need their contents.
        if (/\.(?:node|wasm|traineddata|dylib|so(?:\.\d+)*)$/.test(path)) {
          files.set(path, Buffer.alloc((await lstat(join(root, path))).size ? 1 : 0))
        } else files.set(path, await readFile(join(root, path)))
      }
    }),
  )
  return files
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** Audit the extracted tarball, including manifests npm never treats as dependencies. */
export function guardPackedFiles(files: ReadonlyMap<string, Buffer>, triple: string): void {
  publishableManifest(triple)
  function required(path: string): void {
    if (!files.get(path)?.length) throw new Error(`Missing or empty packed file: ${path}`)
  }
  for (const path of [
    'package.json',
    'bin/agh',
    'LICENSE',
    'NOTICE',
    'README.md',
    'dist/agnes.mjs',
    'dist/daemon.mjs',
    'dist/worker.mjs',
    'dist/authoring-sdk.mjs',
    'dist/authoring-sdk-exports.json',
    'dist/prebuilds/index.json',
    `dist/prebuilds/${triple}/agnes-system.node`,
    'dist/vendor/@agnes/system-node/dist/native/agnes-system.node',
    'dist/vendor/esbuild/lib/main.js',
    'dist/vendor/sharp/package.json',
    'dist/vendor/sharp/lib/index.js',
    `dist/vendor/@img/sharp-${triple}/lib/sharp-${triple}.node`,
    'dist/project-notices/cordis-LICENSE',
    'dist/project-notices/cosmokit-LICENSE',
    'dist/THIRD-PARTY-NOTICES/ws.txt',
    'dist/THIRD-PARTY-NOTICES/index.json',
    'dist/authoring/THIRD-PARTY-NOTICES/index.json',
    'dist/web/THIRD-PARTY-NOTICES/index.json',
    'dist/bundled-plugins/document-reader/src/runtime/THIRD-PARTY-NOTICES/index.json',
    'dist/license-provenance/sources.json',
    `dist/vendor/@esbuild/${triple}/${triple.startsWith('win32') ? 'esbuild.exe' : 'bin/esbuild'}`,
    `dist/ripgrep/${triple.startsWith('win32') ? 'rg.exe' : 'rg'}`,
    'dist/ripgrep/LICENSE',
    'dist/ripgrep/WRAPPER-LICENSE',
    'dist/THIRD-PARTY-NOTICES/computer-use-hermes.txt',
    'dist/web/THIRD-PARTY-NOTICES/ant-design-x-markdown.txt',
    'dist/bundled-plugins/document-reader/LICENSE',
    'dist/bundled-plugins/skill-helper/LICENSE',
  ])
    required(path)
  if (triple.startsWith('darwin') || triple.startsWith('linux')) required('dist/native/pty-relay')
  if (triple.startsWith('darwin')) {
    required('dist/native/macos-process-identity')
    required('dist/native/macos-live-app-identity')
  }
  if (triple.startsWith('win32')) {
    required('dist/vendor/@agnes/system-node/runtime/process-broker.mjs')
    required('dist/vendor/@agnes/system-node/runtime/windows-command.mjs')
  } else {
    required(`dist/vendor/@img/sharp-libvips-${triple}/lib/index.js`)
    required(`dist/vendor/@img/sharp-libvips-${triple}/README.md`)
    if (
      ![...files].some(
        ([path, content]) =>
          path.startsWith(`dist/vendor/@img/sharp-libvips-${triple}/lib/libvips-cpp.`) && content.length,
      )
    )
      throw new Error('Missing packed libvips library')
  }
  const manifest = JSON.parse(files.get('package.json')?.toString() ?? '{}')
  if (
    manifest.name !== PUBLIC_PACKAGE_NAME ||
    manifest.version !== PUBLIC_PACKAGE_VERSION ||
    manifest.private
  )
    throw new Error('Unexpected public package identity or private package')
  if (
    manifest.bin?.agh !== './bin/agh' ||
    !files.get('bin/agh')?.toString().startsWith('#!/usr/bin/env node')
  )
    throw new Error('Invalid agh executable')
  if (
    manifest.type !== 'module' ||
    manifest.exports?.['./package.json'] !== './package.json' ||
    manifest.engines?.node !== '>=24.10' ||
    manifest.license !== 'Apache-2.0' ||
    manifest.publishConfig?.access !== 'public' ||
    Object.keys(manifest.publishConfig).some((key) => key !== 'access')
  )
    throw new Error('Unexpected candidate exports, engines, license or publish configuration')
  if (
    ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
      (key) => Object.keys(manifest[key] ?? {}).length,
    )
  )
    throw new Error('Self-contained candidate must have no install-time dependencies')
  for (const path of manifest.files ?? []) {
    if (![...files.keys()].some((file) => file === path || file.startsWith(`${path}/`)))
      throw new Error(`Missing files entry: ${path}`)
  }
  const [os, cpu] = triple.split('-')
  if (
    JSON.stringify(manifest.os) !== JSON.stringify([os]) ||
    JSON.stringify(manifest.cpu) !== JSON.stringify([cpu])
  )
    throw new Error('Candidate must restrict installation to its native triple')

  for (const [path, content] of files) {
    if (
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.includes('\\') ||
      path.startsWith('../')
    )
      throw new Error(`Unsafe packed path: ${path}`)
    if (path.split('/').includes('node_modules')) throw new Error(`Unpacked dependency layout: ${path}`)
    if (!path.endsWith('package.json')) continue
    const text = content.toString()
    if (text.includes('workspace:')) throw new Error(`Workspace protocol leak: ${path}`)
    const pkg = JSON.parse(text)
    if (devOnly.test(pkg.name ?? '') || Object.keys(pkg.devDependencies ?? {}).length)
      throw new Error(`Development-only payload: ${path}`)
    if (Object.keys(pkg.scripts ?? {}).length) throw new Error(`Install/build scripts in runtime: ${path}`)
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(pkg[key] ?? {})) {
        if (devOnly.test(name) || /^(?:file:|link:)/.test(String(spec)))
          throw new Error(`Development-only runtime dependency: ${path}: ${name}`)
      }
    }
    if (path.startsWith('dist/vendor/')) {
      const directory = `${posix.dirname(path)}/`
      const license = [...files].some(
        ([file, data]) =>
          file.startsWith(directory) &&
          /^licen[sc]e(?:[.-]|$)/i.test(file.slice(directory.length)) &&
          data.length,
      )
      if (!license && !String(pkg.name).startsWith('@img/sharp-libvips-'))
        throw new Error(`Missing vendor license: ${path}`)
      for (const name of Object.keys(pkg.dependencies ?? {})) required(`dist/vendor/${name}/package.json`)
    }
    const base = dirname(path).replaceAll('\\', '/')
    // Export maps (including conditions and wildcard subpaths), bins and legacy entrypoints
    // must resolve inside their own package. Non-local conditional imports are not exports.
    for (const target of [
      ...strings(pkg.exports),
      ...strings(pkg.bin),
      ...strings(pkg.main),
      ...strings(pkg.types),
    ]) {
      const resolved = posix.normalize(posix.join(base, target))
      if (
        posix.isAbsolute(target) ||
        resolved.startsWith('../') ||
        (base !== '.' && !resolved.startsWith(`${base}/`))
      )
        throw new Error(`Escaping package target: ${path}: ${target}`)
      if (target.includes('*')) {
        const pattern = new RegExp(
          `^${resolved
            .split('*')
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
        )
        if (![...files.keys()].some((file) => pattern.test(file)))
          throw new Error(`Missing export: ${path}: ${target}`)
      } else required(resolved)
    }
  }
  for (const [path, content] of files) {
    if (path.endsWith('/THIRD-PARTY-NOTICES/index.json')) {
      const notices = JSON.parse(content.toString()) as { file: string }[]
      if (!Array.isArray(notices)) throw new Error(`Invalid notice inventory: ${path}`)
      for (const notice of notices) {
        if (typeof notice.file !== 'string' || !/^[\w-][\w.-]*\.txt$/.test(notice.file))
          throw new Error(`Invalid notice target: ${path}`)
        required(posix.join(posix.dirname(path), notice.file))
      }
    }
  }
  // esbuild split chunks are runtime files too; a complete HTML shell can still ship a broken app.
  for (const [path, content] of files) {
    if (!path.startsWith('dist/web/') || !path.endsWith('.js')) continue
    for (const match of content.toString().matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const asset = posix.normalize(posix.join(posix.dirname(path), match[1] ?? ''))
      if (!asset.startsWith('dist/web/')) throw new Error(`Escaping Web import: ${path}`)
      required(asset)
    }
  }
  // HTML and import-map targets must be prebuilt. Fetching the shell alone is insufficient.
  for (const page of ['index.html', 'admin.html', 'resources.html']) {
    const path = `dist/web/${page}`
    required(path)
    const html = files.get(path)?.toString() ?? ''
    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
    if (!importMap) throw new Error(`Missing import map: ${path}`)
    const assets = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="(\/[^"#?]+)"/g)].map(
      (match) => match[1],
    )
    for (const asset of [...assets, ...strings(JSON.parse(importMap).imports)]) {
      if (!asset?.startsWith('/') || asset.includes('..')) throw new Error(`Invalid Web asset: ${asset}`)
      required(`dist/web${asset}`)
    }
  }
}

export async function guardPackage(root: string, triple: string): Promise<void> {
  guardPackedFiles(await packageFiles(root), triple)
  if (!((await lstat(join(root, 'bin/agh'))).mode & 0o111)) throw new Error('agh bin is not executable')
}
