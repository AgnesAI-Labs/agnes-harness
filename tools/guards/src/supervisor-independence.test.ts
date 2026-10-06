import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, repoRoot } from './repo.js'

const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

/** Module specifiers a source text imports or re-exports. */
export function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
}

const PLATFORM = /^@agnes\/(?:core|host|ai|daemon)(?:\/|$)/
const REFERENCE_FORBIDDEN = (specifier: string) =>
  PLATFORM.test(specifier) || /(?:^|\/)packages\/(?:core|host|ai|daemon)\//.test(specifier)
const DEFAULT_FORBIDDEN = (specifier: string) =>
  /^@agnes\/(?:host|ai|daemon)(?:\/|$)/.test(specifier) ||
  /(?:^|\/)(?:examples\/runtime-reference|packages\/(?:host|ai|daemon))\//.test(specifier)

export function offending(source: string, forbidden: (specifier: string) => boolean): string[] {
  return specifiersOf(source).filter(forbidden)
}

describe('supervisor implementations stay independent', () => {
  it('finds static, re-exported, dynamic and side-effect imports', () => {
    const text = [
      "import { a } from '@agnes/core'",
      "export * from '../../../packages/core/src/index.js'",
      "const lazy = await import('@agnes/host/runtime')",
      "import '@agnes/ai'",
      "import type { T } from '@agnes/protocol/runtime'",
    ].join('\n')
    expect(offending(text, REFERENCE_FORBIDDEN)).toEqual([
      '@agnes/core',
      '../../../packages/core/src/index.js',
      '@agnes/host/runtime',
      '@agnes/ai',
    ])
    expect(specifiersOf(text)).toHaveLength(5)
  })
  it('lets the reference use only the public packages', () => {
    expect(
      offending(
        "import x from '@agnes/extension-api/runtime'\nimport y from '@agnes/protocol/runtime'\nimport z from './supervisor-wire.js'",
        REFERENCE_FORBIDDEN,
      ),
    ).toEqual([])
  })
  it('keeps the default off host, ai, daemon and the reference', () => {
    expect(
      offending(
        "import x from '../supervisor/ports.js'\nimport y from '@agnes/protocol/runtime'",
        DEFAULT_FORBIDDEN,
      ),
    ).toEqual([])
    expect(
      offending(
        "import x from '@agnes/host'\nconst r = await import('../../../../examples/runtime-reference/src/providers/supervisor.ts')",
        DEFAULT_FORBIDDEN,
      ),
    ).toEqual(['@agnes/host', '../../../../examples/runtime-reference/src/providers/supervisor.ts'])
  })
  it('holds for every reference supervisor file and every default supervisor source file', () => {
    const root = repoRoot()
    const reference = listSourceFiles(join(root, 'examples/runtime-reference/src/providers')).filter((file) =>
      /\/supervisor[^/]*\.ts$/.test(file),
    )
    const dflt = [
      ...listSourceFiles(join(root, 'packages/core/src/runtime/supervisor')),
      join(root, 'packages/core/src/runtime/providers/supervisor.ts'),
    ]
    expect(reference.length).toBeGreaterThan(0)
    const bad: string[] = []
    for (const file of reference)
      for (const s of offending(readFileSync(file, 'utf8'), REFERENCE_FORBIDDEN))
        bad.push(`${relative(root, file)} -> ${s}`)
    for (const file of dflt)
      for (const s of offending(readFileSync(file, 'utf8'), DEFAULT_FORBIDDEN))
        bad.push(`${relative(root, file)} -> ${s}`)
    expect(bad).toEqual([])
  })
})
