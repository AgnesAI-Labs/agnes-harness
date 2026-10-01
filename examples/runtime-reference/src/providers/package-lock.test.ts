import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  identifyPackage,
  readPackageTree,
} from '../../../../packages/package-manager/src/runtime/source-snapshot.ts'
import { digestDirectory, digestMembers } from './local-tree.ts'

const REFERENCE_FILES = ['local-tree.ts', 'package-source.ts', 'package-resolver.ts'] as const

const DEFAULT_FILES = {
  'local-tree.ts': '../../../../packages/package-manager/src/runtime/source-snapshot.ts',
  'package-source.ts': '../../../../packages/package-manager/src/runtime/providers/package-source.ts',
  'package-resolver.ts': '../../../../packages/package-manager/src/runtime/providers/package-resolver.ts',
} as const

function collapsedLines(source: string): Set<string> {
  const lines = new Set<string>()
  for (const line of source.split('\n')) {
    const collapsed = line.replace(/\s+/g, '')
    if (collapsed !== '') lines.add(collapsed)
  }
  return lines
}

function sharedFraction(left: Set<string>, right: Set<string>): number {
  const smaller = Math.min(left.size, right.size)
  if (smaller === 0) return 1
  let shared = 0
  for (const line of left) if (right.has(line)) shared += 1
  return shared / smaller
}

describe('reference package providers', () => {
  it('does not import the default package implementation', () => {
    for (const name of REFERENCE_FILES) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      expect(source).not.toContain('@agnes/package-manager')
      expect(source).not.toContain('packages/package-manager')
    }
  })

  it('does not share more than half of its collapsed lines with the default file', () => {
    for (const name of REFERENCE_FILES) {
      const reference = collapsedLines(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
      const counterpart = collapsedLines(readFileSync(new URL(DEFAULT_FILES[name], import.meta.url), 'utf8'))
      expect(sharedFraction(reference, counterpart)).toBeLessThanOrEqual(0.5)
    }
  })

  it('computes the same tree digest and the same refusal as the default reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'reference-digest-'))
    const linked = mkdtempSync(join(tmpdir(), 'reference-link-'))
    const escaped = mkdtempSync(join(tmpdir(), 'reference-escape-'))
    try {
      const packageDir = join(root, 'acme.tools', '1.0.0')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({ id: 'acme.tools', version: '1.0.0' }))
      writeFileSync(join(packageDir, 'readme.txt'), 'same')
      const listed = readPackageTree(packageDir)
      const digested = digestDirectory(packageDir)
      expect(listed.ok && digested.ok).toBe(true)
      if (!listed.ok || !digested.ok) return
      const identified = identifyPackage(listed.value)
      expect(identified.ok).toBe(true)
      if (!identified.ok) return
      expect(digested.value.treeDigest).toBe(identified.value.treeDigest)
      expect(digested.value.manifestDigest).toBe(identified.value.manifestDigest)
      const members = digestMembers([
        { path: 'manifest.json', bytes: readFileSync(join(packageDir, 'manifest.json')) },
        { path: 'readme.txt', bytes: Buffer.from('same') },
      ])
      expect(members.ok).toBe(true)
      if (!members.ok) return
      expect(members.value.treeDigest).toBe(identified.value.treeDigest)

      symlinkSync(packageDir, join(linked, 'via-link'))
      const defaultLink = readPackageTree(join(linked, 'via-link'))
      const referenceLink = digestDirectory(join(linked, 'via-link'))
      expect(defaultLink.ok).toBe(false)
      expect(referenceLink.ok).toBe(false)
      if (defaultLink.ok || referenceLink.ok) return
      expect(referenceLink.detailCode).toBe(defaultLink.detailCode)
      expect(referenceLink.detailCode).toBe('symlink_escape')

      mkdirSync(join(escaped, 'pkg'), { recursive: true })
      writeFileSync(
        join(escaped, 'pkg', 'manifest.json'),
        JSON.stringify({ id: 'acme.tools', version: '1.0.0' }),
      )
      writeFileSync(join(escaped, 'pkg', 'a\\b.txt'), 'nope')
      const defaultEscape = readPackageTree(join(escaped, 'pkg'))
      const referenceEscape = digestDirectory(join(escaped, 'pkg'))
      expect(defaultEscape.ok).toBe(false)
      expect(referenceEscape.ok).toBe(false)
      if (defaultEscape.ok || referenceEscape.ok) return
      expect(referenceEscape.detailCode).toBe(defaultEscape.detailCode)
      expect(referenceEscape.detailCode).toBe('path_escape')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(linked, { recursive: true, force: true })
      rmSync(escaped, { recursive: true, force: true })
    }
  })
})
