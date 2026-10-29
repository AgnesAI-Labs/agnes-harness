import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { inspectStaged } from '../src/inspect.js'
import { packPlugin } from '../src/plugin-pack.js'
import { fetchSource, parseSource } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('shares a bundled third-party dependency into an isolated receiving folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-sharing-'))
  roots.push(root)
  const source = join(root, 'author 中文 folder'),
    receiver = join(root, 'friend')
  mkdirSync(source)
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  // Reuse a real installed dependency; no registry access or install scripts.
  const require = createRequire(import.meta.url)
  // Stage the dependency outside the Unicode path: Node 24's Windows cpSync can misencode it.
  cpSync(dirname(require.resolve('yaml/package.json')), join(root, 'yaml'), {
    recursive: true,
  })
  renameSync(join(root, 'yaml'), join(source, 'node_modules', 'yaml'))
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'shared-tool',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.js',
      dependencies: { yaml: '2.9.0' },
      agnes: {
        plugins: [{ id: 'ext:shared/main', apiRange: '^5.0.0', export: 'main', capabilities: { ui: true } }],
        hostProvidedExternals: { '@agnes/extension-api': '^5.0.0' },
        clientDescriptors: [{ rowId: 'ext:shared/main', path: './agnes.client.json' }],
      },
    }),
  )
  writeFileSync(
    join(source, 'index.js'),
    "import { parse } from 'yaml'; export const main = () => parse('hello: friend').hello;",
  )
  writeFileSync(
    join(source, 'agnes.client.json'),
    JSON.stringify({
      client: {
        entry: './client.js',
        slots: [],
        services: [],
        projections: [],
        publicConfig: {},
        slotCatalogVersion: 'dsh-client-slots/v1',
      },
    }),
  )
  writeFileSync(
    join(source, 'client.js'),
    "import { createElement } from 'react'; import { homeNavigation } from '@agnes/web-client'; import { Button } from '@agnes/web-ui'; export const page = () => createElement(Button, null, String(homeNavigation));",
  )
  const archive = await packPlugin(source, join(root, 'shared.tgz'))
  rmSync(source, { recursive: true, force: true })
  await fetchSource(parseSource('file:' + archive.split(sep).join('/')), receiver, { cwd: root })
  const loaded = await import(pathToFileURL(join(receiver, '.agnes-packed-entry.mjs')).href)
  expect(loaded.main()).toBe('friend')
  const browser = readFileSync(join(receiver, 'client.js'), 'utf8')
  for (const specifier of ['react', '@agnes/web-client', '@agnes/web-ui'])
    expect(browser).toContain(specifier)
})

it('keeps the packed entry beside a nested original entry so import.meta.url reads still resolve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-nested-pack-'))
  roots.push(root)
  const source = join(root, 'nested'),
    receiver = join(root, 'friend')
  mkdirSync(join(source, 'dist'), { recursive: true })
  mkdirSync(join(source, 'skills'))
  writeFileSync(join(source, 'skills', 'x.md'), 'skill body')
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'nested-tool',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './dist/index.js',
      agnes: {
        plugins: [{ id: 'ext:nested/main', apiRange: '^5.0.0', export: 'main', capabilities: { ui: true } }],
      },
    }),
  )
  writeFileSync(
    join(source, 'dist', 'index.js'),
    "import { readFileSync } from 'node:fs'; export const main = () => readFileSync(new URL('../skills/x.md', import.meta.url), 'utf8');",
  )
  const archive = await packPlugin(source, join(root, 'nested.tgz'))
  rmSync(source, { recursive: true, force: true })
  await fetchSource(parseSource('file:' + archive.split(sep).join('/')), receiver, { cwd: root })
  const manifest = JSON.parse(readFileSync(join(receiver, 'package.json'), 'utf8'))
  expect(manifest.exports).toBe('./dist/.agnes-packed-entry.mjs')
  expect(manifest.main).toBe('./dist/.agnes-packed-entry.mjs')
  const loaded = await import(pathToFileURL(join(receiver, 'dist', '.agnes-packed-entry.mjs')).href)
  expect(loaded.main()).toBe('skill body')
})

it('packs a complete skin candidate for download, retaining entry, descriptor and relative assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-skin-sharing-'))
  roots.push(root)
  const source = join(root, 'candidate-copy'),
    receiver = join(root, 'receiver')
  const { skinFiles } = await import(
    new URL('../bundled-plugins/plugin-helper/src/skin.mjs', import.meta.url).href
  )
  const files: { path: string; content: string }[] = skinFiles()
  for (const file of files) {
    mkdirSync(dirname(join(source, file.path)), { recursive: true })
    writeFileSync(join(source, file.path), file.content)
  }
  // A preview made of only the former three attachments cannot be packed as a plugin.
  renameSync(join(source, 'index.mjs'), join(root, 'saved-entry.mjs'))
  await expect(packPlugin(source, join(root, 'incomplete.tgz'))).rejects.toThrow()
  renameSync(join(root, 'saved-entry.mjs'), join(source, 'index.mjs'))
  const archive = await packPlugin(source, join(root, 'skin.tgz'))
  await expect(packPlugin(source, archive)).rejects.toThrow('new archive path')
  rmSync(source, { recursive: true, force: true })
  const sourceRef = parseSource('file:' + archive.split(sep).join('/'))
  const fetched = await fetchSource(sourceRef, receiver, { cwd: root })
  const inspected = await inspectStaged({
    dir: receiver,
    source: sourceRef,
    fetched,
  })
  expect(inspected.preview.blockers).toEqual([])
  const pkg = JSON.parse(readFileSync(join(receiver, 'package.json'), 'utf8'))
  const entry = await import(pathToFileURL(join(receiver, pkg.exports)).href)
  expect(typeof entry.main.apply).toBe('function')
  for (const file of files.filter((file) => file.path !== 'package.json'))
    expect(readFileSync(join(receiver, file.path), 'utf8')).toBe(file.content)
})
