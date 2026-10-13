import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { itemSessionKey } from '../src/batch/spec.js'
import { batchHarness } from './batch-fakes.js'
import { sqliteTables } from './sqlite-tables.js'

const id = 'b00000000c4a5'
const items = 60
const made: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('finishes every item exactly once after the process running the batch is killed twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-crash-'))
  made.push(dir)
  const root = join(dir, 'ws')
  mkdirSync(join(root, 'items'), { recursive: true })
  for (let i = 0; i < items; i++)
    writeFileSync(join(root, 'items', `${String(i).padStart(3, '0')}.txt`), `item ${i}`)
  const database = join(dir, 'state.db')
  const transcripts = join(dir, 'transcripts')
  const settled = (): number[] => {
    if (!existsSync(database)) return []
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      return (
        db
          .prepare("SELECT ordinal FROM batch_items WHERE batch_id = ? AND status = 'done' ORDER BY ordinal")
          .all(id) as Array<{ ordinal: number }>
      ).map((row) => row.ordinal)
    } catch {
      return []
    } finally {
      db.close()
    }
  }
  const ledger = (ordinal: number): EventEnvelope[] => {
    const file = join(transcripts, `${encodeURIComponent(itemSessionKey('default', id, ordinal))}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as EventEnvelope[]) : []
  }
  const count = (ordinal: number, type: string): number =>
    ledger(ordinal).filter((row) => row.type === type).length
  const paid = (ordinal: number): number =>
    ledger(ordinal)
      .filter((row) => row.type === 'cost/ledger')
      .reduce((sum, row) => sum + (row.data as { credits: number }).credits, 0)
  const ordinals = Array.from({ length: items }, (_, i) => i + 1)
  // Items whose last turn started (and paid for its first request) but has not ended.
  const midTurn = (): number[] =>
    ordinals.filter(
      (n) =>
        ledger(n).findLast((row) => row.type === 'turn/start' || row.type === 'turn/end')?.type ===
        'turn/start',
    )
  const runAndKill = async (offsetMs: number, until: number) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/batch-crash-child.ts', import.meta.url)),
        database,
        root,
        transcripts,
        String(offsetMs),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    children.push(child)
    let reported = 0
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      for (const match of chunk.matchAll(/done (\d+)/gu)) reported = Math.max(reported, Number(match[1]))
    })
    // Killed in the middle of a turn, once enough items are settled.
    await vi.waitFor(
      () => {
        expect(reported).toBeGreaterThanOrEqual(until)
        expect(midTurn().length).toBeGreaterThan(0)
      },
      { timeout: 60_000, interval: 5 },
    )
    child.kill('SIGKILL')
    await once(child, 'exit')
    return { done: settled(), interrupted: midTurn() }
  }

  const first = await runAndKill(0, 20)
  expect(first.done.length).toBeLessThan(items)
  // Started again past the lease, as a restarted daemon would be: abandoned active jobs are reclaimed.
  const second = await runAndKill(120_000, first.done.length + 15)
  expect(second.done.length).toBeLessThan(items)
  expect(second.done).toEqual(expect.arrayContaining(first.done))
  const settledLedgers = new Map(second.done.map((ordinal) => [ordinal, ledger(ordinal).length]))

  const h = batchHarness({
    root,
    tables: sqliteTables(database),
    dir: transcripts,
    clock: () => Date.now() + 240_000,
    model: (prompt) => ({ reply: JSON.stringify({ item: /Item (\d+)/u.exec(prompt)?.[1] ?? '?' }) }),
  })
  const status = await h.run(id)
  expect(status.counts).toMatchObject({ total: items, done: items, failed: 0, invalid: 0 })
  const rows = readFileSync(join(root, 'agh-batch', id, 'results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { ordinal: number; output: { item: string }; credits: number })
  expect(rows.map((row) => row.ordinal)).toEqual(ordinals)
  expect(rows.every((row) => row.output.item === String(row.ordinal))).toBe(true)
  expect(
    h.tables
      .table('jobs')
      .all('SELECT idempotency_key FROM jobs WHERE idempotency_key LIKE ?', [`batch:${id}:%`]),
  ).toHaveLength(items)

  // Items settled before a kill never ran again: their ledgers did not grow.
  for (const [ordinal, length] of settledLedgers) expect(ledger(ordinal)).toHaveLength(length)
  // An item interrupted mid-turn ran again from its own job and paid for the lost turn too.
  for (const ordinal of [...first.interrupted, ...second.interrupted]) {
    expect(count(ordinal, 'turn/end')).toBeGreaterThanOrEqual(1)
    expect(paid(ordinal)).toBeGreaterThan(0.1 + 1e-9)
  }
  expect(ordinals.every((n) => count(n, 'turn/end') >= 1 && count(n, 'turn/end') <= 3)).toBe(true)
  // Each item is billed exactly what its own ledger shows, once, and the batch is their sum.
  for (const row of rows) expect(row.credits).toBeCloseTo(paid(row.ordinal), 6)
  expect(status.spentCredits).toBeCloseTo(
    ordinals.reduce((sum, n) => sum + paid(n), 0),
    3,
  )
  process.stdout.write(
    `batch crash: ${first.done.length} done at the first kill (${first.interrupted.length} mid-turn), ${second.done.length} at the second (${second.interrupted.length} mid-turn)\n`,
  )
}, 240_000)
