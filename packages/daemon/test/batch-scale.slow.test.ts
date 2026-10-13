import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { batchHarness } from './batch-fakes.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-scale-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('takes 352 camera-sized images (over 1 GB, sparse) without reading their bytes', async () => {
  mkdirSync(join(root, 'lab'))
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 0; i < 352; i++) {
    const path = join(root, 'lab', `img-${String(i).padStart(4, '0')}.png`)
    writeFileSync(path, magic)
    truncateSync(path, 3 * 1024 * 1024)
  }
  const before = process.memoryUsage().rss
  const h = batchHarness({ root, model: () => ({ reply: '{"pests":0}' }) })
  const started = Date.now()
  await h.engine.begin({
    batchId: 'b0000000000a1',
    principalId: 'p',
    root,
    cwd: root,
    spec: { dir: 'lab', prompt: 'x', schema: { type: 'object' }, concurrency: 8 },
  })
  const enumerated = Date.now() - started
  const status = await h.run('b0000000000a1')
  const total = Date.now() - started
  expect(status.counts).toMatchObject({ total: 352, done: 352 })
  expect(
    readFileSync(join(root, 'agh-batch', 'b0000000000a1', 'results.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(352)
  const grown = process.memoryUsage().rss - before
  // A loose bound: most of the growth is the fake sessions' in-memory ledgers, not the engine.
  expect(grown).toBeLessThan(512 * 1024 * 1024)
  expect(enumerated).toBeLessThan(10_000)
  await vi.waitFor(() => expect(h.sessions.registry.keys()).toEqual([]))
  process.stdout.write(
    `batch scale: 352 images enumerated in ${enumerated} ms, finished in ${total} ms, rss +${Math.round(grown / 1024 / 1024)} MiB\n`,
  )
}, 300_000)

it('finishes three thousand small text items in order with bounded memory', async () => {
  mkdirSync(join(root, 'notes'))
  for (let i = 0; i < 3000; i++)
    writeFileSync(join(root, 'notes', `n${String(i).padStart(5, '0')}.txt`), `note ${i}`)
  const before = process.memoryUsage().rss
  const started = Date.now()
  const h = batchHarness({ root, model: (prompt) => ({ reply: /Item (\d+)/u.exec(prompt)?.[1] ?? '?' }) })
  await h.engine.begin({
    batchId: 'b0000000000a2',
    principalId: 'p',
    root,
    cwd: root,
    spec: { dir: 'notes', prompt: 'x', concurrency: 8 },
  })
  const status = await h.run('b0000000000a2', { rounds: 20_000 })
  const total = Date.now() - started
  expect(status.counts).toMatchObject({ total: 3000, done: 3000 })
  expect(status.spentCredits).toBeCloseTo(300, 6)
  const ordinals = readFileSync(join(root, 'agh-batch', 'b0000000000a2', 'results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { ordinal: number; output: { text: string } })
  expect(
    ordinals.every((row, index) => row.ordinal === index + 1 && row.output.text === String(index + 1)),
  ).toBe(true)
  expect(h.sessions.counters.maxRunning).toBeLessThanOrEqual(8)
  expect(h.sessions.counters.turns).toBe(3000)
  await vi.waitFor(() => expect(h.sessions.registry.keys()).toEqual([]))
  expect(new Set(h.sessions.released).size).toBe(3000)
  const grown = process.memoryUsage().rss - before
  // A loose bound: most of the growth is the fake sessions' in-memory ledgers, not the engine.
  expect(grown).toBeLessThan(512 * 1024 * 1024)
  process.stdout.write(
    `batch scale: 3000 text items finished in ${total} ms, rss +${Math.round(grown / 1024 / 1024)} MiB\n`,
  )
}, 600_000)
