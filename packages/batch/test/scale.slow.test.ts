import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createOwnedStore } from '@agnes/sdk'
import { expect, it } from 'vitest'
import {
  BatchEngine,
  BatchService,
  type Item,
  publishExport,
  Repository,
  renderExport,
} from '../src/index.js'
import { FakeExecutor, id, inputs, reference, spec } from './fakes.js'

it('recovers a 1207-item manifest with bounded pages, memory and consistent CSV/JSONL exports', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-batch-scale-')))
  const file = join(root, 'batch.sqlite')
  let database = new DatabaseSync(file)
  const dispatched: number[] = []
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const open = () => {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    const repo = new Repository(createOwnedStore(database, 'scale'))
    const executor = new FakeExecutor()
    const dispatch = executor.dispatch.bind(executor)
    executor.dispatch = (request) => {
      dispatched.push(request.ordinal)
      return dispatch(request)
    }
    const engine = new BatchEngine(repo, executor)
    const service = new BatchService({
      engine,
      workspaceRoot: root,
      signal: new AbortController().signal,
      artifacts: {
        async put() {
          throw new Error('manifest already captured')
        },
      },
    })
    return { repo, engine, service }
  }
  try {
    let h = open()
    const files = Array.from({ length: 1207 }, (_, n) => {
      const name = `item-${String(n).padStart(5, '0')}.txt`
      return { ...inputs[0]!, name, ...reference(inputs[0]!.digest, 1, name) }
    })
    await h.engine.begin(id, { ...spec, budget: 400, concurrency: 8 }, files)
    while ((await h.repo.status(id)).settled < 512) await h.engine.tick(id)
    const progress = await h.repo.status(id)
    expect(progress.settled).toBeGreaterThanOrEqual(512)
    expect(progress.active).toHaveLength(0)
    const published = await renderExport(h.repo, id, undefined, true)
    expect(published.files['results.jsonl']!.trim().split('\n')).toHaveLength(progress.settled)
    database.close()
    database = new DatabaseSync(file)
    h = open()
    for (let rounds = 0; rounds < 100 && (await h.repo.status(id)).status === 'running'; rounds++) {
      await h.engine.resume(id)
      peak = Math.max(peak, process.memoryUsage().rss)
    }
    expect(await h.repo.status(id)).toMatchObject({
      status: 'completed',
      total: 1207,
      successes: 1207,
      spent: 301.75,
      reserved: 0,
    })
    expect(dispatched).toEqual(Array.from({ length: 1207 }, (_, n) => n + 1))
    const rows: Item[] = []
    for (let offset = 0; offset < 1207; ) {
      const page = await h.service.results(id, offset)
      expect(page.items.length).toBeLessThanOrEqual(3)
      rows.push(...page.items)
      offset = page.nextOffset ?? 1207
    }
    expect(rows.map((row) => row.input.name)).toEqual(files.map((row) => row.name))
    await expect(Promise.resolve().then(() => h.repo.page(id, 0, 1001))).rejects.toMatchObject({
      code: 'E_BATCH_PAGE',
    })
    const bundle = await renderExport(h.repo, id)
    await publishExport(root, 'export', bundle)
    const json = (await readFile(join(root, 'export/results.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ordinal: number; name: string; output: unknown })
    const csv = (await readFile(join(root, 'export/results.csv'), 'utf8')).trim().split('\n')
    expect(json.map((row) => row.ordinal)).toEqual(rows.map((row) => row.ordinal))
    expect(
      json.every(
        (row, n) =>
          row.name === files[n]?.name && JSON.stringify(row.output) === JSON.stringify(rows[n]?.output),
      ),
    ).toBe(true)
    expect(csv).toHaveLength(1208)
    expect(csv.slice(1).map((line) => Number(/^"(\d+)"/u.exec(line)?.[1]))).toEqual(
      json.map((row) => row.ordinal),
    )
    for (const [index, line] of csv.slice(1).entries()) {
      const cells = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/gu)].map((match) =>
        match[1]?.replaceAll('""', '"'),
      )
      const row = json[index]
      expect(cells).toEqual([String(row?.ordinal), row?.name, 'done', JSON.stringify(row?.output)])
    }
    expect(await readFile(join(root, 'export/errors.jsonl'), 'utf8')).toBe('')
    expect(await readFile(join(root, 'export/complete.json'), 'utf8')).toContain(bundle.digest)
    peak = Math.max(peak, process.memoryUsage().rss)
    expect(peak - baseline).toBeLessThan(256 * 1024 * 1024)
    process.stdout.write(
      `batch scale: 1207 rows, peak RSS growth ${Math.ceil((peak - baseline) / 1024 / 1024)} MiB\n`,
    )
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
