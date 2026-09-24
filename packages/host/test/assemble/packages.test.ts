import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEAM_NAMES } from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createJitiPackageLoader,
  MemoryPackageLoader,
  type PackageLoader,
  type PackageModule,
  readNamedExports,
} from '../../src/assemble/packages.js'
import { createLoader } from '../../src/ext-host/loader.js'

const entry = '/pkg/index.ts'
const fail = (fn: () => unknown): { code: string; detail: Record<string, unknown> } => {
  try {
    fn()
  } catch (e) {
    return e as unknown as { code: string; detail: Record<string, unknown> }
  }
  throw new Error('expected a refusal')
}

describe('readNamedExports', () => {
  it('reads seams/operations/presets/runtimes/ecosystem/compaction policy and records the entry', () => {
    const buildCompactionPlan = async () => null
    const m = readNamedExports('acme/seams', entry, {
      seams: { approval: async () => ({ ask: async () => 'allowed-once', resume: async () => null }) },
      operations: {
        disclose: () => ({
          name: 'disclose',
          slot: 'core',
          replay: 'safe',
          applicable: async () => 'applied',
          run: async () => ({}),
        }),
      },
      presets: { standard: { name: 'standard' } },
      runtimes: { python: async () => ({ language: 'python' }) },
      ecosystem: { 'agnes/example': () => () => undefined },
      buildCompactionPlan,
      default: () => {},
    })
    expect(Object.keys(m.seams ?? {})).toEqual(['approval'])
    expect(Object.keys(m.operations ?? {})).toEqual(['disclose'])
    expect(m.presets?.standard?.name).toBe('standard')
    expect(typeof m.runtimes?.python).toBe('function')
    expect(typeof m.ecosystem?.['agnes/example']).toBe('function')
    expect(m.buildCompactionPlan).toBe(buildCompactionPlan)
    expect(m.extensionEntry).toBe(entry)
  })
  it('a module with none of the four exports is a module with no contributions', () => {
    const m = readNamedExports('acme/empty', entry, { default: () => {} })
    expect(m).toEqual({ id: 'acme/empty', extensionEntry: entry })
  })
  it('rejects a seams value that is not a factory, naming the seam', () => {
    const e = fail(() => readNamedExports('acme/bad', entry, { seams: { approval: 'nope' } }))
    expect(e.code).toBe('E_SEAM_EXPORT_MISSING')
    expect(e.detail.seam).toBe('approval')
  })
  // The old check was `Object.values(v).every(f => typeof f === 'function')`, which is true for []
  // and for {}, and which never looked at a single key. `{ notASeam: fn }` sailed through and was
  // cast to Partial<Record<SeamName, SeamFactory>>; the hole then surfaced in Task 25 as an
  // E_SEAM_EXPORT_MISSING pointing at the seam, not at the package that misspelled it.
  it('rejects a seams key that is not a seam name, an empty object, and an array', () => {
    const misspelled = fail(() =>
      readNamedExports('acme/bad', entry, { seams: { notASeam: async () => ({}) } }),
    )
    expect(misspelled.code).toBe('E_SEAM_EXPORT_MISSING')
    expect(misspelled.detail.key).toBe('notASeam')
    expect(fail(() => readNamedExports('acme/bad', entry, { seams: {} })).detail.reason).toBe('empty')
    expect(fail(() => readNamedExports('acme/bad', entry, { seams: [] })).detail.reason).toBe('not-an-object')
  })
  it('accepts every real seam name, so the key check is not a hardcoded shortlist', () => {
    const seams = Object.fromEntries(SEAM_NAMES.map((n) => [n, async () => ({})]))
    expect(Object.keys(readNamedExports('acme/all', entry, { seams }).seams ?? {}).sort()).toEqual(
      [...SEAM_NAMES].sort(),
    )
  })
  it('rejects operations that is an array rather than a factory table (ERRATA B4)', () => {
    expect(fail(() => readNamedExports('acme/bad', entry, { operations: [] })).code).toBe('E_EXT_LOAD')
    const notAFactory = fail(() => readNamedExports('acme/bad', entry, { operations: { x: { name: 'x' } } }))
    expect(notAFactory.code).toBe('E_EXT_LOAD')
    expect(notAFactory.detail.operation).toBe('x')
  })
  it('rejects a runtimes key that is not a known language', () => {
    const e = fail(() => readNamedExports('acme/bad', entry, { runtimes: { ruby: async () => ({}) } }))
    expect(e.code).toBe('E_EXT_LOAD')
    expect(e.detail.key).toBe('ruby')
  })
  it('rejects an ecosystem export that is not a table of factories', () => {
    expect(fail(() => readNamedExports('acme/bad', entry, { ecosystem: [] })).detail.reason).toBe(
      'not-an-object',
    )
    const invalid = fail(() =>
      readNamedExports('acme/bad', entry, { ecosystem: { 'agnes/example': 'not-a-factory' } }),
    )
    expect(invalid.code).toBe('E_EXT_LOAD')
    expect(invalid.detail.extension).toBe('agnes/example')
  })
  it('rejects a preset document with no name', () => {
    const e = fail(() => readNamedExports('acme/bad', entry, { presets: { p: { title: 'p' } } }))
    expect(e.code).toBe('E_EXT_LOAD')
    expect(e.detail.preset).toBe('p')
  })
  it('rejects a non-callable compaction policy export before assembly', () => {
    const e = fail(() => readNamedExports('acme/bad', entry, { buildCompactionPlan: {} }))
    expect(e.code).toBe('E_EXT_LOAD')
    expect(e.detail.reason).toBe('not-a-function')
  })
})

describe('MemoryPackageLoader', () => {
  it('serves modules by id', async () => {
    // Typed as the interface, because the interface is what assemble() holds: a loader that
    // quietly narrowed importPackage would still satisfy the class and not the contract.
    const l: PackageLoader = new MemoryPackageLoader({ 'a/b': { id: 'a/b' } satisfies PackageModule })
    expect((await l.importPackage('a/b', '/x')).id).toBe('a/b')
    await expect(l.importPackage('a/c', '/x')).rejects.toThrow(/E_DEP_MISSING/)
  })
})

describe('createJitiPackageLoader', () => {
  const dirs: string[] = []
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'agnes-jiti-pkg-'))
    dirs.push(d)
    return d
  }
  const loader = () =>
    createJitiPackageLoader(createLoader({ cacheDir: dir(), hostRoot: dir(), agnesVersion: '0.0.0' }))
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("reads package.json exports['.'] over a decoy main, loads the entry through jiti, and resolves extensionEntry", async () => {
    const d = dir()
    // `main` is a decoy pointing at a file that does not exist: exports['.'] must win when both are
    // present, so a loader that fell back to `main` here would fail to resolve the entry at all.
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: 'acme/pkg', main: './does-not-exist.js', exports: { '.': './index.ts' } }),
    )
    writeFileSync(
      join(d, 'index.ts'),
      'export const seams = { approval: async () => ({ ask: async () => "allowed-once", resume: async () => null }) }',
    )
    // Typed as the interface: importPackage is what assemble() calls, not the concrete loader.
    const l: PackageLoader = loader()
    const m = await l.importPackage('acme/pkg', d)
    expect(m.id).toBe('acme/pkg')
    expect(Object.keys(m.seams ?? {})).toEqual(['approval'])
    expect(realpathSync(m.extensionEntry as string)).toBe(realpathSync(join(d, 'index.ts')))
  })

  it('falls back to package.json main when exports is absent', async () => {
    const d = dir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'acme/main-pkg', main: './lib/entry.ts' }))
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(join(d, 'lib', 'entry.ts'), 'export const seams = { approval: async () => ({}) }')
    const m = await loader().importPackage('acme/main-pkg', d)
    expect(realpathSync(m.extensionEntry as string)).toBe(realpathSync(join(d, 'lib', 'entry.ts')))
    expect(Object.keys(m.seams ?? {})).toEqual(['approval'])
  })

  it('refuses a package directory with no package.json', async () => {
    const d = dir()
    await expect(loader().importPackage('acme/missing', d)).rejects.toThrow(/E_DEP_MISSING/)
  })

  it('refuses exports and main entries that escape the package directory', async () => {
    const root = dir()
    const packageDirectory = join(root, 'package')
    mkdirSync(packageDirectory)
    writeFileSync(join(root, 'outside.ts'), 'export const escaped = true')
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'acme/escape', exports: '../outside.ts' }),
    )
    await expect(loader().importPackage('acme/escape', packageDirectory)).rejects.toMatchObject({
      code: 'E_EXT_LOAD',
      detail: expect.objectContaining({ reason: 'entry-escape' }),
    })
  })
})
