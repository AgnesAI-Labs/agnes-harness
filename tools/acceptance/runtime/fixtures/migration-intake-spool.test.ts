import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type MigrationIntakeEnvelope, openMigrationIntakeSpool } from './migration-intake-spool.js'

const envelope: MigrationIntakeEnvelope = {
  eventId: 'event-1',
  actionId: 'action-1',
  attemptId: 'attempt-1',
  bindingId: 'old-binding',
  inputDigest: 'ab'.repeat(32),
  externalRequestId: 'request-1',
  kind: 'receipt',
  payload: 'accepted',
}

describe('independent migration intake spool', () => {
  it('dedupes original identities after cold reopen and replay, preserves distinct attempts, and applies item/byte backpressure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-spool-'))
    const options = {
      file: join(root, 'intake', 'spool.sqlite'),
      authorityDirectories: [join(root, 'a'), join(root, 'b')] as const,
      capacityBytes: 4096,
      capacityItems: 2,
    }
    let spool = openMigrationIntakeSpool(options)
    try {
      expect(spool.accept(envelope)).toEqual({ ack: true, duplicate: false })
      expect(spool.accept(envelope)).toEqual({ ack: true, duplicate: true })
      expect(spool.accept({ ...envelope, payload: 'contradiction' })).toEqual({
        ack: false,
        reason: 'conflict',
      })
      const second = { ...envelope, attemptId: 'attempt-2', externalRequestId: 'request-2' }
      expect(spool.accept(second)).toEqual({ ack: true, duplicate: false })
      expect(spool.accept({ ...envelope, eventId: 'event-3' })).toEqual({ ack: false, reason: 'capacity' })
      spool.close()
      spool = openMigrationIntakeSpool(options)
      const received: MigrationIntakeEnvelope[] = []
      await expect(
        spool.replay(async () => {
          throw new Error('target unavailable')
        }),
      ).rejects.toThrow()
      expect(spool.pending()).toBe(2)
      expect(
        await spool.replay(async (item) => {
          received.push(item)
        }),
      ).toBe(2)
      expect(received).toEqual([envelope, second])
      spool.close()
      spool = openMigrationIntakeSpool(options)
      expect(spool.pending()).toBe(0)
      expect(spool.accept(envelope)).toEqual({ ack: true, duplicate: true })
      expect(
        await spool.replay(async () => {
          throw new Error('already replayed')
        }),
      ).toBe(0)
      expect(spool.accept({ ...envelope, eventId: 'event-3' })).toEqual({ ack: false, reason: 'capacity' })
      expect(() => openMigrationIntakeSpool({ ...options, file: join(root, 'a', 'spool.sqlite') })).toThrow()
    } finally {
      spool.close()
      rmSync(root, { recursive: true, force: true })
    }
    const byteRoot = mkdtempSync(join(tmpdir(), 'migration-spool-bytes-'))
    const tiny = openMigrationIntakeSpool({
      ...options,
      file: join(byteRoot, 'spool.sqlite'),
      capacityBytes: 10,
    })
    try {
      expect(tiny.accept(envelope)).toEqual({ ack: false, reason: 'capacity' })
    } finally {
      tiny.close()
      rmSync(byteRoot, { recursive: true, force: true })
    }
  })
  it('never acknowledges evidence whose transaction did not persist', () => {
    const root = mkdtempSync(join(tmpdir(), 'migration-spool-failure-'))
    const options = {
      file: join(root, 'intake.sqlite'),
      authorityDirectories: [join(root, 'a'), join(root, 'b')] as const,
      capacityBytes: 4096,
      capacityItems: 10,
    }
    let spool = openMigrationIntakeSpool({
      ...options,
      beforeCommit: () => {
        throw new Error('commit failed')
      },
    })
    try {
      expect(spool.accept(envelope)).toEqual({ ack: false, reason: 'persistence' })
      spool.close()
      spool = openMigrationIntakeSpool(options)
      expect(spool.pending()).toBe(0)
      expect(spool.accept(envelope)).toEqual({ ack: true, duplicate: false })
    } finally {
      spool.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
