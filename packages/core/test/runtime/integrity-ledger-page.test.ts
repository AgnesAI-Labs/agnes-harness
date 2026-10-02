import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../../src/ids.js'
import { MemoryStorage } from '../../src/log/memory-storage.js'
import { SessionLogImpl } from '../../src/log/session-log.js'
import { verifyIntegrityLedgerPage } from '../../src/runtime/integrity/ledger-page.js'

async function request() {
  const storage = new MemoryStorage()
  const log = await SessionLogImpl.open({
    storage,
    key: 'session-a',
    writerRunId: 'writer',
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.parse('2026-10-01T00:00:00Z'),
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  })
  const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
  await log.append(
    ['one', 'two'].map((text) => ({
      actor,
      origin: 'principal' as const,
      trust: 'trusted' as const,
      type: 'user/message' as const,
      data: { content: [{ type: 'text' as const, text }] },
    })),
  )
  await log.close()
  return {
    kind: 'ledger-page',
    algorithm: 'agnes-ledger-jcs-sha256-v1',
    initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
    rows: await storage.scanIntegrity('session-a', { fromSeq: 1, toSeq: 2, limit: 10 }),
  }
}

describe('public integrity ledger page', () => {
  it('verifies actual existing ledger bytes and supports bounded continuation', async () => {
    const input = await request()
    const whole = verifyIntegrityLedgerPage(input)
    const first = verifyIntegrityLedgerPage({ ...input, rows: input.rows.slice(0, 1) })
    if (first.kind !== 'ledger-page') throw new Error('wrong result kind')
    expect(
      verifyIntegrityLedgerPage({ ...input, initial: first.checkpoint, rows: input.rows.slice(1) }),
    ).toEqual(whole)
  })
  it('rejects payload tampering, gaps and a changed owner retaining the old digest', async () => {
    const input = await request()
    const changed = structuredClone(input)
    const firstChanged = changed.rows[0]
    if (!firstChanged) throw new Error('missing actual row')
    firstChanged.event.actor.id = 'tampered'
    expect(() => verifyIntegrityLedgerPage(changed)).toThrow()
    expect(() => verifyIntegrityLedgerPage({ ...input, rows: input.rows.slice(1) })).toThrow()
    const mixed = structuredClone(input)
    const secondMixed = mixed.rows[1]
    if (!secondMixed) throw new Error('missing actual row')
    secondMixed.sessionKey = 'session-b'
    expect(() => verifyIntegrityLedgerPage(mixed)).toThrow()
  })
  it('verifies actual immutable parent prefix with a differently owned child append', async () => {
    const storage = new MemoryStorage()
    const options = {
      storage,
      writerRunId: 'writer',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.parse('2026-10-01T00:00:00Z'),
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    }
    const parent = await SessionLogImpl.open({ ...options, key: 'parent' })
    const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const input = {
      actor,
      origin: 'principal' as const,
      trust: 'trusted' as const,
      type: 'user/message' as const,
      data: { content: [{ type: 'text' as const, text: 'parent' }] },
    }
    await parent.append([input])
    await parent.close()
    await storage.createChild('parent', 1, 'child')
    const child = await SessionLogImpl.open({ ...options, key: 'child', writerRunId: 'child-writer' })
    await child.append([{ ...input, data: { content: [{ type: 'text', text: 'child' }] } }])
    await child.close()
    const rows = await storage.scanIntegrity('child', { fromSeq: 1, toSeq: 2, limit: 10 })
    expect(rows.map((row) => row.sessionKey)).toEqual(['parent', 'child'])
    const result = verifyIntegrityLedgerPage({
      kind: 'ledger-page',
      algorithm: 'agnes-ledger-jcs-sha256-v1',
      initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
      rows,
    })
    expect(result).toMatchObject({
      kind: 'ledger-page',
      checkpoint: { lastSeq: 2, headDigest: rows[1]?.integrity?.digest },
    })
  })
  it('checks legacy, anchor, predecessor, reanchor and downgrade independently of a live writer', async () => {
    const { rows } = await request()
    const actual = rows[0]
    if (!actual) throw new Error('missing actual row')
    const legacy = { ...actual, integrity: null }
    const event = { ...actual.event, seq: 2 }
    const hash = createHash('sha256')
      .update(
        jcs({
          algorithm: 'agnes-ledger-jcs-sha256-v1',
          sessionKey: 'legacy-parent',
          legacyThroughSeq: 1,
          event,
        }),
      )
      .digest('hex')
    const anchor = {
      sessionKey: 'legacy-parent',
      event,
      integrity: { mode: 'anchor', previousDigest: null, digest: hash },
    }
    const input = {
      kind: 'ledger-page',
      algorithm: 'agnes-ledger-jcs-sha256-v1',
      initial: { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
      rows: [legacy, anchor],
    }
    expect(verifyIntegrityLedgerPage(input)).toMatchObject({
      checkpoint: { lastSeq: 2, legacyThroughSeq: 1, headDigest: hash },
    })
    for (const row of [
      { ...anchor, event: { ...event, seq: 3 } },
      { ...legacy, event: { ...event, seq: 3 } },
      {
        ...anchor,
        event: { ...event, seq: 3 },
        integrity: { ...anchor.integrity, mode: 'chain', previousDigest: '0'.repeat(64) },
      },
    ])
      expect(() => verifyIntegrityLedgerPage({ ...input, rows: [...input.rows, row] })).toThrow()
  })
  it('rejects inconsistent checkpoints and the 501st row', async () => {
    const input = await request()
    expect(() =>
      verifyIntegrityLedgerPage({
        ...input,
        rows: [],
        initial: { lastSeq: 1, legacyThroughSeq: 0, headDigest: null },
      }),
    ).toThrow()
    expect(() =>
      verifyIntegrityLedgerPage({ ...input, rows: Array.from({ length: 501 }, () => input.rows[0]) }),
    ).toThrow()
  })
})
