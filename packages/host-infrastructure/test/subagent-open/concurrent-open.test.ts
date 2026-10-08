import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultIds,
  type EventInput,
  type OpenLogOptions,
  SessionLogImpl,
  type StorageAdapter,
} from '@agnes/core'
import { expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const note = (n: number): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text: `n${n}` }] },
})
const options = (storage: StorageAdapter, writerRunId: string): OpenLogOptions => ({
  storage,
  key: 'k',
  writerRunId,
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => Date.parse('2026-09-24T00:00:00.000Z'),
  timers: { setTimeout: () => 0, clearTimeout: () => undefined },
})

// Opening yields between integrity pages, which widens the window in which a second writer can try
// the same key. The lease is taken before the first page, so that writer is refused, not admitted.
it('a second writer arriving while the first is still verifying is refused (SQLite)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-concurrent-open-'))
  const storage = createSqliteStorage({
    file: join(dir, 'sessions.db'),
    tablesDir: join(dir, 'tables'),
    clock: () => Date.parse('2026-09-24T00:00:00.000Z'),
  })
  try {
    const seed = await SessionLogImpl.open(options(storage, 'seed'))
    for (let i = 0; i < 1_234; i += 200)
      await seed.append(Array.from({ length: Math.min(200, 1_234 - i) }, (_, j) => note(i + j)))
    await seed.close()

    let hold!: () => void
    const held = new Promise<void>((resolve) => {
      hold = resolve
    })
    let pages = 0
    let reached!: () => void
    const atSecondPage = new Promise<void>((resolve) => {
      reached = resolve
    })
    const slow: StorageAdapter = Object.create(storage, {
      scanIntegrity: {
        value: async (...args: Parameters<StorageAdapter['scanIntegrity']>) => {
          if (++pages === 2) {
            reached()
            await held
          }
          return storage.scanIntegrity(...args)
        },
      },
    })
    const first = SessionLogImpl.open(options(slow, 'first'))
    await atSecondPage
    await expect(SessionLogImpl.open(options(storage, 'second'))).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    hold()
    const log = await first
    await log.append([note(9_999)])
    expect((await storage.scan('k', { fromSeq: 1_235, toSeq: 1_236, limit: 2 })).map((e) => e.seq)).toEqual([
      1_235,
    ])
    await log.close()
  } finally {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
