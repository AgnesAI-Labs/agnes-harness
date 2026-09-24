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
      checkApiRange({ id: 'xinwei/sales-analysis', apiRange: '^2.0.0' }, '1.3.0')
      expect.unreachable()
    } catch (e) {
      expect(isExtensionError(e) && e.code).toBe('E_API_RANGE')
      expect(isExtensionError(e) && e.detail).toEqual({ apiRange: '^2.0.0', apiVersion: '1.3.0' })
      expect(isExtensionError(e) && e.extId).toBe('xinwei/sales-analysis')
    }
  })
})

describe('stable API subset boundary cases', () => {
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
    ['^1.0.0-rc.1', '1.0.0', false],
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
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^1.0' })).not.toThrow()
    expect(() => checkApiRange({ id: 'agnes/test', apiRange: '^2.0' })).toThrow(/E_API_RANGE/)
  })
})
