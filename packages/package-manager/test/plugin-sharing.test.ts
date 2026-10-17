import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
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
        plugins: [{ id: 'ext:shared/main', apiRange: '^4.0.0', export: 'main', capabilities: { ui: true } }],
        hostProvidedExternals: { '@agnes/extension-api': '^4.0.0' },
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
