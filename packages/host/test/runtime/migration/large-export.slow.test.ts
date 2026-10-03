import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const indexModule = new URL('../../../src/runtime/migration/export-index.ts', import.meta.url).href
// Measure actual RSS in isolated processes with a declared heap budget, without explicit GC.
// This is index-layer evidence, not the default Host's memory SLA or a State/Budget fence.
const program = `
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildExportIndex, EXPORT_INDEX, initialIndexCheckpoint, verifyExportIndex } from ${JSON.stringify(indexModule)};
const [directory, mode] = process.argv.slice(1);
const count = 1_000_000, digest = 'ab'.repeat(32);
const baselineRSS = process.memoryUsage().rss;
let peakRSS = baselineRSS, indexBytes = 0, maxPageBytes = 0, pageCount = 0, accepted = 0;
const sample = () => { peakRSS = Math.max(peakRSS, process.memoryUsage().rss); };
const storage = {
  async put(bytes, typeId) {
    sample();
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(directory, hash), bytes, { flag: 'wx' });
    indexBytes += bytes.length; maxPageBytes = Math.max(maxPageBytes, bytes.length); pageCount++;
    return { kind: 'blob', schema: { typeId, revision: 1, digest }, blob: {
      authorityId: 'index', blobId: hash, digest: hash, bytes: bytes.length,
      mediaType: 'application/json; fixture=' + 'x'.repeat(64), pinId: 'index-pin'
    }};
  },
  async *read(blob) {
    for await (const chunk of createReadStream(join(directory, blob.blobId), { highWaterMark: 65536 })) {
      sample(); yield chunk;
    }
  }
};
async function* parts() {
  for (let index = 0; index < count; index++) {
    const key = 'record-' + String(index).padStart(8, '0') + '-' + 'x'.repeat(235);
    yield { collectionId: 'events', schema: { typeId: 'agh.state/events@1', revision: 1, digest },
      partIndex: index, firstRecordKey: key, lastRecordKey: key, records: 1, contentDigest: digest,
      chunk: { authorityId: 'source', blobId: 'chunk-' + index, digest, bytes: 512,
        mediaType: 'application/json; fixture=' + 'x'.repeat(64), pinId: 'pin' }
    };
  }
}
const checkpointFile = join(directory, 'checkpoint.json');
let buildMs = null, recoverMs = null, consumed;
if (mode === 'build') {
  const start = performance.now();
  const root = await buildExportIndex(EXPORT_INDEX, parts(), storage);
  writeFileSync(join(directory, 'root.json'), JSON.stringify(root), { flush: true });
  buildMs = performance.now() - start;
  const initial = initialIndexCheckpoint(root, EXPORT_INDEX, digest);
  try {
    await verifyExportIndex(root, initial, storage, async (item, next) => {
      if (item.partIndex !== next.consumed - 1) throw new Error('Part order changed');
      accepted++;
      if (next.consumed === count / 2) {
        writeFileSync(checkpointFile, JSON.stringify(next), { flush: true });
        throw new Error('persisted checkpoint');
      }
    });
    throw new Error('Checkpoint interruption missing');
  } catch (error) { if (error.message !== 'persisted checkpoint') throw error; }
  consumed = JSON.parse(readFileSync(checkpointFile, 'utf8')).consumed;
} else if (mode === 'recover') {
  const root = JSON.parse(readFileSync(join(directory, 'root.json'), 'utf8'));
  const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
  if (checkpoint.consumed !== count / 2) throw new Error('Checkpoint changed');
  const start = performance.now();
  const final = await verifyExportIndex(root, checkpoint, storage, async (item, next) => {
    if (item.partIndex !== next.consumed - 1) throw new Error('Resumed part order changed');
    accepted++;
  });
  consumed = final.consumed;
  recoverMs = performance.now() - start;
} else throw new Error('Unknown phase');
sample();
console.log(JSON.stringify({ evidence: 'index-layer-only', pid: process.pid, mode, count,
  indexBytes, pageCount, maxPageBytes, baselineRSS, peakRSS, additionalRSS: peakRSS - baselineRSS,
  heapBudgetMiB: 128, buildMs, recoverMs, recoveryRevalidatesPrefix: true, accepted, consumed }));
`
interface ScaleReport {
  pid: number
  indexBytes: number
  pageCount: number
  maxPageBytes: number
  additionalRSS: number
  accepted: number
  consumed: number
}

describe('migration index scale', () => {
  it('writes one million parts and resumes a persisted checkpoint in a new bounded-heap process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'large-export-index-'))
    async function phase(mode: 'build' | 'recover'): Promise<ScaleReport> {
      const { stdout } = await execute(
        process.execPath,
        [
          '--max-old-space-size=128',
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          program,
          directory,
          mode,
        ],
        { timeout: 600_000, maxBuffer: 1024 * 1024 },
      )
      console.info(stdout.trim())
      return JSON.parse(stdout) as ScaleReport
    }
    try {
      const built = await phase('build')
      const recovered = await phase('recover')
      expect(built.pid).not.toBe(recovered.pid)
      expect(built.consumed).toBe(500_000)
      expect(recovered.consumed).toBe(1_000_000)
      expect(built.accepted).toBe(500_000)
      expect(recovered.accepted).toBe(500_000)
      expect(built.indexBytes).toBeGreaterThan(1024 ** 3)
      expect(built.maxPageBytes).toBeLessThanOrEqual(1024 * 1024)
      for (const report of [built, recovered]) {
        expect(report.additionalRSS).toBeLessThanOrEqual(256 * 1024 ** 2)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 1_200_000)
})
