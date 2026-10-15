import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultIds, SessionLogImpl } from '@agnes/core'
import { attachmentLink } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { readSessionView } from '../../../host/src/runtime/sessions/session-view.js'
import { ev } from '../../../host/test/adapters/events.js'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

// Central heavy gate only: fixed synthetic history, no model, subprocess, real home or credentials.
// 5,000 ordinary messages plus 100 x 1 MiB text rows exercise bounded SQLite transfer independently
// of the attachment provider. Artifact originals have their separate native-bundle contract tests.
it('previews and fully verifies the same 100 MiB history without carrying originals into the preview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-stored-opening-bench-'))
  const file = join(dir, 'sessions.db')
  let storage = createSqliteStorage({ file })
  const options = () => ({
    storage,
    key: 'synthetic-history',
    writerRunId: 'bench',
    ttlMs: 600_000,
    ids: defaultIds(),
    clock: () => 0,
    timers: { setTimeout: () => 0, clearTimeout() {} },
  })
  try {
    const log = await SessionLogImpl.open(options())
    const text = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 100; index++)
      await log.append([ev('user/message', { content: [{ type: 'text', text }] })])
    for (let page = 0; page < 10; page++)
      await log.append(
        Array.from({ length: 500 }, (_, index) =>
          ev('user/message', {
            content: [{ type: 'text', text: `synthetic message ${page * 500 + index}` }],
          }),
        ),
      )
    // Originals live outside the log. The same preview/verification gate must retain references
    // while never reading 100 MiB of original payload into the opening projection.
    for (let index = 0; index < 5; index++) {
      const chunk = Buffer.alloc(1024 * 1024, index + 1)
      const digest = createHash('sha256')
      const original = join(dir, `original-${index}.bin`)
      for (let part = 0; part < 20; part++) {
        appendFileSync(original, chunk)
        digest.update(chunk)
      }
      await log.append([
        ev('user/message', {
          content: [
            attachmentLink(
              { sha256: digest.digest('hex'), size: 20 * 1024 * 1024, mime: 'application/octet-stream' },
              `original-${index}.bin`,
            ),
          ],
        }),
      ])
    }
    await log.close()
    await storage.close()
    expect(statSync(file).size).toBeGreaterThan(100 * 1024 * 1024)
    storage = createSqliteStorage({ file })
    const samples: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      const view = await readSessionView((key, query) => storage.scanLean(key, query), 'synthetic-history', {
        maxNodes: 200,
        budget: { events: 2000, bytes: 8 * 1024 * 1024, timeMs: 750 },
      })
      samples.push(performance.now() - started)
      expect(view.readOnly).toBe(true)
      expect(view.timeline.opState).toBeNull()
      expect(JSON.stringify(view).length).toBeLessThan(8 * 1024 * 1024)
      expect(view.lastSeq).toBe(5105)
    }
    expect(Math.max(...samples)).toBeLessThan(1000)
    const started = performance.now()
    const verified = await SessionLogImpl.open(options())
    expect(verified.lastSeq).toBe(5105)
    await verified.close()
    expect(performance.now() - started).toBeLessThan(15_000)
    expect(process.resourceUsage().maxRSS * 1024).toBeLessThan(1024 * 1024 * 1024)
    console.info(
      JSON.stringify({
        dataset: '5105-messages-100MiB-text-100MiB-originals-v2',
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        storedBytes: statSync(file).size,
        freshReaderMs: samples[0],
        warmMs: samples.slice(1),
        fullyVerifiedMs: performance.now() - started,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        previewTargetMs: 1000,
      }),
    )
  } finally {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
