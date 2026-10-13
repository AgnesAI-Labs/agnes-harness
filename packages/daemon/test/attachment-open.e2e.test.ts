import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildByReferenceSession, buildLegacySession } from './attachment-open/build.js'
import { measureColdLoad, measureUpload } from './attachment-open/measure.js'

type Budget = {
  enforce: boolean
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
  // Sessions written by older builds (inline attachments) are not gated: this case is measured and
  // written into the bench output, and only checks that the session opens.
  it('records the legacy session with a 95 MiB-base64 zip attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-open-zip-'))
    dirs.push(dir)
    await buildLegacySession(dir, { attachmentMB: 95, kind: 'zip', queuedBehind: 2, prefixTurns: 20 })
    const r = await measureColdLoad(dir)
    results.legacyZip = r
    expect(r.records).toContainEqual(
      expect.objectContaining({
        kind: 'session.open',
        detail: expect.objectContaining({ outcome: 'ok', lastSeq: expect.any(Number) }),
      }),
    )
  }, 600_000)

  it('records the 90 MiB-base64 image control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-open-img-'))
    dirs.push(dir)
    await buildLegacySession(dir, { attachmentMB: 90, kind: 'images', queuedBehind: 0, prefixTurns: 20 })
    const r = await measureColdLoad(dir)
    results.legacyImages = r
    expect(r.records.map((row) => (row as { kind: string }).kind)).toContain('session.open')
  }, 600_000)

  it('opens a session whose 95 MB zip was uploaded by reference within budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-open-ref-'))
    dirs.push(dir)
    const before = await buildByReferenceSession(dir, { attachmentMB: 95, prefixTurns: 20 })
    const r = await measureColdLoad(dir)
    results.byReference = { ...r, dbGrowthBytes: r.dbBytes - before.dbBytes }
    expect(r.maxRowBytes).toBeLessThanOrEqual(budget.byReference.maxRowBytes)
    expect(r.dbBytes - before.dbBytes).toBeLessThan(budget.byReference.dbGrowthBytes)
    if (enforce) expect(r.loadMs).toBeLessThanOrEqual(budget.byReference.loadMs)
  }, 600_000)

  it('uploads 100 MB end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-upload-'))
    dirs.push(dir)
    const r = await measureUpload(dir, 100)
    results.upload100Mb = r
    if (enforce) expect(r.ms).toBeLessThanOrEqual(budget.upload100MbMs)
  }, 600_000)
})
