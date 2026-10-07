import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const source = join(root, 'author'),
    receiver = join(root, 'friend')
  mkdirSync(source)
  mkdirSync(join(source, 'node_modules'), { recursive: true })
  // Reuse a real installed dependency; no registry access or install scripts.
  const require = createRequire(import.meta.url)
  cpSync(dirname(require.resolve('yaml/package.json')), join(source, 'node_modules', 'yaml'), {
    recursive: true,
  })
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'shared-tool',
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.js',
      dependencies: { yaml: '2.9.0' },
      agnes: { plugins: [{ export: 'main' }], capabilities: {} },
    }),
  )
  writeFileSync(
    join(source, 'index.js'),
    "import { parse } from 'yaml'; export const main = () => parse('hello: friend').hello;",
  )
  const archive = await packPlugin(source, join(root, 'shared.tgz'))
  rmSync(source, { recursive: true, force: true })
  await fetchSource(parseSource('file:' + archive), receiver, { cwd: root })
  const loaded = await import(pathToFileURL(join(receiver, '.agnes-packed-entry.mjs')).href)
  expect(loaded.main()).toBe('friend')
})
