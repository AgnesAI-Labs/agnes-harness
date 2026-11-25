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
  rebuildMemoryIndex,
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
function fixture(validity?: MemoryValidityView, userValidity = validity, clock = Date.now) {
  const home = mkdtempSync(join(tmpdir(), 'recall-'))
  clean.push(() => rmSync(home, { force: true, recursive: true }))
  const pipeline = createDefaultPipeline()
  registerRetrieval(pipeline)
  const session = openMemory({
    home,
    workspaceRoot: home,
    sessionKey: 'test',
    pipeline,
    clock,
    ...(validity ? { validity } : {}),
    ...(userValidity ? { userValidity } : {}),
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
  return { home, session, port, recall, root, userRoot, meta, store, internal, pipeline }
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
    valid = true
    await expect(f.port(1).replaceExact!(path, 'Retained observatory', 'Reactivated')).rejects.toMatchObject({
      code: 'MEMORY_REPLACE_NOT_FOUND',
    })
    await f.port(1).replaceExact?.(path, 'Visible lighthouse', 'Visible beacon')
    expect(readFileSync(path, 'utf8')).toBe(original.replace('Visible lighthouse', 'Visible beacon'))
  })

  it('requires both user flags, filters user validity and bounds bytes and count', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto', userEnabled: true })
    expect((await f.recall(0, 'astronomy', { includeUser: true })).hits).toEqual([])
    expect(existsSync(join(f.userRoot, 'meta', 'index.sqlite'))).toBe(false)
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

  it('reads clean and stale turns while another writer holds the derived index lock', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto' })
    const path = join(f.root, 'topic.md')
    await f.port(0).write(path, 'green mountain')
    await f.session.snapshot(1)
    const db = new DatabaseSync(f.meta.pathOf('index.sqlite'))
    try {
      db.exec('BEGIN IMMEDIATE')
      expect((await f.recall(1, 'green')).hits).toHaveLength(1)
      await f.session.editFile('topic.md', 'blue lake', (await f.session.readFile('topic.md')).hash)
      expect((await f.recall(1, 'green')).hits).toHaveLength(1)
      expect((await f.recall(1, 'lake')).hits).toEqual([])
    } finally {
      db.close()
    }
    expect((await f.recall(2, 'lake')).hits).toHaveLength(1)
  })

  it('answers the pinned query when another connection publishes after the initial view check', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto' })
    const path = join(f.root, 'topic.md')
    await f.port(0).write(path, 'Old mountain')
    const pinned = f.store.files()
    const docsFor = (files: typeof pinned) =>
      readDocuments(
        files,
        new Map(files.map((entry) => [entry.path, buildView(entry, [], 'read')])),
        f.store.configuration(),
      )
    const writer = new SearchIndex(f.meta)
    clean.push(() => writer.close())
    const hits = f.internal.query('mountain', pinned, docsFor(pinned), () => {
      const live = docsFor(f.store.files())
      // Finish the competing publication after taking the initial live snapshot.
      if (live[0]?.file.hash === pinned[0]?.hash) {
        writeFileSync(path, 'New lake')
        writer.committed(docsFor(f.store.files()))
      }
      return live
    })
    expect(hits).toMatchObject([{ text: 'Old mountain' }])
    expect(writer.inspectIndexedChunks()).toMatchObject([{ text: 'New lake' }])
  })

  it.each(['workspace', 'user'] as const)(
    'keeps a renewed %s paragraph in the shared index',
    async (layer) => {
      let valid = false
      const registry: MemoryValidityView = {
        revision: () => String(valid),
        validity: () => (valid ? 'valid' : 'expired'),
      }
      const f = fixture(registry)
      await f.session.configure({ mode: 'auto', userEnabled: true })
      const root = layer === 'user' ? f.userRoot : f.root
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, 'MEMORY.md'),
        '<!-- refinement:r0000000001 -->\nKestrel\n<!-- /refinement:r0000000001 -->',
      )
      await f.session.snapshot(1)
      valid = true
      const renewed = openMemory({
        home: f.home,
        workspaceRoot: f.home,
        sessionKey: 'renewed',
        validity: registry,
        userValidity: registry,
      })
      clean.push(() => renewed.close?.())
      const options = { includeUser: true }
      const port = renewed.files(
        fallback,
        { sessionKey: 'renewed', turn: 1 },
        new AbortController().signal,
        outside,
      )
      expect((await port.recall?.({ query: 'kestrel', ...options }))?.hits).toMatchObject([{ layer }])
      using db = new DatabaseSync(join(root, 'meta', 'index.sqlite'))
      db.exec('BEGIN IMMEDIATE')
      expect((await f.recall(1, 'kestrel', options)).hits).toEqual([])
      db.exec('COMMIT')
      expect((await f.recall(1, 'kestrel', options)).hits).toEqual([])
      expect(db.prepare("SELECT text FROM chunks WHERE text LIKE '%Kestrel%'").all()).toHaveLength(1)
    },
  )

  it('withdraws user citations and advances deadlines across both layers during a turn', async () => {
    let now = Date.parse('2027-01-01T00:00:00Z')
    let cited = true
    const f = fixture(
      undefined,
      {
        revision: () => String(cited),
        validity: (id) => (id === 'r0000000001' || (cited && id === 'r0000000002') ? 'valid' : 'expired'),
      },
      () => now,
    )
    await f.session.configure({ mode: 'auto', userEnabled: true })
    mkdirSync(f.userRoot, { recursive: true })
    writeFileSync(
      join(f.userRoot, 'MEMORY.md'),
      [
        '<!-- refinement:r0000000001 -->\nManaged lesson\n\n<!-- expires_at: 2027-01-01T00:00:04Z -->\nHeron\n<!-- /refinement:r0000000001 -->',
        '<!-- refinement:r0000000003 -->\nUnverified lesson\n<!-- /refinement:r0000000003 -->',
        'Handwritten preference',
        'Kestrel citation <!-- ref:r0000000002 -->',
        '<!-- expires_at: tomorrow -->\nInvaliddeadline',
        '<!-- expires_at: 2027-01-01T00:00:01Z -->\nPeacock',
        '<!-- expires_at: 2027-01-01T00:00:03Z -->\nWagtail',
      ].join('\n\n'),
    )
    writeFileSync(join(f.root, 'MEMORY.md'), '<!-- expires_at: 2027-01-01T00:00:02Z -->\nPelican')
    const recall = async (query: string) => (await f.recall(1, query, { includeUser: true })).hits
    const first = await f.session.snapshot(1)
    expect(first?.content).toContain('Kestrel citation')
    expect(first?.content).not.toContain('Invaliddeadline')
    expect(await recall('kestrel')).toMatchObject([{ layer: 'user' }])
    expect(await recall('invaliddeadline')).toEqual([])
    cited = false
    expect(await recall('kestrel')).toEqual([])
    expect(await recall('peacock')).toHaveLength(1)
    now += 1000
    expect(await recall('peacock')).toEqual([])
    expect(await recall('pelican')).toHaveLength(1)
    now += 1000
    expect(await recall('pelican')).toEqual([])
    expect(await recall('wagtail')).toHaveLength(1)
    now += 1000
    expect(await recall('wagtail')).toEqual([])
    const next = await f.session.snapshot(2)
    expect(next?.content).not.toMatch(/Kestrel|Peacock|Wagtail|Invaliddeadline|Unverified lesson/u)
    expect(next?.content).toMatch(
      /Handwritten preference[\s\S]*Managed lesson[\s\S]*Heron\n\n\[1 task-experience paragraphs omitted/u,
    )
    expect(next?.revision).not.toBe(first?.revision)
    now += 1000
    const last = await f.session.snapshot(3)
    expect(last?.content).not.toContain('Heron')
    expect(last?.content).toContain('Managed lesson')
    expect(last?.revision).not.toBe(next?.revision)
  })

  it('omits outdated, empty and deleted topic summaries from eager, rebuilt and turn indexes', async () => {
    const f = fixture()
    await f.session.configure({ mode: 'auto' })
    const topic = join(f.root, 'deploy.md')
    const index = join(f.root, 'MEMORY.md')
    const monday = 'Deploy Monday. [[deploy.md]]'
    const thursday = 'Deploy Thursday. [[deploy.md]]'
    await f.port(0).write(topic, 'Original schedule')
    await f.port(0).write(index, monday + '\nIndependent note')
    expect((await f.recall(1, 'monday')).hits).toHaveLength(1)
    await f.port(1).write(topic, 'New schedule')
    expect(f.internal.queryIndex('monday')).toEqual([])
    await rebuildMemoryIndex(f.session)
    expect(f.internal.queryIndex('monday')).toEqual([])
    expect((await f.recall(2, 'monday')).hits).toEqual([])
    expect((await f.recall(2, 'independent')).hits).toMatchObject([{ lineStart: 2, lineEnd: 2 }])
    expect(await inspectMemoryConsistency(f.session, 2)).toMatchObject({ consistent: true })
    await f.port(2).replaceExact!(index, monday, thursday)
    expect((await f.recall(3, 'thursday')).hits).toMatchObject([{ text: expect.stringContaining(thursday) }])
    expect((await f.recall(3, 'monday')).hits).toEqual([])
    await f.port(3).write(topic, '')
    expect((await f.recall(3, 'thursday')).hits).toEqual([])
    rmSync(topic)
    expect((await f.recall(4, 'thursday')).hits).toEqual([])
    expect(Buffer.from(await f.port(4).read(index)).toString()).toContain(
      thursday + '\n[Summary of deploy.md removed: topic no longer exists]',
    )
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
    await fresh.port(1).write(join(fresh.root, 'topic.md'), 'Example survives corruption')
    expect(readFileSync(fresh.meta.pathOf('audit.jsonl'), 'utf8')).toContain('"action":"commit"')
    await expect(rebuildMemoryIndex(fresh.session)).resolves.toEqual({ indexedEntries: 1 })
    expect((await fresh.recall(2, 'example')).hits).toHaveLength(1)
    rmSync(fresh.meta.pathOf('index.sqlite'))
    expect((await fresh.recall(3, 'example')).hits).toHaveLength(1)
    const schema = new DatabaseSync(fresh.meta.pathOf('index.sqlite'))
    try {
      schema.exec('ALTER TABLE meta RENAME COLUMN key TO broken')
    } finally {
      schema.close()
    }
    await expect(rebuildMemoryIndex(fresh.session)).resolves.toEqual({ indexedEntries: 1 })
    expect((await fresh.recall(4, 'example')).hits).toHaveLength(1)
  })

  it('splits long headings and paragraphs without splitting a Unicode code point', () => {
    const entry = file('topic.md', '# title\n' + 'a'.repeat(599) + '🐕end\n\nnext')
    const chunks = chunkView(entry, buildView(entry, [], 'read'))
    expect(chunks.map((chunk) => chunk.text)).toEqual(['# title', 'a'.repeat(599), '🐕end', 'next'])
    expect(chunks.map((chunk) => chunk.lineStart)).toEqual([1, 2, 2, 4])
  })
})
