import { describe, expect, it } from 'vitest'
import { create, MACHINES, read, reset, seed, snapshot, transition, update } from '../domain.mjs'

const NOW = Date.parse('2026-10-21T08:00:00Z')
const HOUR = 3_600_000

function memoryStore() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: (key: string) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    set: (key: string, value: unknown) => void rows.set(key, structuredClone(value)),
    delete: (key: string) => void rows.delete(key),
    transaction: <T>(work: () => T) => work(),
  }
}

describe('DevBoard state machines', () => {
  it.each([
    ['requirement', 'REQ-006', 'REFINED'],
    ['requirement', 'REQ-005', 'RAW'],
    ['requirement', 'REQ-005', 'ASSIGNED'],
    ['task', 'TASK-008', 'PENDING'],
    ['task', 'TASK-010', 'IN_PROGRESS'],
    ['intervention', 'HI-003', 'OPEN'],
  ])('allows %s %s → %s', (kind, id, to) => {
    const state = seed(NOW)
    expect(transition(state, { kind, id, to, by: '协调员' }, NOW).state).toBe(to)
  })

  it.each([
    ['requirement', 'REQ-006', 'COMPLETED', 'RAW'],
    ['task', 'TASK-001', 'IN_PROGRESS', 'COMPLETED'],
    ['task', 'TASK-007', 'COMPLETED', 'PENDING'],
    ['intervention', 'HI-004', 'OPEN', 'RESOLVED'],
    ['intervention', 'HI-001', 'RESOLVED', 'OPEN'],
  ])('refuses %s %s → %s', (kind, id, to, from) => {
    const state = seed(NOW)
    expect(() => transition(state, { kind, id, to, by: '协调员' }, NOW)).toThrow(
      `非法状态流转：${from} 不可流转至 ${to}`,
    )
  })

  it('never offers EXPIRED as a stored target and records history', () => {
    for (const targets of Object.values(MACHINES.intervention)) expect(targets).not.toContain('EXPIRED')
    const state = seed(NOW)
    const item = transition(state, { kind: 'intervention', id: 'HI-002', to: 'CLAIMED', by: '管理者' }, NOW)
    expect(item).toMatchObject({ state: 'CLAIMED', handler: '管理者' })
    expect(item.history.at(-1)).toMatchObject({ from: 'EXPIRED', to: 'CLAIMED', by: '管理者' })
    transition(
      state,
      { kind: 'intervention', id: 'HI-002', to: 'RESOLVED', by: '管理者', note: '同步验签' },
      NOW,
    )
    expect(item.resolution).toBe('同步验签')
  })
})

describe('requirement linkage', () => {
  it('moves ASSIGNED → IN_PROGRESS on the first started task and completes when all tasks finish', () => {
    const state = seed(NOW)
    const req = () => state.requirements.find((r: { id: string }) => r.id === 'REQ-004')
    expect(req().state).toBe('ASSIGNED')
    transition(state, { kind: 'task', id: 'TASK-013', to: 'IN_PROGRESS', by: 'x' }, NOW)
    expect(req().state).toBe('IN_PROGRESS')
    transition(state, { kind: 'task', id: 'TASK-013', to: 'COMPLETED', by: 'x' }, NOW)
    transition(state, { kind: 'task', id: 'TASK-014', to: 'CANCELLED', by: 'x' }, NOW)
    expect(req().state).toBe('IN_PROGRESS')
    transition(state, { kind: 'task', id: 'TASK-015', to: 'CANCELLED', by: 'x' }, NOW)
    expect(req().state).toBe('COMPLETED')
    expect(req().history.at(-1)).toMatchObject({ by: '系统联动', to: 'COMPLETED' })
  })
})

describe('overdue derivation and ordering', () => {
  it('derives EXPIRED from dueAt and lists overdue first, then newest first', () => {
    const view = snapshot(seed(NOW), NOW)
    expect(view.interventions[0]).toMatchObject({ id: 'HI-002', state: 'EXPIRED' })
    const rest = view.interventions.slice(1).map((i: { createdAt: string }) => Date.parse(i.createdAt))
    expect(rest).toEqual([...rest].sort((a, b) => b - a))
    expect(view.counts.intervention).toMatchObject({ EXPIRED: 1, OPEN: 2, CLAIMED: 1, RESOLVED: 2 })
    // A fresh request is OPEN until its deadline passes.
    const state = seed(NOW)
    create(
      state,
      {
        kind: 'intervention',
        type: 'RELEASE_APPROVAL',
        entity: { kind: 'task', id: 'TASK-015' },
        ask: '可以发布吗？',
        dueInHours: 1,
      },
      NOW,
    )
    expect(snapshot(state, NOW).interventions.find((i: { id: string }) => i.id === 'HI-007').state).toBe(
      'OPEN',
    )
    expect(snapshot(state, NOW + 2 * HOUR).interventions[0].state).toBe('EXPIRED')
  })

  it('seeds every state and type', () => {
    const view = snapshot(seed(NOW), NOW)
    for (const kind of ['requirement', 'task', 'intervention'] as const)
      for (const [name, n] of Object.entries(view.counts[kind]))
        expect(n, `${kind} ${name}`).toBeGreaterThan(0)
    expect(new Set(view.tasks.map((t: { type: string }) => t.type)).size).toBe(5)
    expect(new Set(view.interventions.map((i: { type: string }) => i.type)).size).toBe(5)
  })
})

describe('store persistence', () => {
  it('reads an empty read-only store as the seed without writing (query and effect preparation)', () => {
    // Query services and effect prepare() receive a non-writable store; a write is CAPABILITY_DENIED.
    const store = {
      ...memoryStore(),
      set: () => {
        throw new Error('CAPABILITY_DENIED')
      },
      delete: () => {
        throw new Error('CAPABILITY_DENIED')
      },
    }
    const view = snapshot(read(store, NOW), NOW)
    expect(view.requirements).toHaveLength(6)
    expect(view.interventions[0]).toMatchObject({ id: 'HI-002', state: 'EXPIRED' })
    expect(String(read(store, NOW).revision)).toBe('1')
    expect(store.rows.size).toBe(0)
  })

  it('persists the seed on the first write, writes through one path and resets to the seed', () => {
    const store = memoryStore()
    expect(read(store, NOW).revision).toBe(1)
    expect(store.rows.size).toBe(0)
    const { revision, result } = update(
      store,
      (s: unknown) => create(s, { kind: 'requirement', title: '新需求', by: '研发协调员' }, NOW),
      NOW,
    )
    expect(revision).toBe(2)
    expect(result).toMatchObject({ id: 'REQ-007', state: 'RAW' })
    expect(read(store, NOW).requirements).toHaveLength(7)
    expect(() =>
      create(read(store, NOW), { kind: 'task', requirementId: 'REQ-404', title: 'x', type: 'TESTING' }),
    ).toThrow('未找到 REQ-404')
    expect(reset(store, NOW).revision).toBe(3)
    const fresh = read(store, NOW)
    expect(fresh.requirements).toHaveLength(6)
    expect(fresh.revision).toBe(3)
  })
})
