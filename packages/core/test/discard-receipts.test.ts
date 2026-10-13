import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { UserAttachmentPort } from '../src/step/attachment-admission.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

function port(forgetReceipts: UserAttachmentPort['forgetReceipts']): UserAttachmentPort {
  return {
    storeByReference: true,
    isUserAttachment: async () => true,
    read: async () => new Uint8Array(),
    store: async () => ({ sha256: 'a'.repeat(64), bytes: 1 }),
    authorize: async () => 'unauthorized',
    ...(forgetReceipts ? { forgetReceipts } : {}),
  }
}

/** The log calls the storage's discard detached from it, as the SQLite storage allows. */
function storage(): MemoryStorage {
  const memory = new MemoryStorage()
  memory.discardNewSession = memory.discardNewSession.bind(memory)
  return memory
}

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('discarding a new session and its upload receipts', () => {
  it('forgets the receipts of the discarded key', async () => {
    const forget = vi.fn(async () => undefined)
    const { session } = await openSession({
      provider: fakeProvider([]),
      attachments: port(forget),
      key: 'fresh',
      storage: storage(),
    })
    await session.discardNewSession()
    expect(forget).toHaveBeenCalledWith('fresh')
  })

  it('reports a failure to forget them without failing the discard that already happened', async () => {
    const log = logger()
    const opened = await openSession({
      provider: fakeProvider([]),
      storage: storage(),
      attachments: port(async () => {
        throw new Error('marker directory unreadable')
      }),
      key: 'fresh',
      logger: log,
    })
    await expect(opened.session.discardNewSession()).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'upload receipts of a discarded session were not removed',
      expect.objectContaining({ sessionKey: 'fresh', error: 'marker directory unreadable' }),
    )
    // The session itself is gone.
    expect((await opened.storage.open('fresh', { writerRunId: 'later', ttlMs: 1000 })).lastSeq).toBe(0)
  })
})
