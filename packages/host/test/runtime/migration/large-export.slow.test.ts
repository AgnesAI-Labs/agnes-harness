import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthorityExportPart, DataRef } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  buildExportIndex,
  EXPORT_INDEX,
  INDEX_MAX_BYTES,
  type IndexCheckpoint,
  type IndexStorage,
  initialIndexCheckpoint,
  verifyExportIndex,
} from '../../../src/runtime/migration/export-index.js'

/** Real index bytes only. This fixture neither copies a ledger/asset nor proves a State/Budget fence. */
describe('migration index scale', () => {
  it('writes and cold-reopens one million parts with bounded pages/RSS and a persisted checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'large-export-index-'))
    const count = 1_000_000,
      digest = 'ab'.repeat(32)
    const baselineRSS = process.memoryUsage().rss
    let peakRSS = baselineRSS,
      indexBytes = 0,
      maxPageBytes = 0,
      pageCount = 0
    const sample = () => {
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss)
    }
    function openStorage(): IndexStorage {
      return {
        async put(bytes, typeId) {
          sample()
          const hash = createHash('sha256').update(bytes).digest('hex')
          await writeFile(join(directory, hash), bytes, { flag: 'wx' })
          indexBytes += bytes.length
          maxPageBytes = Math.max(maxPageBytes, bytes.length)
          pageCount++
          return {
            kind: 'blob',
            schema: { typeId, revision: 1, digest },
            blob: {
              authorityId: 'index',
              blobId: hash,
              digest: hash,
              bytes: bytes.length,
              mediaType: `application/json; fixture=${'x'.repeat(64)}`,
              pinId: 'index-pin',
            },
          }
        },
        async *read(blob) {
          for await (const chunk of createReadStream(join(directory, blob.blobId), {
            highWaterMark: 65536,
          })) {
            sample()
            yield chunk as Buffer
          }
        },
      }
    }
    async function* parts(): AsyncGenerator<AuthorityExportPart> {
      for (let index = 0; index < count; index++) {
        const key = `record-${String(index).padStart(8, '0')}-${'x'.repeat(235)}`
        yield {
          collectionId: 'events',
          schema: { typeId: 'agh.state/events@1', revision: 1, digest },
          partIndex: index,
          firstRecordKey: key,
          lastRecordKey: key,
          records: 1,
          contentDigest: digest,
          chunk: {
            authorityId: 'source',
            blobId: `chunk-${index}`,
            digest,
            bytes: 512,
            mediaType: `application/json; fixture=${'x'.repeat(64)}`,
            pinId: 'pin',
          },
        }
      }
    }
    const start = performance.now()
    try {
      const root = await buildExportIndex(EXPORT_INDEX, parts(), openStorage())
      writeFileSync(join(directory, 'root.json'), JSON.stringify(root))
      const buildMs = performance.now() - start
      const checkpointFile = join(directory, 'checkpoint.json')
      const initial = initialIndexCheckpoint(root, EXPORT_INDEX, digest)
      writeFileSync(checkpointFile, JSON.stringify(initial))
      let firstAccepted = 0
      await expect(
        verifyExportIndex(root, initial, openStorage(), async (_item, next) => {
          firstAccepted++
          if (next.consumed === count / 2) {
            writeFileSync(checkpointFile, JSON.stringify(next), { flush: true })
            throw new Error('stop after persisted checkpoint')
          }
        }),
      ).rejects.toThrow('persisted checkpoint')
      const reopenedRoot = JSON.parse(readFileSync(join(directory, 'root.json'), 'utf8')) as DataRef
      const reopenedCheckpoint = JSON.parse(readFileSync(checkpointFile, 'utf8')) as IndexCheckpoint
      let resumedAccepted = 0
      const recoverStart = performance.now()
      const final = await verifyExportIndex(
        reopenedRoot,
        reopenedCheckpoint,
        openStorage(),
        async (item, next) => {
          if ((item as AuthorityExportPart).partIndex !== next.consumed - 1)
            throw new Error('Resumed part order changed')
          resumedAccepted++
        },
      )
      const recoverMs = performance.now() - recoverStart
      sample()
      const report = {
        evidence: 'index-layer-only',
        count,
        indexBytes,
        pageCount,
        maxPageBytes,
        baselineRSS,
        peakRSS,
        additionalRSS: peakRSS - baselineRSS,
        buildMs,
        recoverMs,
        recoveryRevalidatesPrefix: true,
        firstAccepted,
        resumedAccepted,
      }
      console.info(JSON.stringify(report))
      expect(final.consumed).toBe(count)
      expect(firstAccepted + resumedAccepted).toBe(count)
      expect(indexBytes).toBeGreaterThan(1024 ** 3)
      expect(maxPageBytes).toBeLessThanOrEqual(INDEX_MAX_BYTES)
      expect(peakRSS - baselineRSS).toBeLessThanOrEqual(256 * 1024 ** 2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 600_000)
})
