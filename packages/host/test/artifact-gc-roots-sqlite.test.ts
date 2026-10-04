import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { computerUseArtifactRootSnapshot } from '../src/artifact-gc-roots-sqlite.js'
import { ARTIFACT_REF_EXTRACTOR_VERSION } from '../src/artifact-ledger-refs.js'
import {
  readComparisonArchiveRoots,
  withComparisonArchiveRootsLock,
} from '../src/runtime/comparison-archive-roots.js'

const digest = (character: string) => character.repeat(64)

describe('Computer Use artifact root snapshot', () => {
  it('keeps indexed ledger and request-media roots of candidates and declares absent producers empty', async () => {
    const ledger = digest('a')
    const request = digest('b')
    const ignored = digest('c')
    const input = {
      candidateDigests: new Set([ledger, request, ignored]),
      roots: { ledger: new Set([ledger, request, digest('f')]), requestMedia: new Set([request]) },
    }
    const first = await computerUseArtifactRootSnapshot(input)
    const second = await computerUseArtifactRootSnapshot(input)
    expect(first).toEqual(second)
    expect(first.roots.ledger.roots.map((root) => root.sha256)).toEqual([ledger, request])
    expect(first.roots['request-media'].roots).toEqual([
      { sha256: request, artifactUri: `artifact://${request}` },
    ])
    expect(first.roots.export.roots).toEqual([])
    const archived = await computerUseArtifactRootSnapshot({
      ...input,
      archives: new Set([request, digest('f')]),
    })
    expect(archived.roots.export.roots).toEqual([{ sha256: request }])
    expect(archived.identity.hash).not.toBe(first.identity.hash)
    expect(first.roots.retention.roots).toEqual([])
    expect(first.roots.rollback.roots).toEqual([])
    expect(first.identity.hash).toMatch(/^[a-f0-9]{64}$/u)
    // The epoch no longer depends on ledger size; only the roots distinguish two snapshots.
    const other = await computerUseArtifactRootSnapshot({
      ...input,
      roots: { ledger: new Set([ledger]), requestMedia: new Set([request]) },
    })
    expect(other.identity.epoch).toBe(first.identity.epoch)
    expect(other.identity.hash).not.toBe(first.identity.hash)
  })

  it('fails closed for a nonempty store without a root database', async () => {
    await expect(
      computerUseArtifactRootSnapshot({ candidateDigests: new Set([digest('e')]) }),
    ).rejects.toThrow(/database/)
    const empty = await computerUseArtifactRootSnapshot({ candidateDigests: new Set() })
    expect(
      Object.values(empty.roots).every((snapshot) => snapshot.complete && snapshot.roots.length === 0),
    ).toBe(true)
  })

  it.each([
    [false, 'comparison_archives'],
    [true, 'comparison_archives'],
    [false, 'comparison_tree_archives'],
    [true, 'comparison_tree_archives'],
  ] as const)(
    'excludes archive publication through deletion, existing database=%s, table=%s',
    async (existing, table) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'agnes-archive-gc-lock-'))
      const directory = join(dataDir, 'comparisons')
      const file = join(directory, 'index.sqlite')
      const candidates = new Set([digest('a')])
      let writer: DatabaseSync | undefined
      try {
        // Planning is read-only even when no archive database has ever existed.
        expect(readComparisonArchiveRoots(dataDir, candidates)).toEqual(new Set())
        expect(existsSync(directory)).toBe(false)
        if (existing) {
          mkdirSync(directory)
          const initial = new DatabaseSync(file)
          initial.close()
        }
        await withComparisonArchiveRootsLock(dataDir, candidates, 0, async (roots) => {
          expect(roots).toEqual(new Set())
          writer = new DatabaseSync(file)
          writer.exec('PRAGMA busy_timeout=0')
          expect(() => writer?.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
          // A suspension between the final root proof and deletion retains the same write lock.
          await Promise.resolve()
          expect(() => writer?.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
        })
        const publisher = writer as DatabaseSync
        publisher.exec('BEGIN IMMEDIATE')
        publisher.exec(`CREATE TABLE ${table}(digest TEXT,roots TEXT,roots_digest TEXT,roots_version TEXT)`)
        const roots = JSON.stringify([...candidates])
        const bodyDigest = digest('b')
        publisher
          .prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`)
          .run(
            bodyDigest,
            roots,
            createHash('sha256')
              .update(`${ARTIFACT_REF_EXTRACTOR_VERSION}\n${bodyDigest}\n${roots}`)
              .digest('hex'),
            ARTIFACT_REF_EXTRACTOR_VERSION,
          )
        publisher.exec('COMMIT')
        expect(readComparisonArchiveRoots(dataDir, candidates)).toEqual(candidates)
        await withComparisonArchiveRootsLock(dataDir, candidates, 0, async (roots) => {
          expect(roots).toEqual(candidates)
        })
        publisher.exec(`UPDATE ${table} SET roots_digest='corrupt'`)
        expect(() => readComparisonArchiveRoots(dataDir, candidates)).toThrow()
      } finally {
        writer?.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  )

  it('declines deletion under a busy archive writer and releases its lock after deletion failure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-archive-gc-busy-'))
    mkdirSync(join(dataDir, 'comparisons'))
    const writer = new DatabaseSync(join(dataDir, 'comparisons', 'index.sqlite'))
    let deleted = false
    try {
      writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
      await expect(
        withComparisonArchiveRootsLock(dataDir, new Set(), 0, async () => {
          deleted = true
        }),
      ).rejects.toThrow(/locked/)
      expect(deleted).toBe(false)
      writer.exec('ROLLBACK')
      await expect(
        withComparisonArchiveRootsLock(dataDir, new Set(), 0, async () => {
          throw new Error('deletion failed')
        }),
      ).rejects.toThrow('deletion failed')
      expect(() => writer.exec('BEGIN IMMEDIATE; ROLLBACK')).not.toThrow()
    } finally {
      writer.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it.each(['directory', 'database'])('rejects a symlink archive %s before deletion', async (kind) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-archive-gc-symlink-'))
    let deleted = false
    try {
      const target = join(dataDir, 'target')
      if (kind === 'directory') {
        mkdirSync(target)
        symlinkSync(target, join(dataDir, 'comparisons'))
      } else {
        mkdirSync(join(dataDir, 'comparisons'))
        const db = new DatabaseSync(target)
        db.close()
        symlinkSync(target, join(dataDir, 'comparisons', 'index.sqlite'))
      }
      await expect(
        withComparisonArchiveRootsLock(dataDir, new Set(), 0, async () => {
          deleted = true
        }),
      ).rejects.toThrow(/invalid/)
      expect(deleted).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
