import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { identifyPackage as identifyDefault } from '../../../../packages/package-manager/src/runtime/source-snapshot.ts'
import { identifyPackage as identifyReference } from './package-bytes.ts'

describe('reference package providers', () => {
  it('does not import the default package implementation', () => {
    for (const name of ['package-bytes.ts', 'package-source.ts', 'package-resolver.ts']) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      expect(source).not.toContain('@agnes/package-manager')
      expect(source).not.toContain('packages/package-manager')
    }
  })

  it('computes the same tree digest as the default reader', () => {
    const files = [
      {
        path: 'manifest.json',
        mode: 'file' as const,
        bytes: Buffer.from(JSON.stringify({ id: 'acme.tools', version: '1.0.0' })),
      },
      { path: 'readme.txt', mode: 'file' as const, bytes: Buffer.from('same') },
    ]
    const left = identifyDefault(files)
    const right = identifyReference(files)
    expect(left.ok && right.ok).toBe(true)
    if (!left.ok || !right.ok) return
    expect(right.value.treeDigest).toBe(left.value.treeDigest)
    expect(right.value.archiveDigest).toBe(left.value.archiveDigest)
    expect(right.value.manifestDigest).toBe(left.value.manifestDigest)
  })
})
