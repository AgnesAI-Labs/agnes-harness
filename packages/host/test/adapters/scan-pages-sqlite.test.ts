import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedEvent, ScanQuery } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { SCAN_PAGE_MAX, scanAll, scanPages } from '../../src/index.js'
import { ev } from './events.js'

const range = (from: number, to: number): number[] =>
  from <= to
    ? Array.from({ length: to - from + 1 }, (_, i) => from + i)
    : Array.from({ length: from - to + 1 }, (_, i) => from - i)

describe('scan paging over the SQLite adapter', () => {
  let dir: string
  let s: SqliteStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-scan-pages-'))
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seed(key: string, runId: string, n: number, typeOf: (i: number) => string): Promise<void> {
    const events: PreparedEvent[] = Array.from({ length: n }, (_, i) => ev(typeOf(i), { i }))
    await s.commit(key, { events, expectedWriterRunId: runId })
  }

  it('reads all 1,234 rows where a single scan stops at 500', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    await seed('k', 'r1', 1234, (i) => (i % 3 === 0 ? 'tool/call' : 'assistant/output'))
    const read = (q: ScanQuery) => s.scan('k', q)
    // A single scan past the page size is refused rather than returned cut; paging reads through it.
    await expect(read({ toSeq: 1234 })).rejects.toMatchObject({ code: 'E_SCAN_TRUNCATED' })
    expect(await read({ toSeq: 1234, limit: SCAN_PAGE_MAX })).toHaveLength(SCAN_PAGE_MAX)

    expect((await scanAll(read, { toSeq: 1234 })).map((e) => e.seq)).toEqual(range(1, 1234))
    expect((await scanAll(read, { toSeq: 1234, order: 'desc' })).map((e) => e.seq)).toEqual(range(1234, 1))
    const calls = range(1, 1234).filter((seq) => (seq - 1) % 3 === 0)
    expect((await scanAll(read, { toSeq: 1234, type: 'tool/call' })).map((e) => e.seq)).toEqual(calls)
    const pages: number[] = []
    for await (const page of scanPages(read, { fromSeq: 1 })) pages.push(page.length)
    expect(pages).toEqual([500, 500, 234])
  })

  it('pages a child across the boundary between its parent prefix and its own rows', async () => {
    await s.open('p', { writerRunId: 'r1', ttlMs: 60_000 })
    await seed('p', 'r1', 400, () => 'user/message')
    await s.createChild('p', 400, 'c')
    await s.open('c', { writerRunId: 'r9', ttlMs: 60_000 })
    await seed('c', 'r9', 700, () => 'assistant/output')
    const read = (q: ScanQuery) => s.scan('c', q)

    const asc = await scanAll(read, { toSeq: 1100 })
    expect(asc.map((e) => e.seq)).toEqual(range(1, 1100))
    expect(asc.slice(398, 402).map((e) => e.type)).toEqual([
      'user/message',
      'user/message',
      'assistant/output',
      'assistant/output',
    ])
    expect((await scanAll(read, { toSeq: 1100, order: 'desc' })).map((e) => e.seq)).toEqual(range(1100, 1))
  })
})
