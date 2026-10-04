import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IntegrityRow } from '@agnes/core'
import type { ComparisonLane, ComparisonRound, EventEnvelope } from '@agnes/protocol'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import { afterEach, describe, expect, it } from 'vitest'
import { createComparisonStore } from '../src/runtime/comparison-store.js'

// Actual sanitized ledger events drive local sequences/digests; cross-lane arrival below is synthetic.
const capture = JSON.parse(
  readFileSync(new URL('../../core/test/fixtures/comparison-real-cancel.json', import.meta.url), 'utf8'),
) as {
  pair: { lanes: ComparisonLane[]; rounds: ComparisonRound[] }
  reports: { events: EventEnvelope[] }[]
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing captured evidence')
  return value
}
const events = { left: required(capture.reports[0]).events, right: required(capture.reports[1]).events }
const sides: Side[] = ['left', 'right']
const resources: { file: string; root: string; store: ReturnType<typeof createComparisonStore> }[] = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close()
    rmSync(resource.root, { recursive: true, force: true })
  }
})
function record(lanes = true): ComparisonRecord {
  return {
    id: 'comparison',
    revision: 0,
    createPayload: 'private prompt credentials cwd',
    creation: 'ready',
    lanes: lanes
      ? Object.fromEntries(capture.pair.lanes.map((lane) => [lane.side, structuredClone(lane)]))
      : {},
    rounds: [],
    cancellation: {},
    cleanup: { exited: [], released: false },
  }
}
function setup(clock?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-comparison-journal-'))
  const file = join(root, 'comparison.sqlite')
  const store = createComparisonStore(file, clock ? { clock } : {})
  const resource = { file, root, store }
  resources.push(resource)
  return { resource, scoped: store.scoped('owner') }
}
function source(side: Side, index: number) {
  const event = required(events[side][index])
  return {
    side,
    sessionId: required(capture.pair.lanes.find((lane) => lane.side === side)).sessionId,
    localSeq: event.seq,
    digest: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
  }
}

describe('comparison journal durable publication contract', () => {
  it('archives real captured prefixes only after retirement and preserves immutable evidence after reopen', async () => {
    const { resource, scoped } = setup()
    const original = record()
    required(original.lanes.left).lastSeq = 1
    await scoped.compareAndSwap(original.id, null, original)
    const sessionId = required(original.lanes.left).sessionId
    // Capture predates integrity export: preserve the explicit absence rather than invent a chain.
    const rows: IntegrityRow[] = events.left.map((event) => ({
      sessionKey: sessionId,
      event,
      integrity: null,
    }))
    const input = { sessionId, epoch: 1, throughSeq: rows.length, rows }
    expect(() => scoped.archive.write(original.id, 'left', input)).toThrow(/retired/)
    await scoped.compareAndSwap(original.id, 0, {
      ...original,
      revision: 1,
      retirement: { state: 'releasing', epoch: 1 },
    })
    expect(() => scoped.archive.write(original.id, 'left', { ...input, rows: rows.slice(1) })).toThrow(
      /entire/,
    )
    expect(() => scoped.archive.write(original.id, 'left', { ...input, throughSeq: 0, rows: [] })).toThrow(
      /entire/,
    )
    await scoped.journal.checkpoint(original.id, {
      reason: 'recovery',
      cuts: { left: rows.length, right: required(original.lanes.right).lastSeq },
    })
    expect(() =>
      scoped.archive.write(original.id, 'left', { ...input, throughSeq: 1, rows: rows.slice(0, 1) }),
    ).toThrow(/published history/)
    expect(scoped.archive.read(original.id, 'left')).toBeUndefined()
    const manifest = scoped.archive.write(original.id, 'left', input)
    expect(scoped.archive.write(original.id, 'left', input)).toEqual(manifest)
    expect(resource.store.scoped('different-principal').archive.read(original.id, 'left')).toBeUndefined()
    expect(() => scoped.archive.write(original.id, 'left', { ...input, epoch: 2 })).toThrow(/retired/)
    const changed = structuredClone(rows)
    required(changed[0]).event.data = { changed: true }
    expect(() => scoped.archive.write(original.id, 'left', { ...input, rows: changed })).toThrow(/replaced/)
    resource.store.close()
    resource.store = createComparisonStore(resource.file)
    const archive = resource.store.scoped('owner').archive
    expect(archive.read(original.id, 'left')).toEqual({ manifest, rows })
    // A partial/corrupt persisted body must not be served as historical evidence.
    const raw = new DatabaseSync(resource.file)
    raw
      .prepare('UPDATE comparison_archives SET body=? WHERE principal=? AND id=?')
      .run('[]', 'owner', original.id)
    raw.close()
    expect(() => archive.read(original.id, 'left')).toThrow(/checksum/)
  })

  it('reserves missing lanes and permanently fences mutations across connections and reopen', async () => {
    const { resource } = setup()
    resource.store.close()
    const sessionKeys = (_principal: string, id: string) => ({ left: `${id}:left`, right: `${id}:right` })
    resource.store = createComparisonStore(resource.file, { sessionKeys })
    const other = createComparisonStore(resource.file, { sessionKeys })
    try {
      const scoped = resource.store.scoped('owner')
      const initial = { ...record(false), creation: 'preparing' as const }
      expect(await scoped.compareAndSwap(initial.id, null, initial)).toBe(true)
      expect(scoped.reservedBindings(initial.id)).toEqual(sessionKeys('owner', initial.id))
      expect(await scoped.findSession('comparison:left')).toEqual(initial)
      expect(other.scoped('stranger').admission('comparison:left')).toBeUndefined()
      expect(() => other.assertSessionAdmitted('comparison:left')).not.toThrow()
      const sealed = { ...initial, revision: 1, retirement: { state: 'releasing' as const, epoch: 1 } }
      const writer = new DatabaseSync(resource.file)
      try {
        writer.exec(
          "CREATE TRIGGER reject_retirement BEFORE INSERT ON comparison_journal WHEN json_extract(NEW.body,'$.fact.revision')=1 BEGIN SELECT RAISE(ABORT,'retirement failed'); END",
        )
        await expect(scoped.compareAndSwap(initial.id, 0, sealed)).rejects.toThrow('retirement failed')
        expect(await scoped.read(initial.id)).toEqual(initial)
        expect(() => other.assertSessionAdmitted('comparison:left')).not.toThrow()
        writer.exec('DROP TRIGGER reject_retirement')
      } finally {
        writer.close()
      }
      expect(await scoped.compareAndSwap(initial.id, 0, sealed)).toBe(true)
      for (const key of Object.values(sessionKeys('owner', initial.id)))
        expect(() => other.assertSessionAdmitted(key)).toThrow(/no longer admits/)
      expect(() => other.assertSessionAdmitted('ordinary-session')).not.toThrow()
      expect(await scoped.compareAndSwap(initial.id, 0, { ...initial, revision: 1 })).toBe(false)
      // Neither the readable state nor its permanent fence can regress or acquire another epoch.
      for (const retirement of [
        undefined,
        { state: 'releasing' as const, epoch: 2 },
        { state: 'removed' as const, epoch: 1 },
      ]) {
        await expect(
          scoped.compareAndSwap(initial.id, 1, {
            ...initial,
            revision: 2,
            ...(retirement ? { retirement } : {}),
          }),
        ).rejects.toMatchObject({ code: 'JOURNAL_RETIREMENT_CONFLICT' })
        expect(await scoped.read(initial.id)).toEqual(sealed)
      }
      expect(scoped.admission('comparison:left')).toMatchObject({ blocked: true, retirement: 'releasing' })
      resource.store.close()
      resource.store = createComparisonStore(resource.file, { sessionKeys })
      expect(() => resource.store.assertSessionAdmitted('comparison:left')).toThrow(/no longer admits/)
      expect(resource.store.scoped('owner').reservedBindings(initial.id)).toEqual(
        sessionKeys('owner', initial.id),
      )
    } finally {
      other.close()
    }
  })

  it('backfills legacy lane reservations and refuses mismatched deterministic bindings atomically', async () => {
    const { resource, scoped } = setup()
    const initial = record()
    await scoped.compareAndSwap(initial.id, null, initial)
    resource.store.close()
    const keys = {
      left: required(initial.lanes.left).sessionId,
      right: required(initial.lanes.right).sessionId,
    }
    resource.store = createComparisonStore(resource.file, { sessionKeys: () => keys })
    const reopened = resource.store.scoped('owner')
    expect(reopened.reservedBindings(initial.id)).toEqual(keys)
    const conflicting = { ...initial, id: 'other', revision: 0 }
    await expect(reopened.compareAndSwap('other', null, conflicting)).rejects.toMatchObject({
      code: 'JOURNAL_BINDING_MISMATCH',
    })
    expect(await reopened.read('other')).toBeUndefined()
    // Unknown persisted retirement cannot silently become permission to execute.
    const unknown = {
      ...initial,
      revision: 1,
      retirement: { state: 'future-state', epoch: 1 },
    } as unknown as ComparisonRecord
    await expect(reopened.compareAndSwap(initial.id, 0, unknown)).rejects.toMatchObject({
      code: 'JOURNAL_RETIREMENT_CONFLICT',
    })
    // Simulate a record written by a newer binary: opening it remains fail closed.
    resource.store.close()
    const raw = new DatabaseSync(resource.file)
    raw
      .prepare('UPDATE comparisons SET revision=?,body=? WHERE principal=? AND id=?')
      .run(unknown.revision, JSON.stringify(unknown), 'owner', initial.id)
    raw.close()
    resource.store = createComparisonStore(resource.file, { sessionKeys: () => keys })
    expect(() => resource.store.assertSessionAdmitted(keys.left)).toThrow(/no longer admits/)
    await expect(
      resource.store.scoped('owner').compareAndSwap(initial.id, 1, { ...initial, revision: 2 }),
    ).rejects.toMatchObject({ code: 'JOURNAL_RETIREMENT_CONFLICT' })
  })

  it('lists detached safe summaries with stable bounded membership, ownership and honest legacy times', async () => {
    let now = 100
    const { resource, scoped } = setup(() => now)
    for (const id of ['old', 'middle', 'new']) {
      const next = { ...record(false), id, creation: 'preparing' as const }
      expect(await scoped.compareAndSwap(id, null, next)).toBe(true)
    }
    const first = await scoped.list({ limit: 1 })
    expect(first.items).toEqual([
      {
        id: 'new',
        revision: 0,
        phase: 'preparing',
        createdAt: 100,
        updatedAt: 100,
        roundCount: 0,
        inspectable: false,
        lanes: [],
      },
    ])
    expect(JSON.stringify(first)).not.toContain('private')
    const cursor = required(first.nextCursor ?? undefined)
    const firstBoundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).through
    const other = resource.store.scoped('other-owner')
    await other.compareAndSwap('new', null, { ...record(false), id: 'new' })
    await expect(other.list({ cursor })).rejects.toMatchObject({ code: 'COMPARISON_INVALID_CURSOR' })
    now = 200
    await scoped.compareAndSwap('newest', null, { ...record(false), id: 'newest' })
    const ownNewPage = await scoped.list({ limit: 1 })
    const ownBoundary = JSON.parse(
      Buffer.from(required(ownNewPage.nextCursor ?? undefined), 'base64url').toString('utf8'),
    ).through
    // Another principal's insert cannot leak through this principal's cursor counter.
    expect(ownBoundary - firstBoundary).toBe(1)
    await scoped.compareAndSwap('old', 0, { ...record(false), id: 'old', revision: 1, creation: 'failed' })
    const remainder = await scoped.list({ cursor, limit: 100 })
    expect(remainder.items.map((item) => item.id)).toEqual(['middle', 'old'])
    expect(remainder.items[1]).toMatchObject({ phase: 'failed', createdAt: 100, updatedAt: 200 })
    expect(remainder.nextCursor).toBeNull()
    expect((await scoped.list()).items.map((item) => item.id)).toEqual(['newest', 'new', 'middle', 'old'])
    expect((await other.list()).items.map((item) => item.id)).toEqual(['new'])
    now = 300
    expect(await scoped.compareAndSwap('old', 0, { ...record(false), id: 'old', revision: 1 })).toBe(false)
    expect(await scoped.list({ cursor })).toEqual(remainder)
    for (const bad of [
      'broken',
      Buffer.from(JSON.stringify({ version: 1, owner: '', through: 2, before: 3 })).toString('base64url'),
    ])
      await expect(scoped.list({ cursor: bad })).rejects.toMatchObject({ code: 'COMPARISON_INVALID_CURSOR' })

    const writer = new DatabaseSync(resource.file)
    writer
      .prepare('INSERT INTO comparisons VALUES(?,?,?,?)')
      .run('owner', 'legacy', 0, JSON.stringify({ ...record(false), id: 'legacy' }))
    writer.close()
    const journalBefore = await scoped.journal.read('old')
    resource.store.close()
    resource.store = createComparisonStore(resource.file)
    expect((await resource.store.scoped('owner').list()).items[0]).toMatchObject({
      id: 'legacy',
      createdAt: null,
      updatedAt: null,
    })
    expect(await resource.store.scoped('owner').journal.read('old')).toEqual(journalBefore)
    expect(await resource.store.scoped('owner').list({ cursor })).toEqual(remainder)
  })

  it('publishes each real source event once with cumulative cuts and persists the exact publication prefix', async () => {
    const { resource, scoped } = setup()
    expect(await scoped.compareAndSwap('comparison', null, record())).toBe(true)
    let seq = 1
    const cuts = { left: 0, right: 0 }
    for (let index = 0; index < Math.max(events.left.length, events.right.length); index++) {
      for (const side of sides) {
        if (!events[side][index]) continue
        const input = source(side, index)
        const entry = await scoped.journal.appendLane('comparison', input)
        cuts[side] = input.localSeq
        expect(entry).toEqual({ seq: ++seq, cuts: { ...cuts }, fact: { kind: 'lane', ...input } })
        expect(await scoped.journal.appendLane('comparison', input)).toEqual(entry)
      }
    }
    const before = await scoped.journal.read('comparison')
    expect(before.entries).toHaveLength(1 + events.left.length + events.right.length)
    expect(await scoped.journal.cutsAt('comparison', seq)).toEqual(cuts)
    expect(JSON.stringify(before)).not.toContain('private prompt')
    expect(JSON.stringify(before)).not.toContain('workspaceLabel')
    resource.store.close()
    resource.store = createComparisonStore(resource.file)
    expect(await resource.store.scoped('owner').journal.read('comparison')).toEqual(before)
  })

  it('commits coordinator state and its safe fact together, with CAS rejection and SQL failure leaving neither write', async () => {
    const { resource, scoped } = setup()
    const initial = record()
    await scoped.compareAndSwap(initial.id, null, initial)
    const capturedRound = required(capture.pair.rounds[0])
    const next: ComparisonRecord = {
      ...initial,
      revision: 1,
      error: { code: 'private', message: 'private prompt' },
      rounds: [
        {
          inputId: capturedRound.inputId,
          payload: 'private prompt',
          permissionMode: 'full',
          acceptances: {
            left: required(capturedRound.acceptances.find((acceptance) => acceptance.side === 'left')),
            right: required(capturedRound.acceptances.find((acceptance) => acceptance.side === 'right')),
          },
          runs: {
            left: {
              status: 'settled',
              terminalCause: required(capturedRound.terminalCauses.find((cause) => cause.side === 'left'))
                .cause,
            },
            right: {
              status: 'settled',
              terminalCause: required(capturedRound.terminalCauses.find((cause) => cause.side === 'right'))
                .cause,
            },
          },
        },
      ],
    }
    const writer = new DatabaseSync(resource.file)
    try {
      writer.exec(
        "CREATE TRIGGER reject_fact BEFORE INSERT ON comparison_journal WHEN json_extract(NEW.body,'$.fact.revision')=1 BEGIN SELECT RAISE(ABORT,'synthetic journal write failure'); END",
      )
      await expect(scoped.compareAndSwap(initial.id, 0, next)).rejects.toThrow(
        'synthetic journal write failure',
      )
      expect(await scoped.read(initial.id)).toEqual(initial)
      expect((await scoped.journal.head(initial.id))?.seq).toBe(1)
      writer.exec('DROP TRIGGER reject_fact')
      expect(await scoped.compareAndSwap(initial.id, 0, next)).toBe(true)
      expect(await scoped.compareAndSwap(initial.id, 0, next)).toBe(false)
      expect(await scoped.compareAndSwap(initial.id, null, initial)).toBe(false)
      const page = await scoped.journal.read(initial.id)
      expect(page.entries.map((entry) => entry.seq)).toEqual([1, 2])
      expect(page.entries[1]?.fact).toMatchObject({ kind: 'coordinator', revision: 1 })
      expect(page.entries[1]?.fact).toMatchObject({
        latestRound: {
          permissionMode: 'full',
          terminalCauses: { left: 'cancelled', right: 'finished' },
          acceptedSeqs: { left: 4, right: 4 },
        },
      })
      expect(JSON.stringify(page)).not.toContain('private')
      const changedMode = structuredClone(next)
      changedMode.revision = 2
      required(changedMode.rounds[0]).permissionMode = 'workspace'
      await expect(scoped.compareAndSwap(initial.id, 1, changedMode)).rejects.toMatchObject({
        code: 'JOURNAL_IDENTITY_CONFLICT',
      })
      expect(await scoped.read(initial.id)).toEqual(next)
      expect(await scoped.journal.read(initial.id)).toEqual(page)
      writer.exec(
        "CREATE TRIGGER reject_append BEFORE INSERT ON comparison_journal BEGIN SELECT RAISE(ABORT,'synthetic append failure'); END",
      )
      await expect(scoped.journal.appendLane(initial.id, source('left', 0))).rejects.toThrow(
        'synthetic append failure',
      )
      await expect(
        scoped.journal.checkpoint(initial.id, { reason: 'baseline', cuts: { left: 3, right: 5 } }),
      ).rejects.toThrow('synthetic append failure')
      await expect(
        scoped.compareAndSwap('another', null, { ...initial, id: 'another', lanes: {} }),
      ).rejects.toThrow('synthetic append failure')
      expect(await scoped.read('another')).toBeUndefined()
      expect(await scoped.journal.head(initial.id)).toMatchObject({ seq: 2, cuts: { left: 0, right: 0 } })
      writer.exec('DROP TRIGGER reject_append')
      expect(await scoped.journal.appendLane(initial.id, source('left', 0))).toMatchObject({
        seq: 3,
        cuts: { left: 1, right: 0 },
      })
      await expect(scoped.compareAndSwap(initial.id, 1, next)).rejects.toMatchObject({
        code: 'JOURNAL_INVALID_ARGUMENT',
      })
      for (const expected of [Number.MAX_SAFE_INTEGER, -1, Number.NaN]) {
        await expect(
          scoped.compareAndSwap(initial.id, expected, { ...next, revision: expected + 1 }),
        ).rejects.toMatchObject({ code: 'JOURNAL_INVALID_ARGUMENT' })
      }
      const legacy = structuredClone(next)
      legacy.revision = 2
      for (const side of sides) delete required(legacy.rounds[0]).runs[side].terminalCause
      await scoped.compareAndSwap(initial.id, 1, legacy)
      expect((await scoped.journal.read(initial.id)).entries.at(-1)?.fact).toMatchObject({
        latestRound: { terminalCauses: { left: 'unknown', right: 'unknown' } },
      })
    } finally {
      writer.close()
    }
  })

  it('rejects conflicting, missing, and foreign source identities without advancing either sequence', async () => {
    const { scoped } = setup()
    await scoped.compareAndSwap('comparison', null, record())
    const first = source('left', 0)
    await expect(scoped.journal.appendLane('comparison', source('left', 1))).rejects.toMatchObject({
      code: 'JOURNAL_SEQUENCE_GAP',
    })
    await expect(
      scoped.journal.appendLane('comparison', { ...first, sessionId: source('right', 0).sessionId }),
    ).rejects.toMatchObject({ code: 'JOURNAL_IDENTITY_CONFLICT' })
    await scoped.journal.appendLane('comparison', first)
    await expect(
      scoped.journal.appendLane('comparison', { ...first, digest: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'JOURNAL_SOURCE_CONFLICT' })
    expect(await scoped.journal.head('comparison')).toMatchObject({ seq: 2, cuts: { left: 1, right: 0 } })
    await expect(
      scoped.journal.appendLane('comparison', { ...source('left', 1), digest: 'private prompt' }),
    ).rejects.toMatchObject({ code: 'JOURNAL_INVALID_ARGUMENT' })
    expect((await scoped.journal.head('comparison'))?.seq).toBe(2)
  })

  it('represents baseline and recovery tails as explicit unknown interleaving checkpoints', async () => {
    const { scoped } = setup()
    await scoped.compareAndSwap('comparison', null, record())
    const baseline = await scoped.journal.checkpoint('comparison', {
      reason: 'baseline',
      cuts: { left: 3, right: 5 },
    })
    expect(baseline.fact).toEqual({
      kind: 'checkpoint',
      reason: 'baseline',
      coverage: 'unknown-interleaving',
    })
    await scoped.journal.appendLane('comparison', source('left', 3))
    const cuts = { left: required(events.left.at(-1)).seq, right: required(events.right.at(-1)).seq }
    const recovery = await scoped.journal.checkpoint('comparison', { reason: 'recovery', cuts })
    expect(recovery).toMatchObject({
      seq: 4,
      cuts,
      fact: { reason: 'recovery', coverage: 'unknown-interleaving' },
    })
    expect((await scoped.journal.head('comparison'))?.coverage).toBe('unknown-interleaving')
    expect((await scoped.journal.read('comparison')).entries).toHaveLength(4)
    expect(await scoped.journal.cutsAt('comparison', 2)).toEqual({ left: 3, right: 5 })
    await expect(
      scoped.journal.checkpoint('comparison', { reason: 'recovery', cuts: { left: 1, right: 5 } }),
    ).rejects.toMatchObject({ code: 'JOURNAL_CUT_REGRESSION' })
    await expect(scoped.journal.appendLane('comparison', source('right', 0))).rejects.toMatchObject({
      code: 'JOURNAL_SEQUENCE_GAP',
    })
  })

  it('never manufactures legacy history during reads and explicitly labels the first new writes per-lane-only', async () => {
    const { resource, scoped } = setup()
    const initial = record()
    const writer = new DatabaseSync(resource.file)
    try {
      writer
        .prepare('INSERT INTO comparisons VALUES(?,?,?,?)')
        .run('owner', initial.id, 0, JSON.stringify(initial))
      expect(await scoped.journal.head(initial.id)).toBeUndefined()
      expect(await scoped.journal.read(initial.id)).toEqual({
        entries: [],
        afterSeq: 0,
        throughSeq: 0,
        nextAfterSeq: 0,
        complete: true,
      })
      expect(await scoped.journal.cutsAt(initial.id, 0)).toEqual({ left: 0, right: 0 })
      expect(writer.prepare('SELECT count(*) AS count FROM comparison_journal').get()).toEqual({ count: 0 })
      await expect(scoped.journal.appendLane(initial.id, source('left', 0))).rejects.toMatchObject({
        code: 'JOURNAL_CHECKPOINT_REQUIRED',
      })
      const cuts = {
        left: required(initial.lanes.left).lastSeq,
        right: required(initial.lanes.right).lastSeq,
      }
      await scoped.compareAndSwap(initial.id, 0, { ...initial, revision: 1 })
      expect((await scoped.journal.read(initial.id)).entries).toMatchObject([
        { seq: 1, cuts, fact: { reason: 'legacy', coverage: 'per-lane-only' } },
        { seq: 2, cuts, fact: { kind: 'coordinator', revision: 1 } },
      ])
      expect(await scoped.journal.head(initial.id)).toMatchObject({ coverage: 'per-lane-only' })
      const second = { ...initial, id: 'other' }
      writer
        .prepare('INSERT INTO comparisons VALUES(?,?,?,?)')
        .run('owner', second.id, 0, JSON.stringify(second))
      await scoped.journal.checkpoint(second.id, { reason: 'legacy', cuts })
      expect((await scoped.journal.head(second.id))?.coverage).toBe('per-lane-only')
    } finally {
      writer.close()
    }
  })

  it('freezes inclusive page watermarks and enforces UTF-8 byte bounds and missing-page errors', async () => {
    const { resource, scoped } = setup()
    await scoped.compareAndSwap('comparison', null, record())
    await scoped.journal.appendLane('comparison', source('left', 0))
    await scoped.journal.appendLane('comparison', source('right', 0))
    const first = await scoped.journal.read('comparison', { limit: 1 })
    expect(first).toMatchObject({ throughSeq: 3, nextAfterSeq: 1, complete: false })
    await scoped.journal.appendLane('comparison', source('left', 1))
    const second = await scoped.journal.read('comparison', {
      afterSeq: first.nextAfterSeq,
      throughSeq: first.throughSeq,
    })
    expect(second.entries.map((entry) => entry.seq)).toEqual([2, 3])
    expect(second.complete).toBe(true)
    const bytes = Buffer.byteLength(JSON.stringify(first.entries), 'utf8')
    expect((await scoped.journal.read('comparison', { maxBytes: bytes })).entries).toHaveLength(1)
    await expect(scoped.journal.read('comparison', { maxBytes: bytes - 1 })).rejects.toMatchObject({
      code: 'JOURNAL_ENTRY_TOO_LARGE',
    })
    await expect(scoped.journal.read('comparison', { afterSeq: 5, throughSeq: 4 })).rejects.toMatchObject({
      code: 'JOURNAL_INVALID_ARGUMENT',
    })
    await expect(scoped.journal.read('comparison', { limit: 0 })).rejects.toMatchObject({
      code: 'JOURNAL_INVALID_ARGUMENT',
    })
    await expect(scoped.journal.read('comparison', { throughSeq: 5 })).rejects.toMatchObject({
      code: 'JOURNAL_INVALID_ARGUMENT',
    })
    const writer = new DatabaseSync(resource.file)
    try {
      writer
        .prepare('DELETE FROM comparison_journal WHERE principal=? AND id=? AND seq=?')
        .run('owner', 'comparison', 2)
    } finally {
      writer.close()
    }
    await expect(scoped.journal.read('comparison', { afterSeq: 1 })).rejects.toMatchObject({
      code: 'JOURNAL_PAGE_MISSING',
    })
    await expect(scoped.journal.cutsAt('comparison', 2)).rejects.toMatchObject({
      code: 'JOURNAL_PAGE_MISSING',
    })
  })

  it('isolates principals and fixes each session/runtime identity exactly once, including partial creation', async () => {
    const { resource, scoped } = setup()
    const initial = record(false)
    await scoped.compareAndSwap(initial.id, null, initial)
    await expect(
      scoped.journal.checkpoint(initial.id, { reason: 'baseline', cuts: { left: 0, right: 0 } }),
    ).rejects.toMatchObject({ code: 'JOURNAL_IDENTITY_CONFLICT' })
    const next = { ...record(), revision: 1 }
    await scoped.compareAndSwap(initial.id, 0, next)
    for (const kind of ['session', 'runtime', 'version', 'removed'] as const) {
      const invalid = structuredClone(next)
      invalid.revision++
      if (kind === 'session') required(invalid.lanes.left).sessionId = 'foreign-session'
      if (kind === 'runtime') required(invalid.lanes.left).runtime.id = 'foreign-runtime'
      if (kind === 'version') required(invalid.lanes.left).runtime.version = '99'
      if (kind === 'removed') delete invalid.lanes.left
      await expect(scoped.compareAndSwap(initial.id, 1, invalid)).rejects.toMatchObject({
        code: 'JOURNAL_IDENTITY_CONFLICT',
      })
    }
    expect((await scoped.journal.head(initial.id))?.seq).toBe(2)
    const foreign = resource.store.scoped('foreign')
    await expect(foreign.journal.read(initial.id)).rejects.toMatchObject({ code: 'COMPARISON_NOT_FOUND' })
    await expect(foreign.journal.appendLane(initial.id, source('left', 0))).rejects.toMatchObject({
      code: 'COMPARISON_NOT_FOUND',
    })
    const foreignRecord = record()
    for (const lane of Object.values(foreignRecord.lanes))
      if (lane) lane.sessionId = `foreign:${lane.sessionId}`
    await foreign.compareAndSwap(initial.id, null, foreignRecord)
    await foreign.journal.appendLane(initial.id, {
      ...source('left', 0),
      sessionId: required(foreignRecord.lanes.left).sessionId,
    })
    expect(await scoped.journal.cutsAt(initial.id, 2)).toEqual({ left: 0, right: 0 })
    expect(await foreign.journal.cutsAt(initial.id, 2)).toEqual({ left: 1, right: 0 })
  })

  it('publishes optional run timing and terminal seq without inventing them for old rounds', async () => {
    const { scoped } = setup()
    const initial = record()
    await scoped.compareAndSwap(initial.id, null, initial)
    const capturedRound = required(capture.pair.rounds[0])
    const timing = {
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: '2026-10-03T00:00:00.025Z',
      elapsedMs: 25,
      terminalConfirmed: true,
    }
    const next: ComparisonRecord = {
      ...initial,
      revision: 1,
      rounds: [
        {
          inputId: capturedRound.inputId,
          payload: 'sealed',
          acceptances: {
            left: required(capturedRound.acceptances.find((acceptance) => acceptance.side === 'left')),
            right: required(capturedRound.acceptances.find((acceptance) => acceptance.side === 'right')),
          },
          runs: {
            left: { status: 'settled', terminalCause: 'finished', timing, terminalSeq: 40 },
            right: { status: 'settled', terminalCause: 'cancelled' },
          },
        },
      ],
    }
    expect(await scoped.compareAndSwap(initial.id, 0, next)).toBe(true)
    const fact = (await scoped.journal.read(initial.id)).entries.at(-1)?.fact
    expect(fact).toMatchObject({
      kind: 'coordinator',
      latestRound: {
        timings: { left: timing },
        terminalSeqs: { left: 40 },
      },
    })
    expect(fact && fact.kind === 'coordinator' ? fact.latestRound?.timings?.right : undefined).toBeUndefined()
    expect(
      fact && fact.kind === 'coordinator' ? fact.latestRound?.terminalSeqs?.right : undefined,
    ).toBeUndefined()
    const legacy: ComparisonRecord = {
      ...next,
      revision: 2,
      rounds: [
        {
          ...next.rounds[0]!,
          runs: {
            left: { status: 'settled', terminalCause: 'finished' },
            right: { status: 'settled', terminalCause: 'finished' },
          },
        },
      ],
    }
    expect(await scoped.compareAndSwap(initial.id, 1, legacy)).toBe(true)
    const old = (await scoped.journal.read(initial.id)).entries.at(-1)?.fact
    expect(old && old.kind === 'coordinator' ? old.latestRound : undefined).not.toHaveProperty('timings')
    expect(old && old.kind === 'coordinator' ? old.latestRound : undefined).not.toHaveProperty('terminalSeqs')
  })
})
