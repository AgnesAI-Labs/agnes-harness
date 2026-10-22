import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_VERSION, checkApiRange, isExtensionError, parseSemver, satisfiesApiRange } from '../src/index.js'

describe('parseSemver', () => {
  it('parses x.y.z and prerelease', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('2.0.0-rc.1')).toEqual({ major: 2, minor: 0, patch: 0, pre: 'rc.1' })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('v1.2.3')).toBeNull()
  })
})

describe('satisfiesApiRange', () => {
  it.each([
    ['^1.0.0', '1.0.0', true],
    ['^1.0.0', '1.4.2', true],
    ['^1.0.0', '2.0.0', false],
    ['^1.2.0', '1.1.9', false],
    ['^0.3.0', '0.3.9', true],
    ['^0.3.0', '0.4.0', false],
    ['~1.2.0', '1.2.9', true],
    ['~1.2.0', '1.3.0', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '1.0.1', false],
    ['>=1.0.0 <2.0.0', '1.9.9', true],
    ['>=1.0.0 <2.0.0', '2.0.0', false],
    ['>1.0.0', '1.0.0', false],
    ['<=1.0.0', '1.0.0', true],
    ['1.x', '1.7.0', true],
    ['1.x', '2.0.0', false],
    ['1.2.x', '1.2.5', true],
    ['*', '9.9.9', true],
    ['*', '0.1.0-alpha.0', true],
    ['*', 'invalid', false],
    ['0.1.0-alpha.0', '0.1.0-alpha.0', true],
    ['=0.1.0-alpha.0', '0.1.0-alpha.0+build.1', true],
    ['0.1.0-alpha.0', '0.1.0-alpha.1', false],
    ['0.1.0', '0.1.0-alpha.0', false],
    ['>=0.1.0-alpha.0 <0.2.0', '0.1.0-alpha.1', true],
    ['>=0.1.0-alpha.0 <0.2.0', '0.1.1-alpha.0', false],
    ['>=0.1.0-alpha.0 <0.2.0', '0.1.1', true],
    ['>=0.1.0-alpha.0 <0.2.0', '0.1.0', true],
    ['>0.1.0-alpha.9', '0.1.0-alpha.10', true],
    ['>0.1.0-alpha.10', '0.1.0-alpha.9', false],
    ['<0.1.0-rc.1', '0.1.0-beta', true],
    ['<=0.1.0-alpha', '0.1.0-alpha.1', false],
    ['>=0.1.0-1', '0.1.0-alpha', true],
    ['^0.1.0-alpha.0', '0.1.0-beta.1', true],
    ['^0.1.0-alpha.0', '0.1.1-beta.1', false],
    ['~0.1.0-alpha.0', '0.1.0', true],
    ['>=0.0.0 <1.0.0', '0.1.0-alpha.0', false],
    ['* >=0.0.0', '0.1.0-alpha.0', false],
    ['0.1.x', '0.1.0-alpha.0', false],
    ['^1.0.0', '1.5.0-rc.1', false], // 预发布不满足普通范围（fail-closed）
    ['latest', '1.0.0', false],
    ['', '1.0.0', false],
    ['^1', '1.0.0', false],
  ])('%s vs %s → %s', (range, version, ok) => {
    expect(satisfiesApiRange(range, version)).toBe(ok)
  })
  it('defaults to API_VERSION', () => {
    expect(satisfiesApiRange(`^${API_VERSION}`)).toBe(true)
  })
})

describe('checkApiRange', () => {
  it('throws E_API_RANGE with detail', () => {
    expect(() => checkApiRange({ id: 'xinwei/sales-analysis', apiRange: '^1.0.0' }, '1.3.0')).not.toThrow()
    try {
      checkApiRange({ id: 'xinwei/sales-analysis', apiRange: '^5.0.0' }, '1.3.0')
      expect.unreachable()
    } catch (e) {
      expect(isExtensionError(e) && e.code).toBe('E_API_RANGE')
      expect(isExtensionError(e) && e.detail).toEqual({ apiRange: '^5.0.0', apiVersion: '1.3.0' })
      expect(isExtensionError(e) && e.extId).toBe('xinwei/sales-analysis')
    }
  })
})

describe('supported API subset boundary cases', () => {
  it.each([
    ['^1.0', '1.9.9', true],
    ['^0.0', '0.0.9', true],
    ['^0.0', '0.1.0', false],
    ['^0.0.1', '0.0.2', false],
    ['^0.0.1', '0.0.1', true],
    ['^0.3.0', '0.9.0', false],
    ['1.*', '1.2.3+build.4', true],
    ['>=1.0.0 <=1.2.3', '1.2.3', true],
    ['>=*', '1.0.0', false],
    ['^1.x', '1.0.0', false],
    ['^1.0.0-rc.1', '1.0.0', true],
    ['1.0.0 || 2.0.0', '1.0.0', false],
    ['01.x', '1.0.0', false],
  ])('%s admits %s: %s', (range, version, expected) => {
    expect(satisfiesApiRange(range, version)).toBe(expected)
  })
  it('rejects unsafe or malformed versions and accepts valid build metadata', () => {
    for (const v of ['9007199254740992.0.0', '01.0.0', '1.0.0-01', '1.0.0-a..b', '1.0.0+'])
      expect(parseSemver(v)).toBeNull()
    expect(parseSemver('1.2.3-rc.1+build.01')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'rc.1' })
  })
  it('exercises checkApiRange default version through both acceptance and rejection', () => {
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^5.0' })).not.toThrow()
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^6.0' })).toThrow(/E_API_RANGE/)
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^4.0' })).toThrow(/E_API_RANGE/)
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^3.0' })).toThrow(/E_API_RANGE/)
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^1.0' })).toThrow(/E_API_RANGE/)
  })
})

describe('5.0.0 major API', () => {
  it('admits ^5 ranges and refuses every ^4 range at the 5.0.0 major API', () => {
    expect(API_VERSION).toBe('5.0.0')
    for (const range of ['^5.0.0', '^5.0', '>=5.0.0 <6.0.0', '5.*'])
      expect(satisfiesApiRange(range), range).toBe(true)
    for (const range of ['^4.0.0', '^4.0', '4.*']) expect(satisfiesApiRange(range), range).toBe(false)
  })

  // The default plugins ship with the API: every bundled helper and every builtin package row the
  // daemon loads on boot must be admitted by the current API_VERSION, or a fresh install refuses
  // its own defaults with E_API_RANGE.
  it('admits every bundled plugin and builtin plugin row', () => {
    const packages = new URL('../../', import.meta.url)
    const dirs = (rel: string) =>
      readdirSync(new URL(rel, packages), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `${rel}${d.name}/`)
    const manifestDirs = [
      ...dirs('package-manager/bundled-plugins/'),
      'ai/',
      'base/',
      'code/',
      ...dirs('base/extensions/'),
      ...dirs('code/src/extensions/'),
    ]
    const ranges: [string, string | undefined][] = []
    for (const dir of manifestDirs) {
      let pkg: {
        agnes?: {
          plugins?: { id?: string; apiRange?: string }[]
          hostProvidedExternals?: Record<string, string>
        }
      }
      try {
        pkg = JSON.parse(readFileSync(new URL(`${dir}package.json`, packages), 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      for (const row of pkg.agnes?.plugins ?? []) ranges.push([`${dir} ${row.id ?? ''}`, row.apiRange])
      const external = pkg.agnes?.hostProvidedExternals?.['@agnes/extension-api']
      if (external !== undefined) ranges.push([`${dir} hostProvidedExternals`, external])
    }
    // Rows declared in code rather than in a package.json: the packaged CLI's copies of the base and
    // code declarations, and the Host's own kernel rows.
    for (const file of [
      'cli/launch/packaged-host.ts',
      'host/src/runtime/assemble/kernel-stage.ts',
      'worker-runtime/src/mcp-server-rows.ts',
    ]) {
      const text = readFileSync(new URL(file, packages), 'utf8')
      const found = [...text.matchAll(/apiRange: '([^']*)'/g)].map((m) => m[1])
      expect(found.length, file).toBeGreaterThan(0)
      for (const range of found) ranges.push([file, range])
    }
    expect(ranges.length).toBeGreaterThan(60)
    const refused = ranges.filter(([, range]) => range === undefined || !satisfiesApiRange(range))
    expect(refused).toEqual([])
    expect(ranges.filter(([, range]) => range !== '^5.0.0')).toEqual([])
  })
})
