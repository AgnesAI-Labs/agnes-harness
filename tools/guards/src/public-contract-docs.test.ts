import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const root = repoRoot()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

it('documents the source Extension API version in both contract inventories and architectures', () => {
  const source = read('packages/extension-api/src/version.ts')
  const version = /export const API_VERSION = '([^']+)'/.exec(source)?.[1]
  expect(version, 'the source contract version must be explicit').toMatch(/^\d+\.\d+\.\d+$/)
  expect(JSON.parse(read('packages/extension-api/package.json')).version).toBe(version)
  for (const stem of ['architecture-plugins', 'contracts-v0.1']) {
    for (const locale of ['', '.zh-CN']) {
      const path = `docs/develop/${stem}${locale}.md`
      const text = read(path)
      // Historical changelog versions are allowed; every statement of the current API is checked.
      const declared = [
        ...text.matchAll(
          /(?:Extension API|extension API)\s*(?:is|为)?\s*(?:\*\*|`)(\d+\.\d+\.\d+)(?:\*\*|`)/g,
        ),
      ]
      expect(declared.length, `${path} must name its Extension API version`).toBeGreaterThan(0)
      for (const match of declared) expect(match[1], path).toBe(version)
    }
  }
})

it('documents the provider kinds with named public conformance runners', () => {
  const descriptors = new Map(
    [
      ...read('packages/extension-api/src/kinds.ts').matchAll(
        /export const (\w+) = defineKind<[\s\S]*?>\(\{\s*kind: '([^']+)'/g,
      ),
    ].map((match) => [match[1], match[2]] as const),
  )
  const expected = [
    ...read('packages/extension-api/testkit/provider-conformance.ts').matchAll(
      /runProviderConformance\((\w+), options\)/g,
    ),
  ]
    .map((match) => descriptors.get(match[1]))
    .sort()
  expect(expected.length).toBeGreaterThan(0)
  expect(expected.every((kind) => typeof kind === 'string')).toBe(true)
  for (const stem of ['architecture-plugins', 'contracts-v0.1']) {
    for (const locale of ['', '.zh-CN']) {
      const path = `docs/develop/${stem}${locale}.md`
      const table = read(path).match(/^\| (?:Kind|类型) \|[^\n]*\n(?:\|.*\n)+/m)?.[0] ?? ''
      const documented = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]).sort()
      expect(documented, path).toEqual(expected)
    }
  }
})
