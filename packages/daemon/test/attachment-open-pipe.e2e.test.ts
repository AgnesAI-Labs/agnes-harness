import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { measurePipe } from './attachment-open/pipe.js'

const MIB = 1024 * 1024
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// The pipe-only mode of the attachment-open bench: one scan page from a real worker, every row back
// whole, and the bytes that crossed the connection counted. Small here; the bench runs it at 200 MiB.
it('moves one scan page of synthetic rows from a real worker and counts what crossed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-pipe-'))
  dirs.push(dir)
  const result = await measurePipe(dir, { totalMib: 6, rowMib: 2 })
  expect(result.rows).toBe(3)
  expect(result.payloadBytes).toBe(6 * MIB)
  expect(result.frames).toBe(1)
  // The frame carries the rows as JSON, so a little more than the text itself.
  expect(result.receivedBytes).toBeGreaterThanOrEqual(6 * MIB)
  expect(result.receivedBytes).toBeLessThan(6 * MIB + 64 * 1024)
  expect(result.ms).toBeGreaterThan(0)
  expect(result.mibPerSecond).toBeGreaterThan(0)
}, 120_000)
