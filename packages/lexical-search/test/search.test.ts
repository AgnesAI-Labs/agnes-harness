import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  buildQuery,
  ensureIndex,
  fitHits,
  fuse,
  listChunks,
  loadAliases,
  rebuildAll,
  removeDoc,
  search,
  tokenize,
  tokenizerVersion,
  upsertDoc,
} from '../src/index.js'

function document(doc: string, text: string) {
  return { doc, fingerprint: text, chunks: [{ text, lineStart: 1, lineEnd: 1 }] }
}

describe('bilingual lexical retrieval', () => {
  it('normalizes identifiers and preserves word and overlapping Han boundaries', () => {
    expect(tokenize('ＰＧ部署集群!').english).toEqual(['pg'])
    expect(tokenize('上海交通大学').words).toContain('大学')
    expect(tokenize('上海，交通大学').bigrams).toEqual(['上海', '交通', '通大', '大学'])
    expect(tokenizerVersion).toMatch(/^[\da-f]{64}$/)
  })

  it('uses literal terms for arbitrary MATCH input, stemming and CJK bigram fallback', () => {
    using db = new DatabaseSync(':memory:')
    rebuildAll(db, [
      document('english', 'Scheduling PostgreSQL migrations'),
      document('中文', '沿线TS接口使用上海交通大学数据'),
    ])
    expect(search(db, 'schedule PG').map((hit) => hit.doc)).toEqual(['english'])
    expect(search(db, 'typescript').map((hit) => hit.doc)).toEqual(['中文'])
    expect(search(db, '海交').map((hit) => hit.doc)).toEqual(['中文'])
    for (const input of [
      '"',
      '*',
      'NEAR(postgres, 1)',
      'OR NOT AND',
      'body:a + -* ( }',
      'a\0b',
      '\uD800',
      'a OR '.repeat(10000),
    ]) {
      expect(() => search(db, input)).not.toThrow()
    }
    expect(search(db, 'absent" OR * OR missing')).toEqual([])
    expect(buildQuery('continuous integration').en).toContain('"ci"')
    const stopped = buildQuery("How many doctor's appointments did I've been having?")
    for (const drop of ['how', 'many', 's', 'did', 've', 'been', 'having'])
      expect(stopped.en).not.toContain(`"${drop}"`)
    expect(stopped.en).toContain('"doctor"')
    expect(stopped.en).toContain('"appointments"')
  })

  it('loads bidirectional per-root aliases, including phrases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lexical-aliases-'))
    try {
      writeFileSync(join(dir, 'aliases.json'), JSON.stringify({ obs: ['observability', '指标平台'] }))
      for (const word of ['observability', '指标平台'])
        expect(buildQuery(word, loadAliases(dir)).en).toContain('"obs"')
      expect(buildQuery('obs', loadAliases(dir)).en).toContain('"observability"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fuses ranks by reciprocal rank, keeps the best document chunk and fits UTF-8 bytes', () => {
    const ranks = fuse(
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      (key) => key,
    )
    expect(ranks[0]).toEqual({ item: 'b', score: 1 / 61 + 1 / 62 })
    expect(fitHits([{ text: '你😃a' }], 1, 6)).toEqual({ hits: [{ text: '你' }], truncated: true })
    using db = new DatabaseSync(':memory:')
    const doc = document('multi', 'marbles')
    doc.chunks.push({ text: 'green marbles', lineStart: 3, lineEnd: 3 })
    rebuildAll(db, [doc])
    expect(search(db, 'marbles')).toHaveLength(2)
    expect(search(db, 'marbles', { limit: 1 })).toHaveLength(1)
    expect(search(db, 'marbles', { aggregate: true })).toHaveLength(1)
    upsertDoc(db, document('multi', 'new'))
    expect(search(db, 'marbles')).toEqual([])
    removeDoc(db, 'multi')
    expect(listChunks(db)).toEqual([])
  })

  it.each(['tokenizer_version', 'schema'])(
    'rebuilds %s atomically and rolls back an interrupted rewrite',
    (key) => {
      using db = new DatabaseSync(':memory:')
      ensureIndex(db, () => [document('old', 'original')])
      db.prepare("UPDATE meta SET value='old' WHERE key=?").run(key)
      function* interrupted() {
        yield document('half', 'partial')
        throw new Error('interrupted')
      }
      expect(() => ensureIndex(db, interrupted)).toThrow('interrupted')
      expect(listChunks(db).map((chunk) => chunk.doc)).toEqual(['old'])
      expect(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value).toBe('old')
      expect(ensureIndex(db, () => [document('new', 'complete')])).toBe(true)
      expect(listChunks(db).map((chunk) => chunk.doc)).toEqual(['new'])
      expect(ensureIndex(db, interrupted)).toBe(false)
    },
  )
})
