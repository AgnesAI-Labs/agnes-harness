import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_VERSION } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { HostError } from '../../src/errors.js'
import {
  checkApiRange,
  readBundledExtensionDirs,
  readExtensionManifest,
  resolveEntry,
} from '../../src/ext-host/index.js'

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agnes-manifest-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  return root
}

const fail = (fn: () => unknown): HostError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HostError) return e
    throw e
  }
  throw new Error('expected a refusal')
}

const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'fixture/x',
    version: '1.0.0',
    apiRange: '^1.0',
    entry: './index.ts',
    capabilities: {},
    ...over,
  })

describe('readExtensionManifest', () => {
  it('reads the four fields and the tool authority', () => {
    const dir = join(fixtures, 'pkg-exts', 'extensions', 'ok')
    expect(readExtensionManifest(dir)).toEqual({
      id: 'fixture/ok',
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.ts',
      tools: { prefix: 'fx_', names: ['fx_one', 'fx_two'] },
    })
  })

  it('distinguishes no tools block, a prefix-only bound, and a closed list', () => {
    const none = scratch({ 'agnes.extension.json': manifest(), 'index.ts': '' })
    expect(readExtensionManifest(none).tools).toEqual({ prefix: '', names: [] })
    const prefixOnly = scratch({
      'agnes.extension.json': manifest({ capabilities: { tools: { prefix: 'p_' } } }),
      'index.ts': '',
    })
    expect(readExtensionManifest(prefixOnly).tools).toEqual({ prefix: 'p_', names: null })
    const closed = scratch({
      'agnes.extension.json': manifest({ capabilities: { tools: { prefix: '', names: ['a'] } } }),
      'index.ts': '',
    })
    expect(readExtensionManifest(closed).tools).toEqual({ prefix: '', names: ['a'] })
  })

  it('refuses a declared name that does not carry the declared prefix', () => {
    const dir = scratch({
      'agnes.extension.json': manifest({ capabilities: { tools: { prefix: 'p_', names: ['q_one'] } } }),
      'index.ts': '',
    })
    const e = fail(() => readExtensionManifest(dir))
    expect(e.code).toBe('E_EXT_LOAD')
    expect(e.detail?.tool).toBe('q_one')
  })

  it('refuses a manifest whose apiRange does not admit the running API', () => {
    const dir = scratch({ 'agnes.extension.json': manifest({ apiRange: '^9.0' }), 'index.ts': '' })
    expect(fail(() => readExtensionManifest(dir)).code).toBe('E_API_RANGE')
  })

  it('refuses a manifest that is missing, malformed, or missing a field', () => {
    expect(fail(() => readExtensionManifest(scratch({ 'other.json': '{}' }))).detail?.reason).toBe(
      'unreadable',
    )
    expect(fail(() => readExtensionManifest(scratch({ 'agnes.extension.json': '{' }))).detail?.reason).toBe(
      'not-json',
    )
    const noId = scratch({ 'agnes.extension.json': manifest({ id: '' }), 'index.ts': '' })
    expect(fail(() => readExtensionManifest(noId)).detail?.field).toBe('id')
  })
})

describe('checkApiRange', () => {
  it('admits a range the running API satisfies', () => {
    expect(() => checkApiRange('m', '^1.0', '1.0.0')).not.toThrow()
    expect(() => checkApiRange('m', '^1.2.3', '1.4.0')).not.toThrow()
  })
  it('refuses a different major, and a minor below the floor', () => {
    expect(fail(() => checkApiRange('m', '^2.0', '1.0.0')).code).toBe('E_API_RANGE')
    expect(fail(() => checkApiRange('m', '^1.5', '1.4.9')).code).toBe('E_API_RANGE')
    expect(fail(() => checkApiRange('m', '^1.2.3', '1.2.2')).code).toBe('E_API_RANGE')
  })
  it('uses the shared stable subset and rejects unsupported syntax', () => {
    expect(() => checkApiRange('m', '>=1.0.0', '1.0.0')).not.toThrow()
    expect(() => checkApiRange('m', '*', '1.0.0')).not.toThrow()
    for (const range of ['latest', '^1', '>=*', '1.0.0 || 2.0.0'])
      expect(fail(() => checkApiRange('m', range)).code).toBe('E_API_RANGE')
    expect(fail(() => checkApiRange('m', '^0.3.0', '0.9.0')).code).toBe('E_API_RANGE')
    expect(fail(() => checkApiRange('m', '^0.0.1', '0.0.2')).code).toBe('E_API_RANGE')
  })
  it('accepts the supported subset through real on-disk manifests and the default API path', () => {
    // The narrow tilde entry tracks the running API_VERSION rather than a hardcoded version, so it
    // stays a real positive case (not an accidental exclusion) across future version bumps.
    for (const apiRange of [`~${API_VERSION}`, '>=1.0.0 <2.0.0', '1.*', '*']) {
      const dir = scratch({ 'agnes.extension.json': manifest({ apiRange }), 'index.ts': '' })
      expect(readExtensionManifest(dir).apiRange).toBe(apiRange)
    }
    const rejected = scratch({ 'agnes.extension.json': manifest({ apiRange: '>=*' }), 'index.ts': '' })
    expect(fail(() => readExtensionManifest(rejected)).code).toBe('E_API_RANGE')
  })
})

describe('resolveEntry', () => {
  it('accepts an entry inside the extension directory', () => {
    const dir = join(fixtures, 'pkg-exts', 'extensions', 'ok')
    expect(resolveEntry(dir, './index.ts')).toBe(join(dir, 'index.ts'))
  })
  it('refuses a relative entry that climbs out, and an absolute one', () => {
    const dir = join(fixtures, 'pkg-exts', 'extensions', 'escape')
    expect(fail(() => resolveEntry(dir, '../ok/index.ts')).detail?.reason).toBe('entry-escape')
    expect(fail(() => resolveEntry(dir, '/etc/passwd')).detail?.reason).toBe('entry-escape')
  })
  it('refuses a symlink inside the directory that points outside it', () => {
    const outside = scratch({ 'secret.ts': 'export default 1' })
    const dir = scratch({ 'agnes.extension.json': manifest() })
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'index.ts'))
    expect(fail(() => resolveEntry(dir, './index.ts')).detail?.reason).toBe('entry-escape')
  })
})

describe('readBundledExtensionDirs', () => {
  it('returns the declared directories, absolute', () => {
    const pkg = join(fixtures, 'pkg-exts')
    expect(readBundledExtensionDirs(pkg, true)).toEqual([
      join(pkg, 'extensions', 'ok'),
      join(pkg, 'extensions', 'undeclared'),
      join(pkg, 'extensions', 'throws'),
      join(pkg, 'extensions', 'escape'),
    ])
  })
  it('is empty for a directory with no package.json and for a package that declares nothing', () => {
    expect(readBundledExtensionDirs(scratch({ 'x.txt': '' }))).toEqual([])
    expect(readBundledExtensionDirs(scratch({ 'package.json': '{"name":"n"}' }))).toEqual([])
  })
  it('refuses a malformed declaration and one that escapes the package directory', () => {
    expect(fail(() => readBundledExtensionDirs(join(fixtures, 'pkg-bad'), true)).detail?.reason).toBe(
      'bad-package',
    )
    const out = scratch({ 'package.json': '{"agnes":{"extensions":["../elsewhere"]}}' })
    expect(fail(() => readBundledExtensionDirs(out, true)).detail?.reason).toBe('bad-package')
  })
  it('refuses a package that declares both executable loading formats', () => {
    const dir = scratch({
      'package.json': JSON.stringify({ agnes: { extensions: [], plugins: [{ export: 'main' }] } }),
    })
    expect(fail(() => readBundledExtensionDirs(dir)).detail?.reason).toBe('legacy-extension-format')
    expect(readBundledExtensionDirs(dir, true)).toEqual([])
  })
  it('refuses a third-party package that declares only the retired format', () => {
    const dir = scratch({ 'package.json': JSON.stringify({ agnes: { extensions: [] } }) })
    expect(fail(() => readBundledExtensionDirs(dir)).detail?.reason).toBe('legacy-extension-format')
  })
})

it('does not echo malformed JSON source through direct manifest errors', () => {
  const marker = 'synthetic-note'
  const dir = scratch({ 'agnes.extension.json': marker })
  const error = fail(() => readExtensionManifest(dir))
  expect(error.message).toContain('is not valid JSON')
  expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(marker)
})
