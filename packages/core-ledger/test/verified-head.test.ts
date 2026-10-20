import { defaultIds } from '@agnes/core-common/ids'
import type { EventInput } from '@agnes/core-common/types'
import { describe, expect, it } from 'vitest'
import { LEDGER_INTEGRITY_ALGORITHM } from '../src/log/integrity.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type OpenLogOptions, SessionLogImpl } from '../src/log/session-log.js'
import type { StorageAdapter } from '../src/log/storage.js'
import {
  decideCheckpoint,
  makeVerifiedHead,
  type VerifiedHead,
  verifiedHeadDigest,
} from '../src/log/verified-head.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const input = (text: string): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text }] },
})
const options = (storage: StorageAdapter, key = 'k'): OpenLogOptions => ({
  storage,
  key,
  writerRunId: 'w',
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => 0,
  timers,
})

/** A session of `rows` user messages, plus the checkpoint a full verification of it would leave. */
async function seeded(rows: number, key = 'k') {
  const storage = new MemoryStorage()
  const log = await SessionLogImpl.open(options(storage, key))
  for (let i = 0; i < rows; i++) await log.append([input(`m${i}`)])
  await log.close()
  // Closing the log left a checkpoint of its own; these tests start from none and write theirs.
  await storage.deleteVerifiedHead(key)
  const [last] = await storage.scanIntegrity(key, { fromSeq: rows, toSeq: rows, limit: 1 })
  const head = makeVerifiedHead({
    sessionKey: key,
    throughSeq: rows,
    headDigest: last?.integrity?.digest as string,
    legacyThroughSeq: 0,
    algorithm: LEDGER_INTEGRITY_ALGORITHM,
    verifiedFullAtMs: 5,
    writtenAtMs: 6,
  })
  return { storage, head }
}

describe('verifiedHeadDigest', () => {
  const base: Omit<VerifiedHead, 'checkpointDigest' | 'writtenAtMs'> = {
    sessionKey: 'k',
    throughSeq: 10,
    headDigest: 'a'.repeat(64),
    legacyThroughSeq: 2,
    algorithm: LEDGER_INTEGRITY_ALGORITHM,
    verifiedFullAtMs: 7,
  }

  it('is pinned, so a stored checkpoint stays readable across releases', () => {
    // Recomputed outside this package from the same canonical JSON, not copied from its output.
    expect(verifiedHeadDigest(base)).toBe('373ac8f8da91571f9470e0d2ee46c2b26a88bf9015f92ce5a7b5e79715c5c2a6')
    expect(makeVerifiedHead({ ...base, writtenAtMs: 1 }).checkpointDigest).toBe(verifiedHeadDigest(base))
  })

  it('binds every field that says what was verified, and not the write time', () => {
    const digest = verifiedHeadDigest(base)
    for (const change of [
      { sessionKey: 'other' },
      { throughSeq: 11 },
      { headDigest: 'b'.repeat(64) },
      { legacyThroughSeq: 3 },
      { verifiedFullAtMs: 8 },
      { algorithm: 'other' as typeof LEDGER_INTEGRITY_ALGORITHM },
    ])
      expect(verifiedHeadDigest({ ...base, ...change })).not.toBe(digest)
    expect(makeVerifiedHead({ ...base, writtenAtMs: 1 }).checkpointDigest).toBe(
      makeVerifiedHead({ ...base, writtenAtMs: 2 }).checkpointDigest,
    )
  })
})

describe('decideCheckpoint', () => {
  it('uses a checkpoint that is self-consistent, within the head and matches its stored row', async () => {
    const { storage, head } = await seeded(10)
    await storage.writeVerifiedHead(head)
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: true, head })
  })

  it('uses a checkpoint behind the head', async () => {
    const { storage, head } = await seeded(10)
    const [row6] = await storage.scanIntegrity('k', { fromSeq: 6, toSeq: 6, limit: 1 })
    const behind = makeVerifiedHead({
      ...head,
      throughSeq: 6,
      headDigest: row6?.integrity?.digest as string,
    })
    await storage.writeVerifiedHead(behind)
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: true, head: behind })
  })

  it('reports an absent checkpoint, and an adapter that keeps none', async () => {
    const { storage } = await seeded(3)
    expect(await decideCheckpoint(storage, 'k', 3)).toEqual({ use: false, reason: 'absent' })
    const without: StorageAdapter = Object.create(storage, { readVerifiedHead: { value: undefined } })
    expect(await decideCheckpoint(without, 'k', 3)).toEqual({ use: false, reason: 'unsupported' })
    const blind: StorageAdapter = Object.create(storage, { integrityDigestAt: { value: undefined } })
    expect(await decideCheckpoint(blind, 'k', 3)).toEqual({ use: false, reason: 'unsupported' })
  })

  it('refuses a checkpoint that fails its own digest', async () => {
    const { storage, head } = await seeded(10)
    await storage.writeVerifiedHead({ ...head, checkpointDigest: '0'.repeat(64) })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
    // A field edited after the digest was taken is the same failure.
    await storage.writeVerifiedHead({ ...head, verifiedFullAtMs: head.verifiedFullAtMs + 1 }, { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
  })

  it('refuses a self-consistent checkpoint whose shape cannot name a protected row', async () => {
    const { storage, head } = await seeded(10)
    for (const bad of [
      { legacyThroughSeq: 10 },
      { legacyThroughSeq: 11 },
      { legacyThroughSeq: -1 },
      { legacyThroughSeq: 1.5 },
      { headDigest: 'F'.repeat(64) },
      { headDigest: 'a'.repeat(63) },
    ]) {
      await storage.writeVerifiedHead(makeVerifiedHead({ ...head, ...bad }), { force: true })
      expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
    }
  })

  it('refuses a checkpoint that reaches past the stored head', async () => {
    const { storage, head } = await seeded(10)
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, throughSeq: 15 }), { force: true })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'beyond-head' })
    // The same checkpoint is within a longer head, where its row digest then disagrees.
    expect(await decideCheckpoint(storage, 'k', 15)).toEqual({ use: false, reason: 'row-mismatch' })
    // The head can also be shorter than the ledger the checkpoint was taken on.
    await storage.writeVerifiedHead(head, { force: true })
    expect(await decideCheckpoint(storage, 'k', 9)).toEqual({ use: false, reason: 'beyond-head' })
  })

  it('refuses a checkpoint whose digest is not the stored digest of its last row', async () => {
    const { storage, head } = await seeded(10)
    await storage.writeVerifiedHead(makeVerifiedHead({ ...head, headDigest: 'f'.repeat(64) }), {
      force: true,
    })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'row-mismatch' })
    // A real digest of another row is a mismatch too.
    const [other] = await storage.scanIntegrity('k', { fromSeq: 4, toSeq: 4, limit: 1 })
    await storage.writeVerifiedHead(
      makeVerifiedHead({ ...head, headDigest: other?.integrity?.digest as string }),
      { force: true },
    )
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'row-mismatch' })
  })

  it('refuses a checkpoint written under another ledger algorithm', async () => {
    const { storage, head } = await seeded(10)
    await storage.writeVerifiedHead(
      makeVerifiedHead({ ...head, algorithm: 'other' as typeof LEDGER_INTEGRITY_ALGORITHM }),
      { force: true },
    )
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'algorithm' })
  })

  it('never accepts a checkpoint for the wrong session key', async () => {
    const { storage, head } = await seeded(10)
    // A store that answers for the wrong session is treated as having no checkpoint.
    const confused: StorageAdapter = Object.create(storage)
    confused.readVerifiedHead = async () => makeVerifiedHead({ ...head, sessionKey: 'other' })
    expect(await decideCheckpoint(confused, 'k', 10)).toEqual({ use: false, reason: 'absent' })
    // Another session's checkpoint copied under this key: its digest binds the other key.
    const foreign = makeVerifiedHead({ ...head, sessionKey: 'other' })
    await storage.writeVerifiedHead({ ...foreign, sessionKey: 'k' })
    expect(await decideCheckpoint(storage, 'k', 10)).toEqual({ use: false, reason: 'self-check' })
    // A genuine checkpoint of another session whose rows are identical is still not this session's.
    const twin = await seeded(10, 'other')
    await twin.storage.writeVerifiedHead(twin.head)
    expect(await decideCheckpoint(twin.storage, 'k', 10)).toEqual({ use: false, reason: 'absent' })
  })

  it("accepts a child's checkpoint through the parent's rows, and only up to the boundary", async () => {
    const { storage, head } = await seeded(10)
    await storage.createChild('k', 6, 'c')
    const [row6] = await storage.scanIntegrity('k', { fromSeq: 6, toSeq: 6, limit: 1 })
    const childHead = makeVerifiedHead({
      ...head,
      sessionKey: 'c',
      throughSeq: 6,
      headDigest: row6?.integrity?.digest as string,
    })
    await storage.writeVerifiedHead(childHead)
    expect(await decideCheckpoint(storage, 'c', 6)).toEqual({ use: true, head: childHead })
    // The parent's row 7 is past the child's boundary, so the child owns no such row.
    const [row7] = await storage.scanIntegrity('k', { fromSeq: 7, toSeq: 7, limit: 1 })
    await storage.writeVerifiedHead(
      makeVerifiedHead({ ...childHead, throughSeq: 7, headDigest: row7?.integrity?.digest as string }),
      { force: true },
    )
    expect(await decideCheckpoint(storage, 'c', 7)).toEqual({ use: false, reason: 'row-mismatch' })
  })
})

describe('MemoryStorage verified head', () => {
  it('keeps the furthest head unless told to force, and hands out copies', async () => {
    const { storage, head } = await seeded(10)
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
    await storage.writeVerifiedHead(head)
    await storage.writeVerifiedHead({ ...head, throughSeq: 4 })
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(10)
    await storage.writeVerifiedHead({ ...head, throughSeq: 4 }, { force: true })
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(4)
    await storage.writeVerifiedHead({ ...head, throughSeq: 4, writtenAtMs: 99 })
    expect((await storage.readVerifiedHead('k'))?.writtenAtMs).toBe(99)
    const copy = (await storage.readVerifiedHead('k')) as VerifiedHead
    copy.throughSeq = 1
    expect((await storage.readVerifiedHead('k'))?.throughSeq).toBe(4)
    await storage.deleteVerifiedHead('k')
    expect(await storage.readVerifiedHead('k')).toBeUndefined()
  })

  it('keeps a head per session', async () => {
    const storage = new MemoryStorage()
    const base = makeVerifiedHead({
      sessionKey: 'one',
      throughSeq: 3,
      headDigest: 'a'.repeat(64),
      legacyThroughSeq: 0,
      algorithm: LEDGER_INTEGRITY_ALGORITHM,
      verifiedFullAtMs: 0,
      writtenAtMs: 0,
    })
    await storage.writeVerifiedHead(base)
    await storage.writeVerifiedHead({ ...base, sessionKey: 'two', throughSeq: 8 })
    expect((await storage.readVerifiedHead('one'))?.throughSeq).toBe(3)
    expect((await storage.readVerifiedHead('two'))?.throughSeq).toBe(8)
    await storage.deleteVerifiedHead('one')
    expect((await storage.readVerifiedHead('two'))?.throughSeq).toBe(8)
  })

  it('reads one row digest, through the parent for a child, and says why when it cannot', async () => {
    const { storage } = await seeded(5)
    const rows = await storage.scanIntegrity('k', { fromSeq: 1, toSeq: 5, limit: 5 })
    const digest = (seq: number) => rows[seq - 1]?.integrity?.digest
    expect(await storage.integrityDigestAt('k', 3)).toBe(digest(3))
    expect(await storage.integrityDigestAt('k', 6)).toBeUndefined()
    expect(await storage.integrityDigestAt('nobody', 1)).toBeUndefined()
    await storage.createChild('k', 3, 'c')
    expect(await storage.integrityDigestAt('c', 3)).toBe(digest(3))
    expect(await storage.integrityDigestAt('c', 4)).toBeUndefined()
    // A row written without integrity metadata is a legacy row: present, with no digest.
    await storage.open('legacy', { writerRunId: 'r', ttlMs: 1000 })
    await storage.commit('legacy', {
      events: [{ ...input('old'), id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB', ts: '2026-09-07T00:00:00Z' } as never],
      expectedWriterRunId: 'r',
    })
    expect(await storage.integrityDigestAt('legacy', 1)).toBeNull()
  })

  it('drops the head of a discarded new session', async () => {
    const storage = new MemoryStorage()
    await storage.open('n', { writerRunId: 'r', ttlMs: 1000 })
    await storage.writeVerifiedHead(
      makeVerifiedHead({
        sessionKey: 'n',
        throughSeq: 1,
        headDigest: 'a'.repeat(64),
        legacyThroughSeq: 0,
        algorithm: LEDGER_INTEGRITY_ALGORITHM,
        verifiedFullAtMs: 0,
        writtenAtMs: 0,
      }),
    )
    await storage.discardNewSession('n', 'r')
    expect(await storage.readVerifiedHead('n')).toBeUndefined()
  })

  it('counts the stored size of a session, parent prefix included', async () => {
    const { storage } = await seeded(3)
    const size = (text: string) => JSON.stringify(input(text).data).length
    expect(await storage.ledgerStats('k')).toEqual({
      storedBytes: size('m0') + size('m1') + size('m2'),
      maxRowBytes: size('m0'),
    })
    await storage.createChild('k', 2, 'c')
    expect((await storage.ledgerStats('c')).storedBytes).toBe(size('m0') + size('m1'))
  })
})
