import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_VERSION } from '../src/index.js'

describe('API_VERSION', () => {
  it('is a plain semver string', () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('is pinned to the package.json version', () => {
    // This is the one package in the repo that ships its own semver; the rest sit at 0.0.0. An
    // extension manifest states the API range it needs, and that range is matched against
    // API_VERSION — but what an author sees and pins is the published package version. If the
    // two drift apart, a manifest written against the published number gets judged against a
    // different one and is rejected. Bumping the version therefore has to move both.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(
      pkg.version,
      'package.json version and the API_VERSION constant in src/index.ts must be the same string',
    ).toBe(API_VERSION)
  })
})
