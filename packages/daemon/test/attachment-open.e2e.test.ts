import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildLegacySession } from './attachment-open/build.js'
import { measureColdLoad } from './attachment-open/measure.js'

type Budget = {
  enforce: boolean
  legacyZip: {
    loadMs: number
    workerPeakMb: number
    transferBytes: number
    splitScans: number
    verifyFullMs: number
  }
  byReference: { loadMs: number; maxRowBytes: number; dbGrowthBytes: number }
  upload100MbMs: number
}
const budget = JSON.parse(
  readFileSync(new URL('./attachment-open/budget.json', import.meta.url), 'utf8'),
) as Budget
const enforce =
  (budget.enforce || process.env.AGH_ATTACHMENT_ENFORCE === '1') && process.platform === 'darwin'
const out = process.env.AGH_ATTACHMENT_BENCH_OUT
const results: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
}
const dirs: string[] = []
afterAll(() => {
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('opening a session that carries a large attachment', () => {
  it('opens the legacy session with a 95 MiB-base64 zip attachment within budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-open-zip-'))
    dirs.push(dir)
    await buildLegacySession(dir, { attachmentMB: 95, kind: 'zip', queuedBehind: 2, prefixTurns: 20 })
    const r = await measureColdLoad(dir)
    results.legacyZip = r
    // Always true, with or without enforcement: these do not depend on the machine.
    expect(r.records).toContainEqual(
      expect.objectContaining({
        kind: 'session.open',
        detail: expect.objectContaining({ outcome: 'ok', lastSeq: expect.any(Number) }),
      }),
    )
    // This holds once workers send lean rows across the process boundary; on a build that still
    // sends whole rows, the legacy session's oversized scan pages are split and this fails.
    expect(r.splitScans).toBe(budget.legacyZip.splitScans)
    if (!enforce) return
    expect(r.loadMs).toBeLessThanOrEqual(budget.legacyZip.loadMs)
    expect(r.workerPeakMb ?? 0).toBeLessThanOrEqual(budget.legacyZip.workerPeakMb)
    expect(r.transferBytes).toBeLessThanOrEqual(budget.legacyZip.transferBytes)
    expect(r.verifyFullMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(budget.legacyZip.verifyFullMs)
  }, 600_000)

  it('records the 90 MiB-base64 image control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-open-img-'))
    dirs.push(dir)
    await buildLegacySession(dir, { attachmentMB: 90, kind: 'images', queuedBehind: 0, prefixTurns: 20 })
    const r = await measureColdLoad(dir)
    results.legacyImages = r
    expect(r.records.map((row) => (row as { kind: string }).kind)).toContain('session.open')
  }, 600_000)
})
