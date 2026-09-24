import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { RefStore } from '../src/runner/ref-store.js'

describe('RefStore', () => {
  it('persists node refs and upserts their content hash across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agnes-refs-')), 'refs.sqlite')
    const first = new RefStore(path)
    first.put('k', 'n1', { chatId: 'c', messageId: 'm1', cardBizId: 'card-1' }, 'h1')
    first.put('k', 'n1', { chatId: 'c', messageId: 'm1', cardBizId: 'card-1' }, 'h2')
    first.close()

    const reopened = new RefStore(path)
    expect(reopened.get('k', 'n1')).toEqual({
      ref: { chatId: 'c', messageId: 'm1', cardBizId: 'card-1' },
      contentHash: 'h2',
    })
    expect(reopened.get('k', 'missing')).toBeUndefined()
    expect([...reopened.forSession('k').keys()]).toEqual(['n1'])
    reopened.close()
  })

  it('garbage-collects only refs older than the cutoff', () => {
    let now = 100
    const refs = new RefStore(':memory:', { clock: () => now })
    refs.put('k', 'expired', { chatId: 'c', messageId: 'old' }, 'h-old')
    now = 200
    refs.put('k', 'boundary', { chatId: 'c', messageId: 'edge' }, 'h-edge')
    now = 300
    refs.put('other', 'fresh', { chatId: 'c2', messageId: 'new' }, 'h-new')
    refs.retireSession('k', 'k')

    expect(refs.gc(200)).toBe(0)
    now = 400
    refs.retireSession('k', 'k')
    expect(refs.gc(399)).toBe(0)
    expect(refs.gc(401)).toBe(2)
    expect(refs.get('k', 'expired')).toBeUndefined()
    expect(refs.get('k', 'boundary')).toBeUndefined()
    expect(refs.get('other', 'fresh')).toBeDefined()
    refs.close()
  })

  it('never ages stable refs from an active session out of the store', () => {
    let now = 1
    const refs = new RefStore(':memory:', { clock: () => now })
    refs.put('route', 'stable', { chatId: 'c', messageId: 'm' }, 'hash', 'active')
    now = 1_000_000
    expect(refs.gc(now)).toBe(0)
    expect(refs.get('route', 'stable', 'active')).toBeDefined()
    refs.close()
  })

  it('migrates the legacy refs table transactionally and removes it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agnes-legacy-refs-')), 'refs.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE refs (
      session_key TEXT NOT NULL, node_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, card_biz_id TEXT, content_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (session_key, node_id)
    )`)
    legacy
      .prepare('INSERT INTO refs VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('route', 'node', 'chat', 'message', 'card', 'hash', 10)
    legacy.close()

    const refs = new RefStore(path)
    expect(refs.get('route', 'node')).toEqual({
      ref: { chatId: 'chat', messageId: 'message', cardBizId: 'card' },
      contentHash: 'hash',
    })
    refs.close()
    const inspect = new DatabaseSync(path)
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'refs'").get()).toBeUndefined()
    inspect.close()
  })

  it('does not invent cardBizId when the adapter returned none', () => {
    const refs = new RefStore(':memory:')
    refs.put('k', 'n', { chatId: 'c', messageId: 'm' }, 'h')
    expect(refs.get('k', 'n')).toEqual({
      ref: { chatId: 'c', messageId: 'm' },
      contentHash: 'h',
    })
    refs.close()
  })

  it('isolates identical node ids by the actual daemon session identity', () => {
    const refs = new RefStore(':memory:')
    refs.put('route', 'same-node', { chatId: 'c', messageId: 'old' }, 'same-hash', 'session-old')
    refs.put('route', 'same-node', { chatId: 'c', messageId: 'new' }, 'different-hash', 'session-new')

    expect(refs.get('route', 'same-node', 'session-old')?.ref.messageId).toBe('old')
    expect(refs.get('route', 'same-node', 'session-new')).toMatchObject({
      ref: { messageId: 'new' },
      contentHash: 'different-hash',
    })
    expect(refs.get('route', 'same-node')).toBeUndefined()
    refs.close()
  })
})
