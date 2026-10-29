import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultIds, openTracked, ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, openSession, readTool, toolTurn } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Op = { phase: { kind: string; batch?: { calls: Array<Record<string, unknown>> } } }

const withStatus = (cur: unknown, status: string) => {
  const op = cur as Op
  return {
    ...op,
    phase: {
      ...op.phase,
      batch: { ...op.phase.batch, calls: (op.phase.batch?.calls ?? []).map((call) => ({ ...call, status })) },
    },
  } as never
}

// Several phase edges in one append on the durable adapter: one transaction, the last value in the
// cell, and a store a fresh writer opens without complaint.
describe('transitionChain on SQLite', () => {
  it('commits every step in one transaction and keeps only the last value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-chain-'))
    dirs.push(dir)
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    let commits = 0
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit')
          return (...args: unknown[]) => {
            commits++
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      const registry = new ToolRegistry()
      registry.add(readTool(), { source: 's', trust: 'builtin' })
      const h = await openSession({
        provider: fakeProvider([toolTurn('read', {})]),
        registry,
        storage: counted as never,
      })
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      await h.session.acceptInput()
      await h.session.runInference()
      const head = h.log.lastSeq
      const before = commits
      const plan = (id: string) =>
        h.session.ev('plan.items', { items: [{ id, text: id, status: 'todo' }] }, { register: 'plan.items' })
      const seqs = await h.session.transitionChain([
        { events: [], next: (cur) => withStatus(cur, 'approved') },
        { events: [plan('a')], next: (cur) => withStatus(cur, 'awaiting_approval') },
        { events: [plan('b')], next: (cur) => withStatus(cur, 'approved') },
      ])
      expect(seqs).toEqual([[], [head + 1], [head + 2]])
      expect(commits - before).toBe(1)
      await h.session.transitionChain([
        { events: [], next: (cur) => withStatus(cur, 'awaiting_approval') },
        { events: [], next: (cur) => withStatus(cur, 'approved') },
      ])
      expect(commits - before).toBe(2)
      const rows = await h.log.scan({ fromSeq: head + 1, toSeq: h.log.lastSeq })
      expect(rows.map((row) => row.type)).toEqual(['plan.items', 'plan.items', 'x/core/op-mark'])
      const cell = (await storage.registers('k')).find((row) => row.register === 'op.state')
      expect(cell?.seq).toBe(head + 3)
      expect((cell?.data as Op | undefined)?.phase.batch?.calls[0]?.status).toBe('approved')
      await h.session.close()
      const reopened = await openTracked({
        storage,
        key: 'k',
        writerRunId: 'fresh',
        ttlMs: 60_000,
        ids: defaultIds(() => 0),
        clock: () => 0,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      })
      await reopened.log.close()
    } finally {
      await storage.close()
    }
  })
})
