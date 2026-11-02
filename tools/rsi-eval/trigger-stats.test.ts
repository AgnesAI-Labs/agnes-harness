import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DDL } from '../../packages/host-infrastructure/src/adapters/ddl.js'
import { normalizeToolError, openLedgerReadOnly, readBenchEvents } from './ledger-source.js'
import { collectDbSessions, computeTriggerStats } from './trigger-stats.js'

type Row = { type: string; data?: unknown; lane?: string; origin?: string; src?: number[]; ts?: string }
type Fixture = { key: string; parentKey?: string; rows: Row[] }

const BASE = Date.parse('2026-10-01T00:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

class Ledger {
  rows: Row[] = []
  add(row: Row): number {
    this.rows.push(row)
    return this.rows.length
  }
  start(turn: number, ts?: string): number {
    return this.add({ type: 'turn/start', data: { turn, trigger: 'prompt' }, ...(ts ? { ts } : {}) })
  }
  end(): number {
    return this.add({ type: 'turn/end', data: { reason: 'completed', lastAssistantSeq: null } })
  }
  call(name: string): number {
    return this.add({
      type: 'tool/call',
      data: { toolUseId: `u${this.rows.length}`, name, args: {}, ordinal: 0 },
    })
  }
  fail(callSeq: number, text: string): number {
    return this.add({
      type: 'tool/result',
      data: { toolUseId: `u${callSeq - 1}`, content: [{ type: 'text', text }], isError: true },
      src: [callSeq],
    })
  }
  failTool(name: string, text: string): number {
    return this.fail(this.call(name), text)
  }
  say(text: string): number {
    return this.add({
      type: 'user/message',
      data: { content: [{ type: 'text', text }] },
      origin: 'principal',
    })
  }
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-trigger-stats-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDb(fixtures: Fixture[]): string {
  const file = join(tempDir(), 'sessions.db')
  const db = new DatabaseSync(file)
  for (const stmt of DDL) {
    if (/^\s*CREATE (TABLE|INDEX) IF NOT EXISTS (events|sessions|events_type)\b/.test(stmt)) db.exec(stmt)
  }
  const session = db.prepare('INSERT INTO sessions (session_key, parent_key, created_at) VALUES (?, ?, ?)')
  const withLane = db.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, lane, actor, origin, trust, source_event_seqs, data)
     VALUES (?, ?, ?, ?, ?, ?, 'x', ?, 'trusted', ?, ?)`,
  )
  const withoutLane = db.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, source_event_seqs, data)
     VALUES (?, ?, ?, ?, ?, 'x', ?, 'trusted', ?, ?)`,
  )
  for (const fixture of fixtures) {
    session.run(fixture.key, fixture.parentKey ?? null, iso(BASE))
    fixture.rows.forEach((row, i) => {
      const seq = i + 1
      const common = [
        fixture.key,
        seq,
        row.ts ?? iso(BASE + seq * 1000),
        `${fixture.key}-${seq}`,
        row.type,
      ] as const
      const tail = [
        row.origin ?? 'system',
        row.src ? JSON.stringify(row.src) : null,
        JSON.stringify(row.data ?? {}),
      ] as const
      if (row.lane) withLane.run(...common, Buffer.from(row.lane), ...tail)
      else withoutLane.run(...common, ...tail)
    })
  }
  db.close()
  return file
}

const stats = (file: string, opts?: { repeatThreshold?: number }) =>
  computeTriggerStats(collectDbSessions(file), opts)

describe('trigger stats', () => {
  it('counts a turn once when one tool fails three times with the same normalized error', () => {
    const l = new Ledger()
    l.start(1)
    l.failTool('bash', 'Error: line 12 at /tmp/a1b2c3d4e5/x.ts failed')
    l.failTool('bash', 'Error: line 57 at /tmp/9f8e7d6c5b/x.ts failed')
    l.failTool('bash', 'Error: line 3 at /tmp/0011223344/x.ts failed')
    l.end()
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.sessions).toBe(1)
    expect(result.turns).toBe(1)
    expect(result.repeatedFailure.turns).toBe(1)
    expect(result.repeatedFailure.turnRate).toBe(1)
    expect(result.repeatedFailure.goals).toBe(0)
    expect(result.repeatedFailure.goalRate).toBeNull()
  })

  it('does not count two different errors of the same tool', () => {
    const l = new Ledger()
    l.start(1)
    l.failTool('bash', 'permission denied')
    l.failTool('bash', 'permission denied')
    l.failTool('bash', 'no such file')
    l.failTool('bash', 'no such file')
    l.end()
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.repeatedFailure.turns).toBe(0)
    expect(result.repeatedFailure.turnRate).toBe(0)
  })

  it('groups by the error code when a result has one, and falls back to the event origin for the tool name', () => {
    const l = new Ledger()
    l.start(1)
    for (let i = 0; i < 3; i++)
      l.add({
        type: 'tool/result',
        data: {
          toolUseId: `x${i}`,
          content: [{ type: 'text', text: `different ${i}` }],
          isError: true,
          code: 'E_BUSY',
        },
        origin: 'tool:python_repl',
      })
    l.end()
    expect(stats(makeDb([{ key: 's1', rows: l.rows }])).repeatedFailure.turns).toBe(1)
  })

  it('honours a custom repeat threshold', () => {
    const l = new Ledger()
    l.start(1)
    l.failTool('bash', 'boom')
    l.failTool('bash', 'boom')
    l.end()
    const file = makeDb([{ key: 's1', rows: l.rows }])
    expect(stats(file).repeatedFailure.turns).toBe(0)
    expect(stats(file, { repeatThreshold: 2 }).repeatedFailure.turns).toBe(1)
  })

  it('counts failures across turns inside one goal window', () => {
    const l = new Ledger()
    l.say('/goal create ship the thing')
    for (let turn = 1; turn <= 3; turn++) {
      l.start(turn)
      l.failTool('bash', `boom at line ${turn}`)
      l.end()
    }
    l.say('/goal complete')
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.repeatedFailure.turns).toBe(0)
    expect(result.repeatedFailure.goals).toBe(1)
    expect(result.repeatedFailure.goalRate).toBe(1)
  })

  it('excludes fork children, imported sessions and non-main lanes', () => {
    const main = new Ledger()
    main.start(1)
    main.failTool('bash', 'boom')
    main.add({
      type: 'tool/call',
      data: { toolUseId: 'r', name: 'bash', args: {}, ordinal: 0 },
      lane: 'refinement',
    })
    for (let i = 0; i < 3; i++)
      main.add({
        type: 'tool/result',
        data: { toolUseId: 'r', content: [{ type: 'text', text: 'side lane' }], isError: true },
        lane: 'refinement',
        src: [3],
      })
    main.end()
    const child = new Ledger()
    child.start(1)
    for (let i = 0; i < 3; i++) child.failTool('bash', 'child failure')
    child.end()
    const imported = new Ledger()
    imported.add({
      type: 'session/start',
      data: { key: 'imp', imported: { source: 'claude-code', sourceId: 'a', cwd: '/x' } },
    })
    imported.start(1)
    imported.add({ type: 'x/core/compaction-end', data: {} })
    imported.end()
    const result = stats(
      makeDb([
        { key: 'main', rows: main.rows },
        { key: 'child', parentKey: 'main', rows: child.rows },
        { key: 'imp', rows: imported.rows },
      ]),
    )
    expect(result.sessions).toBe(1)
    expect(result.turns).toBe(1)
    expect(result.repeatedFailure.turns).toBe(0)
    expect(result.compaction.ok).toBe(0)
  })

  it('reports remaining turns after each successful compaction', () => {
    const l = new Ledger()
    for (let turn = 1; turn <= 5; turn++) {
      l.start(turn)
      if (turn === 2) {
        l.add({ type: 'step/start', data: { turn, step: 1 } })
        l.add({ type: 'x/core/compaction-end', data: {} })
        l.add({ type: 'x/core/compaction-failed', data: { reason: 'nope' } })
        l.add({ type: 'step/start', data: { turn, step: 2 } })
        l.add({ type: 'step/start', data: { turn, step: 3 } })
      }
      l.end()
    }
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.turns).toBe(5)
    expect(result.compaction.ok).toBe(1)
    expect(result.compaction.failed).toBe(1)
    expect(result.compaction.per100Turns).toBe(20)
    expect(result.compaction.remainingTurnsAfter).toEqual({ n: 1, p50: 3, p90: 3, max: 3 })
    expect(result.compaction.remainingStepsInTurnAfter).toEqual({ n: 1, p50: 2, p90: 2, max: 2 })
  })

  it('applies AGH limits and Prime cooldown to raw triggers', () => {
    // Six turns ten minutes apart, one compaction in each: one completed turn between candidates.
    const l = new Ledger()
    for (let turn = 1; turn <= 6; turn++) {
      const ts = iso(BASE + (turn - 1) * 600_000)
      l.start(turn, ts)
      l.add({ type: 'x/core/compaction-end', data: {}, ts })
      l.end()
    }
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.autoTriggers.raw).toBe(6)
    // AGH: needs five completed turns between triggers, so only the first and the sixth candidate pass.
    expect(result.autoTriggers.afterAghLimits).toBe(2)
    // Prime: 20 minute cooldown lets minutes 0, 20 and 40 through.
    expect(result.autoTriggers.afterPrimeCooldown).toBe(3)
  })

  it('caps AGH triggers at four per hour', () => {
    // Twenty-one one-minute turns; a compaction in turns 1, 6, 11, 16 and 21 (minutes 0, 5, 10, 15, 20).
    const l = new Ledger()
    for (let turn = 1; turn <= 21; turn++) {
      const ts = iso(BASE + (turn - 1) * 60_000)
      l.start(turn, ts)
      if ((turn - 1) % 5 === 0) l.add({ type: 'x/core/compaction-end', data: {}, ts })
      l.end()
    }
    const result = stats(makeDb([{ key: 's1', rows: l.rows }]))
    expect(result.autoTriggers.raw).toBe(5)
    expect(result.autoTriggers.afterAghLimits).toBe(4)
    expect(result.autoTriggers.afterPrimeCooldown).toBe(2)
  })

  it('opens the database read-only', () => {
    const l = new Ledger()
    l.start(1)
    l.failTool('bash', 'boom')
    l.end()
    const file = makeDb([{ key: 's1', rows: l.rows }])
    chmodSync(file, 0o444)
    const fingerprint = () => ({
      sha: createHash('sha256').update(readFileSync(file)).digest('hex'),
      mtime: statSync(file).mtimeMs,
    })
    const before = fingerprint()
    expect(stats(file).turns).toBe(1)
    expect(fingerprint()).toEqual(before)
  })
})

describe('ledger source', () => {
  it('lists sessions with parent and imported flags and returns main-lane events in seq order', () => {
    const main = new Ledger()
    main.start(1)
    main.add({ type: 'tool/call', data: {}, lane: 'other' })
    main.end()
    const imported = new Ledger()
    imported.add({ type: 'session/start', data: { imported: { source: 'agnes', sourceId: 'a', cwd: '/x' } } })
    const file = makeDb([
      { key: 'a', rows: main.rows },
      { key: 'b', parentKey: 'a', rows: [] },
      { key: 'c', rows: imported.rows },
    ])
    const ledger = openLedgerReadOnly(file)
    try {
      expect(ledger.sessions().sort((x, y) => x.key.localeCompare(y.key))).toEqual([
        { key: 'a', parentKey: null, imported: false },
        { key: 'b', parentKey: 'a', imported: false },
        { key: 'c', parentKey: null, imported: true },
      ])
      expect(ledger.events('a').map((e) => [e.seq, e.type])).toEqual([
        [1, 'turn/start'],
        [3, 'turn/end'],
      ])
    } finally {
      ledger.close()
    }
  })

  it('reads bench event files and keeps only the main lane', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'events'))
    const lines = [
      { seq: 2, type: 'turn/end', lane: 'main', ts: iso(BASE), data: {} },
      { seq: 1, type: 'turn/start', lane: 'main', ts: iso(BASE), data: { turn: 1 } },
      { seq: 3, type: 'tool/result', lane: 'refinement', ts: iso(BASE), data: {} },
    ]
    writeFileSync(join(dir, 'events', 'run-1.jsonl'), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`)
    const bySession = readBenchEvents(join(dir, 'events'))
    expect([...bySession.keys()]).toEqual(['run-1'])
    expect(bySession.get('run-1')?.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('normalizeToolError', () => {
  it('keeps code and masks paths, hex and digits', () => {
    expect(normalizeToolError({ code: 'E_TIMEOUT', content: [{ type: 'text', text: 'ignored' }] })).toBe(
      'E_TIMEOUT',
    )
    expect(
      normalizeToolError({
        content: [
          { type: 'image', data: 'x' },
          { type: 'text', text: '   ' },
          {
            type: 'text',
            text: 'Error: Cannot open /srv/work/a.txt at line 42 id deadbeef01\nstack...',
          },
        ],
      }),
    ).toBe('error: cannot open <path> at line # id <hex>')
    expect(normalizeToolError({ content: [{ type: 'text', text: `x${'y'.repeat(300)}` }] })).toHaveLength(120)
    expect(normalizeToolError({ content: [] })).toBe('')
  })

  it('skips a shell stream label so different shell errors stay different', () => {
    const err = (text: string) => normalizeToolError({ content: [{ type: 'text', text }] })
    expect(err('\n[stderr]\ncat: /srv/a.txt: No such file or directory\n')).toBe(
      err('[stderr]\ncat: /srv/b.txt: No such file or directory'),
    )
    expect(err('\n[stderr]\ncat: /srv/a.txt: No such file or directory\n')).not.toBe(
      err('\n[stderr]\nTraceback (most recent call last):\n'),
    )
    expect(err('[stderr]')).toBe('')
  })
})
