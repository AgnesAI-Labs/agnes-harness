import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createPackageSourceProvider as defaultSource } from '../../../../packages/package-manager/src/runtime/providers/package-source.ts'
import {
  digestJson,
  identifyPackage,
  readPackageTree,
} from '../../../../packages/package-manager/src/runtime/source-snapshot.ts'
import { digestDirectory, digestMembers } from './local-tree.ts'
import { createPackageSourceProvider as referenceSource } from './package-source.ts'

const listing = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) !== listing.directory) return fs.readdirSync(...args)
      return typeof args[1] === 'object' && args[1]?.withFileTypes ? [{ name: 'a\\b.txt' }] : ['a\\b.txt']
    },
  }
})

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

  it('computes the same tree digest and the same refusal as the default reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reference-digest-'))
    const linked = mkdtempSync(join(tmpdir(), 'reference-link-'))
    const escaped = mkdtempSync(join(tmpdir(), 'reference-escape-'))
    try {
      const packageDir = join(root, 'acme.tools', '1.0.0')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(
        join(packageDir, 'agnes.plugin.json'),
        JSON.stringify({
          id: 'acme.tools',
          version: '1.0.0',
          packageDigest: 'ab'.repeat(32),
          providers: [
            { descriptor: { packageDigest: 'ab'.repeat(32), configSchema: { digest: 'cd'.repeat(32) } } },
          ],
          renderers: [{ packageDigest: 'ab'.repeat(32) }],
          clientServices: [{ packageDigest: 'ab'.repeat(32) }],
          payload: { packageDigest: 'ef'.repeat(32) },
          entries: { web: { digest: '12'.repeat(32), platform: 'web' } },
        }),
      )
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
      expect(digested.value.manifest).toEqual(identified.value.manifest)
      expect(digested.value.manifest).toMatchObject({
        providers: [{ descriptor: { packageDigest: identified.value.treeDigest } }],
        renderers: [{ packageDigest: identified.value.treeDigest }],
        clientServices: [{ packageDigest: identified.value.treeDigest }],
        payload: { packageDigest: 'ef'.repeat(32) },
        entries: { web: { digest: '12'.repeat(32), platform: 'web' } },
      })
      const members = digestMembers([
        { path: 'agnes.plugin.json', bytes: readFileSync(join(packageDir, 'agnes.plugin.json')) },
        { path: 'readme.txt', bytes: Buffer.from('same') },
      ])
      expect(members.ok).toBe(true)
      if (!members.ok) return
      expect(members.value.treeDigest).toBe(identified.value.treeDigest)
      for (const digest of ['cd'.repeat(32), 'ef'.repeat(32), '12'.repeat(32)]) {
        const changedFiles = listed.value.map((file) =>
          file.path === 'agnes.plugin.json'
            ? { ...file, bytes: Buffer.from(file.bytes.toString('utf8').replaceAll(digest, '34'.repeat(32))) }
            : file,
        )
        const defaultChanged = identifyPackage(changedFiles)
        const referenceChanged = digestMembers(changedFiles)
        if (!defaultChanged.ok || !referenceChanged.ok) throw new Error('modified tree did not parse')
        expect(referenceChanged.value.treeDigest).toBe(defaultChanged.value.treeDigest)
        expect(referenceChanged.value.treeDigest).not.toBe(identified.value.treeDigest)
      }

      const fixture = readPackageTree(
        fileURLToPath(new URL('../../../packages/runtime-ui-bundle/v1/', import.meta.url)),
      )
      if (!fixture.ok) throw new Error(fixture.message)
      const manifest = JSON.parse(
        fixture.value.find((file) => file.path === 'agnes.plugin.json')?.bytes.toString('utf8') ?? 'null',
      ) as { id: string; version: string; packageDigest: string }
      const realDefault = identifyPackage(fixture.value)
      const realReference = digestMembers(fixture.value)
      if (!realDefault.ok || !realReference.ok) throw new Error('real UI bundle did not parse')
      expect(realDefault.value.treeDigest).toBe(manifest.packageDigest)
      expect(realReference.value.treeDigest).toBe(manifest.packageDigest)
      expect(realReference.value.manifest).toEqual(realDefault.value.manifest)
      expect(realReference.value.manifestDigest).toBe(digestJson(manifest))
      const legacy = fixture.value.map((file) =>
        file.path === 'agnes.plugin.json' ? { ...file, path: 'manifest.json' } : file,
      )
      expect(identifyPackage(legacy)).toMatchObject({
        ok: false,
        code: 'invalid_input',
        detailCode: 'manifest_missing',
      })
      expect(digestMembers(legacy)).toMatchObject({
        ok: false,
        code: 'invalid_input',
        detailCode: 'manifest_missing',
      })
      const sourceRoot = join(root, 'fixture-source')
      const fixtureDir = join(sourceRoot, manifest.id, manifest.version)
      for (const tampered of [false, true]) {
        for (const file of fixture.value) {
          const target = join(fixtureDir, file.path)
          mkdirSync(join(target, '..'), { recursive: true })
          const bytes = Buffer.from(file.bytes)
          if (tampered && file.path === 'web/index.js') bytes[0] = (bytes[0] ?? 0) ^ 1
          writeFileSync(target, bytes)
        }
        for (const [name, create] of [
          ['default', defaultSource],
          ['reference', referenceSource],
        ] as const) {
          const provider = create({
            cacheDir: join(root, `${name}-${tampered}`),
            localRoots: { local: sourceRoot },
          })
          try {
            const result = await provider.fetch({
              locator: {
                kind: 'local',
                sourceId: 'local',
                pathRef: `${manifest.id}@${manifest.version}`,
                digest: manifest.packageDigest,
              },
              expectedDigest: manifest.packageDigest,
            })
            expect(result).toMatchObject(
              tampered
                ? { ok: false, code: 'denied', detailCode: 'digest_mismatch' }
                : { ok: true, value: { verifiedDigest: manifest.packageDigest } },
            )
            expect(provider.executedEntries()).toEqual([])
          } finally {
            provider.dispose()
          }
        }
      }

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
        join(escaped, 'pkg', 'agnes.plugin.json'),
        JSON.stringify({ id: 'acme.tools', version: '1.0.0' }),
      )
      // Inject a nonportable directory entry: Windows treats the backslash as a separator.
      listing.directory = realpathSync(join(escaped, 'pkg'))
      const defaultEscape = readPackageTree(join(escaped, 'pkg'))
      const referenceEscape = digestDirectory(join(escaped, 'pkg'))
      expect(defaultEscape.ok).toBe(false)
      expect(referenceEscape.ok).toBe(false)
      if (defaultEscape.ok || referenceEscape.ok) return
      expect(referenceEscape.detailCode).toBe(defaultEscape.detailCode)
      expect(referenceEscape.detailCode).toBe('path_escape')
    } finally {
      listing.directory = ''
      rmSync(root, { recursive: true, force: true })
      rmSync(linked, { recursive: true, force: true })
      rmSync(escaped, { recursive: true, force: true })
    }
  })
})
