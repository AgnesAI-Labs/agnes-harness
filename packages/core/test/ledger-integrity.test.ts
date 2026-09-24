import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { LedgerIntegrityFailure, verifyIntegrityRows } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type OpenLogOptions, SessionLogImpl } from '../src/log/session-log.js'
import type { IntegrityRow, StorageAdapter } from '../src/log/storage.js'
import type { Event, EventInput, PreparedEvent } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }

const input = (text: string): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})

const prepared = (id: string, text: string): PreparedEvent => ({
  ...input(text),
  id,
  ts: '2026-09-12T00:00:00.000Z',
})

function options(storage: StorageAdapter, writerRunId = 'writer'): OpenLogOptions {
  return {
    storage,
    key: 'k',
    writerRunId,
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.parse('2026-09-12T00:00:00.000Z'),
    timers,
  }
}

function wrapped(storage: MemoryStorage, over: Partial<StorageAdapter>): StorageAdapter {
  return {
    open: storage.open.bind(storage),
    commit: storage.commit.bind(storage),
    renew: storage.renew.bind(storage),
    release: storage.release.bind(storage),
    scan: storage.scan.bind(storage),
    scanIntegrity: storage.scanIntegrity.bind(storage),
    registers: storage.registers.bind(storage),
    createChild: storage.createChild.bind(storage),
    close: storage.close.bind(storage),
    ...over,
  } as StorageAdapter
}

describe('ledger integrity', () => {
  it('anchors the first new row, chains a batch, and keeps metadata out of public events', async () => {
    const storage = new MemoryStorage()
    const log = await SessionLogImpl.open(options(storage))
    await log.append([input('one'), input('two')])
    await log.close()

    const rows = await storage.scanIntegrity('k', { fromSeq: 1, toSeq: 2, limit: 10 })
    expect(rows.map((row) => row.integrity?.mode)).toEqual(['anchor', 'chain'])
    expect(rows[1]?.integrity?.previousDigest).toBe(rows[0]?.integrity?.digest)
    expect(await storage.scan('k', { toSeq: 2 })).toEqual(rows.map((row) => row.event))
    expect(await SessionLogImpl.open(options(storage, 'reopen'))).toMatchObject({ lastSeq: 2 })
  })

  it('accepts a legacy prefix and anchors the first migrated append without rewriting it', async () => {
    const storage = new MemoryStorage()
    await storage.open('k', { writerRunId: 'old', ttlMs: 60_000 })
    await storage.commit('k', {
      events: [prepared('legacy', 'old')],
      expectedWriterRunId: 'old',
    })
    await storage.release('k', 'old')

    const log = await SessionLogImpl.open(options(storage))
    await log.append([input('new')])
    await log.close()
    const rows = await storage.scanIntegrity('k', { fromSeq: 1, toSeq: 2, limit: 10 })
    expect(rows[0]?.integrity).toBeNull()
    expect(rows[1]?.integrity).toMatchObject({ mode: 'anchor', previousDigest: null })
  })

  it('fails before register materialization when a protected event was changed and releases lease', async () => {
    const storage = new MemoryStorage()
    const log = await SessionLogImpl.open(options(storage))
    await log.append([input('original')])
    await log.close()
    let registerReads = 0
    const corrupt = wrapped(storage, {
      scanIntegrity: async (key, query) =>
        (await storage.scanIntegrity(key, query)).map((row) => ({
          ...row,
          event: { ...row.event, data: { content: [{ type: 'text', text: 'changed' }] } },
        })) as IntegrityRow[],
      registers: async (key) => {
        registerReads++
        return storage.registers(key)
      },
    })
    await expect(SessionLogImpl.open(options(corrupt, 'bad-reader'))).rejects.toMatchObject({
      name: 'LedgerIntegrityFailure',
      code: 'E_LEDGER_INTEGRITY',
    })
    expect(registerReads).toBe(0)

    const reopened = await SessionLogImpl.open(options(storage, 'next-writer'))
    await reopened.close()
  })

  it('rejects a legacy gap written after protected history', async () => {
    const storage = new MemoryStorage()
    const log = await SessionLogImpl.open(options(storage))
    await log.append([input('protected')])
    await log.close()
    await storage.open('k', { writerRunId: 'old-binary', ttlMs: 60_000 })
    await storage.commit('k', {
      events: [prepared('downgrade', 'legacy-after-chain')],
      expectedWriterRunId: 'old-binary',
    })
    await storage.release('k', 'old-binary')

    await expect(SessionLogImpl.open(options(storage, 'upgrade'))).rejects.toThrow(
      /legacy row follows protected history/,
    )
  })

  it('rejects sequence gaps and malformed metadata', () => {
    const event = { ...prepared('e', 'x'), seq: 2 } as Event
    expect(() => verifyIntegrityRows([{ sessionKey: 'k', event, integrity: null }])).toThrow(
      LedgerIntegrityFailure,
    )
    expect(() =>
      verifyIntegrityRows([
        {
          sessionKey: 'k',
          event: { ...event, seq: 1 },
          integrity: { mode: 'anchor', previousDigest: null, digest: 'not-a-digest' },
        },
      ]),
    ).toThrow(/malformed ledger digest/)
  })

  it('verifies histories across bounded integrity pages', async () => {
    const storage = new MemoryStorage()
    const log = await SessionLogImpl.open(options(storage))
    await log.append(Array.from({ length: 501 }, (_, index) => input(`event-${index}`)))
    await log.close()
    const reopened = await SessionLogImpl.open(options(storage, 'paged-reader'))
    expect(reopened.lastSeq).toBe(501)
    await reopened.close()
  })
})
