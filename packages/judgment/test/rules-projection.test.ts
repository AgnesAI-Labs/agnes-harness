import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createRulesProjection, ruleIdentity, sessionHash } from '../src/uses/rules-projection.js'

const owner = 'plugin/524280817e87343c'
const event = (type: string, data: unknown, origin = 'system', trust = 'trusted') =>
  ({ seq: 1, type, data, origin, trust, actor: { id: 'human', role: 'user' } }) as any
const start = (key = 's', extra = {}) => event('session/start', { key, ...extra })
const version = 'a'.repeat(64)
const mark = (key = 's') =>
  event(
    `x/${owner}/rules.reminded`,
    {
      rulesVersion: version,
      tool: 'exec',
      identity: ruleIdentity(sessionHash(key), version, 'exec'),
    },
    `ext:${owner}`,
    'untrusted',
  )
it('folds only a trusted native start, including principal actors and delegation-only children', () => {
  const p = createRulesProjection(owner)
  expect(p.init().sessionHash).toBeNull()
  expect(p.apply(p.init(), start())).toMatchObject({
    sessionHash: createHash('sha256').update('s').digest('hex'),
    child: false,
  })
  for (const extra of [{ parent: null }, { delegation: {} }, { fork: {} }])
    expect(p.apply(p.init(), start('s', extra)).child).toBe(true)
  for (const row of [
    event('session/start', { key: 's' }, 'principal'),
    event('session/start', { key: 's' }, 'system', 'untrusted'),
    event('session/start', {}),
  ])
    expect(p.apply(p.init(), row).sessionHash).toBeNull()
})
it('persists hash-only own markers, rejects forgeries and resets inherited identities on restart', () => {
  const p = createRulesProjection(owner),
    initial = p.apply(p.init(), start())
  const state = p.apply(initial, mark())
  expect(state.identities).toEqual([mark().data.identity])
  expect(JSON.stringify(state)).not.toContain('exec')
  expect(p.apply(state, mark())).toBe(state)
  for (const row of [
    mark('other'),
    { ...mark(), origin: 'system' },
    { ...mark(), data: { ...mark().data, extra: 'private' } },
  ])
    expect(p.apply(initial, row)).toBe(initial)
  const replay = JSON.parse(JSON.stringify([start(), mark()])).reduce(p.apply, p.init())
  expect(replay).toEqual(state)
  expect(p.apply(replay, start('child', { delegation: {} }))).toMatchObject({ identities: [], child: true })
})
it('saturates without evicting durable reminders', () => {
  const p = createRulesProjection(owner)
  const state = {
    ...p.apply(p.init(), start()),
    identities: Array.from({ length: 2048 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')),
  }
  expect(p.apply(state, mark())).toBe(state)
})
it('reconstructs durable reminders through the real Core registry after owner disposal and a cold restart', async () => {
  const { ProjectionRegistry } = await import('../../core-ledger/src/project/named.js')
  const { adaptProjection } = await import('../../host-extensions/src/ext-host/projections.js')
  const definition = createRulesProjection(owner)
  const adapted = adaptProjection(owner, definition, {
    name: definition.name,
    inputEventTypes: definition.inputEventTypes!,
    maxStateBytes: definition.maxStateBytes!,
  })
  const ledger = [start(), mark()].map((row, index) => ({
    ...row,
    seq: index + 1,
    id: `durable-${index}`,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { id: 'human', org: 'test', role: 'user', deptPath: [], attrs: {} },
  }))
  const before = new ProjectionRegistry()
  const dispose = before.register(adapted, { owner })
  const initial = before.snapshotOne('s', `${owner}/rules.reminders`, ledger as any, 2)
  expect(initial).toMatchObject({ state: { identities: [mark().data.identity] }, stateVersion: 1 })
  dispose()
  expect(before.snapshotOne('s', `${owner}/rules.reminders`, ledger as any, 2)).toEqual({
    error: 'unavailable',
  })
  const after = new ProjectionRegistry()
  after.register(adapted, { owner })
  expect(after.snapshotOne('s', `${owner}/rules.reminders`, JSON.parse(JSON.stringify(ledger)), 2)).toEqual(
    initial,
  )
})
it('accepts reminder markers only for public Core names', () => {
  const p = createRulesProjection(owner),
    state = p.apply(p.init(), start())
  for (const tool of ['1tool', 'bad.name', 'bad:tool', 'a'.repeat(65)]) {
    const marker = mark()
    marker.data = { rulesVersion: version, tool, identity: ruleIdentity(sessionHash('s'), version, tool) }
    expect(p.apply(state, marker)).toBe(state)
  }
})
