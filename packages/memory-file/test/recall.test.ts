import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryFilePort, MemoryRecallQuery, MemoryValidityView } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import { chunkView } from '../src/chunker.js'
import { file } from '../src/content.js'
import {
  buildView,
  createDefaultPipeline,
  fileMemoryRoots,
  inspectMemoryConsistency,
  MetaStore,
  openMemory,
} from '../src/index.js'
import { registerRetrieval } from '../src/recall.js'
import { readDocuments, SearchIndex } from '../src/search-index.js'
import { MemoryStore } from '../src/store.js'

const clean: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn()
})

const outside = async (): Promise<never> => {
  throw new Error('outside memory')
}
const fallback: MemoryFilePort = { read: outside, list: outside, stat: outside, write: outside }
function fixture(validity?: MemoryValidityView) {
  const home = mkdtempSync(join(tmpdir(), 'recall-'))
  clean.push(() => rmSync(home, { force: true, recursive: true }))
  const pipeline = createDefaultPipeline()
  registerRetrieval(pipeline)
  const session = openMemory({
    home,
    workspaceRoot: home,
    sessionKey: 'test',
    pipeline,
    ...(validity ? { validity, userValidity: validity } : {}),
  })
  clean.push(() => session.close?.())
  const port = (turn: number) =>
    session.files(
      fallback,
      { sessionKey: 'test', turn, toolUseId: 'edit' },
      new AbortController().signal,
      async () => ({ status: 'approved' }),
    )
  const recall = (turn: number, query: string, options: Partial<MemoryRecallQuery> = {}) => {
    const search = port(turn).recall
    if (!search) throw new Error('Missing recall handler')
    return search({ query, ...options })
  }
  const { root, protectedRoot, userRoot } = fileMemoryRoots(home, home)
  const store = new MemoryStore(protectedRoot, root)
  const meta = new MetaStore(store)
  const internal = new SearchIndex(meta)
  clean.push(() => internal.close())
  return { session, port, recall, root, userRoot, meta, store, internal, pipeline }
}

describe('file memory recall', () => {
  it('indexes commits immediately while keeping the old turn and removing deleted files', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto' })
    const path = join(f.root, 'topic.md')
    expect((await f.recall(1, 'kestrel')).hits).toEqual([])
    await f.port(1).write(path, 'Kestrel habitat')
    expect(f.internal.queryIndex('kestrel')).toHaveLength(1)
    expect((await f.recall(1, 'kestrel')).hits).toEqual([])
    expect(f.internal.queryIndex('kestrel')).toHaveLength(1)
    expect((await f.recall(2, 'habitat')).hits).toHaveLength(1)
    await f.port(2).write(path, '雪山气象观测站')
    expect(f.internal.queryIndex('habitat')).toEqual([])
    expect(f.internal.queryIndex('气象')).toHaveLength(1)
    expect((await f.recall(2, '气象')).hits).toEqual([])
    expect((await f.recall(2, 'habitat')).hits).toHaveLength(1)
    expect((await f.recall(3, '气象')).hits).toHaveLength(1)
    rmSync(path)
    expect((await f.recall(3, '气象')).hits).toEqual([])
    expect(f.internal.inspectIndexedChunks()).toEqual([])
    await f.port(4).write(path, 'Restored habitat')
    await f.port(5).write(path, '')
    expect(f.internal.queryIndex('habitat')).toEqual([])
    expect((await f.recall(5, 'habitat')).hits).toEqual([])
  })

  it('maps visible paragraphs to original lines, preserves hidden bytes on edit and withdraws immediately', async () => {
    let valid = true
    const f = fixture({ revision: () => String(valid), validity: () => (valid ? 'valid' : 'expired') })
    await f.session.configure({ mode: 'auto' })
    const hidden = 'private kestrel line\nkeep  both spaces'
    f.pipeline.addViewFilter((entry) => {
      const start = entry.content.indexOf(hidden)
      return start < 0
        ? []
        : [
            {
              start,
              end: start + hidden.length,
              appliesTo: 'both',
              reason: 'private',
              notice: 'syntheticwonder',
            },
          ]
    })
    const path = join(f.root, 'MEMORY.md')
    const managed = '<!-- refinement:r0000000001 -->\nRetained observatory\n<!-- /refinement:r0000000001 -->'
    await f.port(0).write(path, '# Notes\n\n' + hidden + '\n\nVisible lighthouse\nsecond line')
    const para = f.session.paragraphs!({ sessionKey: 'test', turn: 0 }, new AbortController().signal)
    await para.commit(await para.propose({ op: 'put', id: 'r0000000001', text: 'Retained observatory' }))
    const original = readFileSync(path, 'utf8')
    expect(original).toBe('# Notes\n\n' + hidden + '\n\nVisible lighthouse\nsecond line\n\n' + managed)
    for (const query of ['kestrel', 'syntheticwonder']) expect((await f.recall(1, query)).hits).toEqual([])
    const found = await f.recall(1, 'lighthouse')
    expect(found.hits).toMatchObject([
      {
        path: 'MEMORY.md',
        layer: 'workspace',
        lineStart: 6,
        lineEnd: 7,
        text: 'Visible lighthouse\nsecond line',
      },
    ])
    expect((await f.recall(1, 'observatory')).hits).toHaveLength(1)
    valid = false
    expect((await f.recall(1, 'observatory')).hits).toEqual([])
    expect(
      f.internal
        .inspectIndexedChunks()
        .map((chunk) => chunk.text)
        .join(' '),
    ).not.toMatch(/kestrel|observatory|syntheticwonder/i)
    await f.port(1).replaceExact?.(path, 'Visible lighthouse', 'Visible beacon')
    expect(readFileSync(path, 'utf8')).toBe(original.replace('Visible lighthouse', 'Visible beacon'))
  })

  it('requires both user flags, filters user validity and bounds bytes and count', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto', userEnabled: true })
    mkdirSync(f.userRoot, { recursive: true })
    writeFileSync(join(f.userRoot, 'Meeting notes.md'), 'Unindexed astronomy')
    writeFileSync(join(f.userRoot, 'archive.md'), 'x'.repeat(1024 * 1024 + 1))
    writeFileSync(
      join(f.userRoot, 'MEMORY.md'),
      '用户天文台\n\n<!-- refinement:r0000000001 -->\nUnverifiedplanet\n<!-- /refinement:r0000000001 -->',
    )
    writeFileSync(
      join(f.root, 'topic.md'),
      Array.from({ length: 40 }, (_, i) => 'Astronomy ' + i).join('\n\n'),
    )
    expect((await f.recall(1, '天文台')).hits).toEqual([])
    expect((await f.recall(1, 'Unverifiedplanet', { includeUser: true })).hits).toEqual([])
    const user = await f.recall(1, '天文台', { includeUser: true, maxBytes: 7 })
    expect(user).toMatchObject({
      truncated: true,
      hits: [{ layer: 'user', path: 'MEMORY.md', text: '用户' }],
    })
    expect((await f.recall(1, 'astronomy')).hits).toHaveLength(8)
    expect((await f.recall(1, 'astronomy', { limit: 100 })).hits).toHaveLength(32)
    await f.session.configure({ userEnabled: false })
    expect((await f.recall(1, '天文台', { includeUser: true })).hits).toEqual([])
    await f.session.configure({ userEnabled: true })
    const userTopic = join(f.userRoot, 'topic.md')
    writeFileSync(userTopic, 'Lunar habitat 1')
    const first = await f.recall(2, 'habitat', { includeUser: true })
    writeFileSync(userTopic, 'Lunar habitat 2')
    const second = await f.recall(3, 'habitat', { includeUser: true })
    expect(second.hits[0]?.text).toBe('Lunar habitat 2')
    expect(second.revision).not.toBe(first.revision)
  })

  it('transactionally repairs a version mismatch in place and releases the WAL on close', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto' })
    const path = f.meta.pathOf('index.sqlite')
    expect(await inspectMemoryConsistency(f.session, 0)).toMatchObject({ consistent: true, indexIds: [] })
    expect(existsSync(path)).toBe(false)
    await f.port(1).write(join(f.root, 'topic.md'), 'green mountain')
    const identity = statSync(path)
    expect(identity.mode & 0o777).toBe(0o600)
    const db = new DatabaseSync(path)
    db.exec("UPDATE meta SET value='outdated' WHERE key='tokenizer_version'")
    db.exec("UPDATE chunks SET text='obsolete'; BEGIN")
    const indexed = () => db.prepare('SELECT text FROM chunks').get()?.text
    expect(indexed()).toBe('obsolete')
    expect((await f.recall(2, 'green')).hits).toMatchObject([{ text: 'green mountain' }])
    expect(indexed()).toBe('obsolete')
    db.exec('COMMIT')
    expect(indexed()).toBe('green mountain')
    expect(statSync(path).ino).toBe(identity.ino)
    const files = f.store.files()
    const views = new Map(files.map((entry) => [entry.path, buildView(entry, [], 'read')]))
    f.internal.rebuildIndex(readDocuments(files, views, f.store.configuration()))
    expect(f.internal.inspectIndexedChunks()).toMatchObject([{ text: 'green mountain' }])
    f.internal.close()
    db.close()
    expect(existsSync(path + '-wal')).toBe(true)
    await f.session.close?.()
    expect(existsSync(path + '-wal')).toBe(false)
  })

  it('refuses disabled memory, unreadable file content and corrupt SQLite', async () => {
    const f = fixture()
    await expect(f.recall(1, 'test')).rejects.toMatchObject({ code: 'MEMORY_DISABLED' })
    await f.session.configure({ mode: 'auto' })
    writeFileSync(join(f.root, 'topic.md'), 'password=abcdefgh example')
    expect((await f.recall(2, 'example')).hits).toEqual([])
    const index = join(f.root, 'MEMORY.md')
    writeFileSync(index, '<!-- expires_at: 2000-01-01 -->\nRetired guidance\n\nVisible guidance')
    mkdirSync(f.userRoot, { recursive: true })
    writeFileSync(join(f.userRoot, 'MEMORY.md'), 'Lunar\nobservation\nnotes')
    await f.session.configure({ indexMaxLines: 2, userEnabled: true })
    expect((await f.session.snapshot(3))?.content).toContain('[User memory omitted:')
    await expect(f.port(3).read(index)).rejects.toMatchObject({ code: 'MEMORY_CONSOLIDATION_REQUIRED' })
    await f.session.configure({ indexMaxLines: 4 })
    rmSync(join(f.root, 'topic.md'))
    expect((await f.recall(3, 'lunar', { includeUser: true })).hits).toEqual([])
    expect((await f.recall(3, 'retired')).hits).toEqual([])
    await expect(f.port(3).read(index)).rejects.toMatchObject({ code: 'MEMORY_CONSOLIDATION_REQUIRED' })
    expect(Buffer.from(await f.port(4).read(index)).toString()).toContain('Visible guidance')
    expect((await f.recall(4, 'lunar', { includeUser: true })).hits).toHaveLength(1)
    const fresh = fixture()
    await fresh.session.configure({ mode: 'auto' })
    fresh.meta.ensureDir()
    writeFileSync(fresh.meta.pathOf('index.sqlite'), 'corrupt')
    await expect(fresh.recall(1, 'example')).rejects.toMatchObject({ code: 'MEMORY_RECALL_UNAVAILABLE' })
  })

  it('splits long headings and paragraphs without splitting a Unicode code point', () => {
    const entry = file('topic.md', '# title\n' + 'a'.repeat(599) + '🐕end\n\nnext')
    const chunks = chunkView(entry, buildView(entry, [], 'read'))
    expect(chunks.map((chunk) => chunk.text)).toEqual(['# title', 'a'.repeat(599), '🐕end', 'next'])
    expect(chunks.map((chunk) => chunk.lineStart)).toEqual([1, 2, 2, 4])
  })
})
