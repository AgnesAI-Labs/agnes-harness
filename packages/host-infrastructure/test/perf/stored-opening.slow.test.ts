import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultIds, SessionLogImpl } from '@agnes/core'
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
      expect(view.lastSeq).toBe(5100)
    }
    const started = performance.now()
    const verified = await SessionLogImpl.open(options())
    expect(verified.lastSeq).toBe(5100)
    await verified.close()
    console.info(
      JSON.stringify({
        dataset: '5100-messages-100MiB-v1',
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
