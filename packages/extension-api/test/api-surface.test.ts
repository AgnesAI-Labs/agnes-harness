import { readFileSync } from 'node:fs'
import * as testkit from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import { releaseProblems } from '../tools/release-check-core.js'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const surface = JSON.parse(read('api-surface.json')) as { apiVersion: string; runtimeExports: string[] }
const input = {
  version: api.API_VERSION,
  packageVersion: JSON.parse(read('package.json')).version,
  changelog: read('docs/CHANGELOG.md'),
  surface,
  runtimeExports: Object.keys(api),
}

describe('author API consistency', () => {
  it('pins root and optional runtime exports without confusing them with type exports', () => {
    expect(Object.keys(api).sort()).toEqual(surface.runtimeExports)
    expect(surface.apiVersion).toBe(api.API_VERSION)
    expect(Object.keys(testkit).sort()).toEqual([
      'NEGATIVE_ACTIONS',
      'TRANSPORT_CONTRACT_CASES',
      'defineFixture',
      'projectionFixture',
      'serviceFixture',
    ])
    expect(releaseProblems(input)).toEqual([])
  })
  it('detects each version, heading and export inconsistency', () => {
    expect(releaseProblems({ ...input, packageVersion: '9.0.0' })).toEqual([
      'package.json version differs from API_VERSION',
    ])
    expect(releaseProblems({ ...input, changelog: '## 9.0.0\n' })).toEqual([
      'CHANGELOG lacks current API version heading',
    ])
    expect(releaseProblems({ ...input, surface: { ...surface, apiVersion: '9.0.0' } })).toEqual([
      'surface version differs from API_VERSION',
    ])
    expect(
      releaseProblems({
        ...input,
        runtimeExports: input.runtimeExports.filter((x) => x !== 'checkApiRange'),
      }),
    ).toEqual(['runtime exports differ from API surface snapshot'])
    expect(releaseProblems({ ...input, runtimeExports: [...input.runtimeExports, 'unexpected'] })).toEqual([
      'runtime exports differ from API surface snapshot',
    ])
  })
})
