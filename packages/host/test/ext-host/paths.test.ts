import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createExtHost } from '../../src/ext-host/host.js'
import { readBundledExtensionDirs, resolveEntry } from '../../src/ext-host/manifest.js'

const roots: string[] = []
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir' // guards-allow-platform: actual directory-link fixtures.
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-extension-path-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const bundle = (root: string, entries: string[]) =>
  writeFileSync(join(root, 'package.json'), JSON.stringify({ agnes: { extensions: entries } }))

it('refuses unresolved roots, missing entries and directories before module import', () => {
  const root = scratch()
  mkdirSync(join(root, 'directory.ts'))
  for (const [dir, entry] of [
    [join(root, 'absent'), './index.ts'],
    [root, './absent.ts'],
    [root, './directory.ts'],
  ] as const)
    expect(() => resolveEntry(dir, entry)).toThrow(/E_EXT_LOAD/)
})

it('refuses a missing target beneath an escaping directory link', () => {
  const root = scratch()
  const outside = scratch()
  symlinkSync(outside, join(root, 'outside'), directoryLink)
  expect(realpathSync(join(root, 'outside'))).toBe(realpathSync(outside))
  expect(() => resolveEntry(root, './outside/missing.ts')).toThrow(/E_EXT_LOAD/)
})

it('refuses a broken file link', () => {
  const root = scratch()
  const outside = scratch()
  symlinkSync(join(outside, 'missing.ts'), join(root, 'broken.ts'))
  expect(() => resolveEntry(root, './broken.ts')).toThrow(/E_EXT_LOAD/)
})

it('rejects nonportable and traversal paths even if normalization would stay inside', () => {
  const root = scratch()
  writeFileSync(join(root, 'index.ts'), '')
  mkdirSync(join(root, 'nested'))
  for (const entry of [
    '',
    '.',
    './nested/../index.ts',
    'C:/index.ts',
    'C:index.ts',
    '\\index.ts',
    './a\u0000.ts',
  ])
    expect(() => resolveEntry(root, entry)).toThrow(/E_EXT_LOAD/)
})

it('returns the verified canonical file through in-root links and a linked root', () => {
  const root = scratch()
  const aliases = scratch()
  writeFileSync(join(root, 'index.ts'), '')
  symlinkSync(join(root, 'index.ts'), join(root, 'alias.ts'))
  symlinkSync(root, join(aliases, 'root'), directoryLink)
  expect(resolveEntry(join(aliases, 'root'), './alias.ts')).toBe(realpathSync(join(root, 'index.ts')))
})

it('resolves an ordinary entry through a linked directory root', () => {
  const root = scratch()
  const aliases = scratch()
  writeFileSync(join(root, 'index.ts'), '')
  symlinkSync(root, join(aliases, 'root'), directoryLink)
  expect(resolveEntry(join(aliases, 'root'), './index.ts')).toBe(realpathSync(join(root, 'index.ts')))
})

it('allows ordinary names that begin with two dots without confusing them with traversal', () => {
  const root = scratch()
  writeFileSync(join(root, '..valid.ts'), '')
  expect(resolveEntry(root, './..valid.ts')).toBe(realpathSync(join(root, '..valid.ts')))
  mkdirSync(join(root, '..extension'))
  bundle(root, ['..extension'])
  expect(readBundledExtensionDirs(root, true)).toEqual([realpathSync(join(root, '..extension'))])
})

it('requires declared extension directories to exist and be directories', () => {
  const root = scratch()
  writeFileSync(join(root, 'file'), '')
  for (const entry of ['missing', 'file']) {
    bundle(root, [entry])
    expect(() => readBundledExtensionDirs(root, true)).toThrow(/E_EXT_LOAD/)
  }
})

it('rejects escaping extension links and canonicalizes allowed directory links', () => {
  const root = scratch()
  const outside = scratch()
  mkdirSync(join(root, 'actual'))
  symlinkSync(outside, join(root, 'outside'), directoryLink)
  symlinkSync(join(root, 'actual'), join(root, 'alias'), directoryLink)
  bundle(root, ['outside'])
  expect(() => readBundledExtensionDirs(root, true)).toThrow(/E_EXT_LOAD/)
  bundle(root, ['alias'])
  expect(readBundledExtensionDirs(root, true)).toEqual([realpathSync(join(root, 'actual'))])
})

it('does not silently treat a package.json read failure as an absent declaration', () => {
  const root = scratch()
  mkdirSync(join(root, 'package.json'))
  expect(() => readBundledExtensionDirs(root)).toThrow(/E_EXT_LOAD/)
})

it('loads a real in-root linked module while rejecting an escaping module before evaluation', async () => {
  const root = scratch()
  const outside = scratch()
  const marker = join(outside, 'evaluated')
  writeFileSync(
    join(outside, 'index.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => {}`,
  )
  for (const id of ['ok', 'escape']) {
    const dir = join(root, id)
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'agnes.extension.json'),
      JSON.stringify({
        id: `fixture/${id}`,
        version: '1.0.0',
        apiRange: '^1.0',
        entry: './alias.mjs',
        capabilities: {},
      }),
    )
    if (id === 'ok') writeFileSync(join(dir, 'index.mjs'), 'export default () => {}')
    symlinkSync(join(id === 'ok' ? dir : outside, 'index.mjs'), join(dir, 'alias.mjs'))
  }
  bundle(root, ['ok', 'escape'])
  const ext = await createExtHost({
    packages: new Map([['fixture/pkg', root]]),
    tools: {
      add() {
        throw new Error('these extensions request no tools')
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  try {
    expect(ext.status().find((s) => s.id === 'fixture/ok')?.loaded).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(ext.status().find((s) => s.id === 'escape')?.error?.message).toBe('invalid extension manifest')
  } finally {
    await ext.disposeAll()
  }
})
