import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSession } from '@agnes/bridges/convert'
import { type ArtifactReadParams, attachmentLink, type EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { formatAgnes } from '../src/commands/export.js'
import { readNativeBundle, writeNativeBundle } from '../src/commands/native-bundle.js'

// Central heavy gate only: five synthetic 20 MiB originals, served one bounded range at a time.
it('exports and preflights 100 MiB of originals separately from the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-native-originals-bench-'))
  const path = join(dir, 'originals.agnes')
  const chunkSize = 1024 * 1024
  const size = 20 * chunkSize
  const refs = Array.from({ length: 5 }, (_, index) => {
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(chunkSize, index + 1)
    for (let part = 0; part < 20; part++) digest.update(chunk)
    return { sha256: digest.digest('hex'), size, mime: 'application/octet-stream' }
  })
  const converted = importSession(
    new TextEncoder().encode(
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'synthetic-originals',
        cwd: '/synthetic',
        timestamp: '2026-10-15T00:00:00Z',
      }),
    ),
  )
  const events: EventEnvelope[] = [
    ...converted.events,
    ...refs.map((ref, index) => ({
      seq: converted.events.length + index + 1,
      ts: '2026-10-15T00:00:00Z',
      id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(index).padStart(2, '0')}`,
      type: 'user/message',
      lane: 'main',
      data: { kind: 'prompt', content: [attachmentLink(ref, `original-${index}.bin`)] },
      actor: { id: 'synthetic', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted' as const,
    })),
  ]
  const client = {
    call: async (_method: string, request: ArtifactReadParams) => {
      expect(request.sessionId).toBe('synthetic-originals')
      expect(request.laneId).toBe('main')
      const index = refs.findIndex((ref) => ref.sha256 === request.artifact.sha256)
      if (index < 0) throw new Error('unknown synthetic original')
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? '')
      if (!match) throw new Error('missing bounded byte range')
      const start = Number(match[1])
      const end = Number(match[2])
      const bytes = Buffer.alloc(end - start + 1, index + 1)
      return {
        ok: true,
        status: 206,
        artifact: refs[index],
        acceptRanges: 'bytes',
        contentLength: bytes.length,
        contentRange: `bytes ${start}-${end}/${size}`,
        etag: `"${request.artifact.sha256}"`,
        base64: bytes.toString('base64'),
      }
    },
  } as unknown as Client
  try {
    const started = performance.now()
    await writeNativeBundle(path, events, formatAgnes(events), client, 'synthetic-originals')
    const exportedMs = performance.now() - started
    expect(statSync(path).size).toBeLessThan(64 * 1024)
    expect(refs.reduce((total, ref) => total + statSync(join(`${path}.artifacts`, ref.sha256)).size, 0)).toBe(
      100 * chunkSize,
    )
    expect(exportedMs).toBeLessThan(30_000)
    const reading = performance.now()
    const bundle = await readNativeBundle(path, readFileSync(path))
    expect(bundle?.manifest.lastSeq).toBe(events.length)
    for (const ref of refs) expect((await bundle?.readOriginal(ref))?.length).toBe(size)
    expect(performance.now() - reading).toBeLessThan(30_000)
    expect(process.resourceUsage().maxRSS * 1024).toBeLessThan(1024 * 1024 * 1024)
    console.info(
      JSON.stringify({
        dataset: '5-originals-20MiB-v1',
        originalsBytes: 100 * chunkSize,
        ledgerBytes: statSync(path).size,
        exportedMs,
        preflightAndReadMs: performance.now() - reading,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
