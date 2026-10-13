import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CoreError, defaultIds, SessionLogImpl } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { ev } from './events.js'

const sha = 'c'.repeat(64)
const textMessage = () => ev('user/message', { content: [{ type: 'text', text: 'hello' }] })
const refMessage = () =>
  ev('user/message', {
    content: [
      { type: 'text', text: 'see attached' },
      { type: 'file', mimeType: 'application/zip', name: 'a.zip', attachment: { sha256: sha, bytes: 99 } },
    ],
  })

describe('ledger format version', () => {
  let dir: string
  let file: string
  let storage: SqliteStorage
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-format-'))
    file = join(dir, 'sessions.db')
    storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  })
  afterEach(async () => {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const openLog = (key: string, writerRunId: string) =>
    SessionLogImpl.open({
      storage,
      key,
      writerRunId,
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
  const read = <T>(sql: string, ...args: Array<string | number>): T => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db.prepare(sql).get(...args) as T
    } finally {
      db.close()
    }
  }
  const formatVersion = (key: string) =>
    read<{ format_version: number } | undefined>(
      'SELECT format_version FROM sessions WHERE session_key = ?',
      key,
    )?.format_version

  it('keeps format 1 for a session that holds only inline content', async () => {
    const log = await openLog('k', 'w1')
    await log.append([textMessage()])
    await log.close()
    expect(formatVersion('k')).toBe(1)
  })

  it('moves to format 2 in the batch that first writes a reference block', async () => {
    const log = await openLog('k', 'w1')
    await log.append([textMessage()])
    await log.append([refMessage()])
    await log.close()
    expect(formatVersion('k')).toBe(2)
    const opened = await storage.open('k', { writerRunId: 'probe', ttlMs: 60_000 })
    expect(opened.formatVersion).toBe(2)
    await storage.release('k', 'probe')
    // A later inline-only batch never lowers it.
    const again = await openLog('k', 'w2')
    await again.append([textMessage()])
    await again.close()
    expect(formatVersion('k')).toBe(2)
  })

  it('moves to format 2 when a queued input carries a reference block', async () => {
    const log = await openLog('k', 'w1')
    const file = refMessage().data as { content: unknown[] }
    await log.append([
      ev(
        'inbox',
        {
          items: [
            {
              itemId: 'q1',
              target: 'next-turn',
              content: file.content,
              actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
              enqueuedAt: '2026-10-13T00:00:00.000Z',
            },
          ],
        },
        { register: 'inbox', origin: 'system' },
      ),
    ])
    await log.close()
    expect(formatVersion('k')).toBe(2)
  })

  it('refuses a session written in a newer format and leaves its ledger alone', async () => {
    const log = await openLog('k', 'w1')
    await log.append([refMessage()])
    await log.close()
    const writer = new DatabaseSync(file)
    writer.prepare('UPDATE sessions SET format_version = 3 WHERE session_key = ?').run('k')
    writer.close()
    const before = read<{ n: number; data: string }>(
      "SELECT COUNT(*) AS n, group_concat(data, '|') AS data FROM events WHERE session_key = ?",
      'k',
    )
    const error = await openLog('k', 'w2').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(CoreError)
    expect((error as CoreError).code).toBe('E_FORMAT')
    expect((error as CoreError).message).toContain('newer')
    expect((error as CoreError).detail).toMatchObject({
      sessionKey: 'k',
      formatVersion: 3,
      supported: 2,
      reason: 'newer-ledger-format',
    })
    expect(
      read<{ n: number; data: string }>(
        "SELECT COUNT(*) AS n, group_concat(data, '|') AS data FROM events WHERE session_key = ?",
        'k',
      ),
    ).toEqual(before)
    expect(formatVersion('k')).toBe(3)
    // The refused open let go of its lease: nothing holds the session afterwards.
    expect(read<{ n: number }>('SELECT COUNT(*) AS n FROM writer_claims WHERE session_key = ?', 'k').n).toBe(
      0,
    )
  })

  it('refuses a newer-format session that has a verified checkpoint before reading the checkpoint', async () => {
    const log = await openLog('k', 'w1')
    await log.append([refMessage()])
    await log.append([textMessage()])
    await log.close()
    const checkpoint = await storage.readVerifiedHead('k')
    expect(checkpoint?.throughSeq).toBe(2)
    const writer = new DatabaseSync(file)
    writer.prepare('UPDATE sessions SET format_version = 3 WHERE session_key = ?').run('k')
    writer.close()
    const reads: string[] = []
    const watched: SqliteStorage = Object.create(storage)
    watched.readVerifiedHead = async (key) => {
      reads.push('readVerifiedHead')
      return storage.readVerifiedHead(key)
    }
    watched.integrityDigestAt = async (key, seq) => {
      reads.push('integrityDigestAt')
      return storage.integrityDigestAt(key, seq)
    }
    watched.scanIntegrity = async (key, q) => {
      reads.push('scanIntegrity')
      return storage.scanIntegrity(key, q)
    }
    watched.registers = async (key) => {
      reads.push('registers')
      return storage.registers(key)
    }
    const error = await SessionLogImpl.open({
      storage: watched,
      key: 'k',
      writerRunId: 'w2',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(CoreError)
    expect((error as CoreError).code).toBe('E_FORMAT')
    expect((error as CoreError).detail).toMatchObject({ formatVersion: 3, reason: 'newer-ledger-format' })
    // Neither the checkpoint nor the row it names was read, and the checkpoint is left as it was.
    expect(reads).toEqual([])
    expect(await storage.readVerifiedHead('k')).toEqual(checkpoint)
    expect(read<{ n: number }>('SELECT COUNT(*) AS n FROM writer_claims WHERE session_key = ?', 'k').n).toBe(
      0,
    )
  })

  it('gives a child the format of the parent it branches from', async () => {
    const log = await openLog('parent', 'w1')
    await log.append([refMessage()])
    await log.close()
    await storage.createChild('parent', 1, 'child')
    expect(formatVersion('child')).toBe(2)
    const plain = await openLog('plain', 'w2')
    await plain.append([textMessage()])
    await plain.close()
    await storage.createChild('plain', 1, 'plain-child')
    expect(formatVersion('plain-child')).toBe(1)
  })

  it('gives a delegated child the format of its parent too', async () => {
    const log = await openLog('parent', 'w1')
    await log.append([refMessage()])
    await log.close()
    await storage.ensureRootScope('root', 10_000_000n)
    const created = await storage.createDelegatedChild({
      childKey: 'parent/child',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'parent:main:direct:1',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'abc',
      inputText: 'task',
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws:parent/child',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w1/child',
    })
    expect(created.status).toBe('created')
    expect(formatVersion('parent/child')).toBe(2)
  })

  it('leaves the format alone when the batch that would raise it fails', async () => {
    await storage.open('k', { writerRunId: 'w1', ttlMs: 60_000 })
    // The op cell is written after the rows and the format bump; a value JSON cannot hold fails
    // the transaction there, so both must roll back with it.
    await expect(
      storage.commit('k', {
        events: [refMessage()] as never,
        expectedWriterRunId: 'w1',
        formatVersion: 2,
        opState: { lane: 'main', data: { poison: 1n } as never },
      }),
    ).rejects.toThrow()
    expect(formatVersion('k')).toBe(1)
    expect(read<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_key = ?', 'k').n).toBe(0)
    await storage.release('k', 'w1')
  })
})
