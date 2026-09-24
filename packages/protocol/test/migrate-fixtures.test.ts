import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_V, listMigrations, normalize, registerMigration } from '../src/index.js'
// resetMigrations is deliberately withheld from the root surface because it wipes a process-wide
// Map. Test back doors come from the module, not from the package surface.
import { resetMigrations } from '../src/migrate.js'
import { type Fixture, runFixtureFiles, runFixtureLine } from '../tools/conformance-core.js'

type MigrateFixture = Fixture & { type: string; fromV: number; before: unknown; after: unknown }
const EXAMPLE = new URL('../fixtures/migrate/example-x-core.jsonl', import.meta.url)
const load = (): MigrateFixture[] =>
  readFileSync(EXAMPLE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MigrateFixture)

const covered = (fixtures: MigrateFixture[], m: { type: string; fromV: number }) =>
  fixtures.some((f) => f.type === m.type && f.fromV === m.fromV)

describe('migrate fixtures', () => {
  afterEach(() => {
    resetMigrations()
  })

  // At CURRENT_V = 1 the real registry is empty, so a loop over it would be vacuously true and the
  // gate would prove nothing for as long as that stays the case. So the gate is exercised directly:
  // register a migration with no fixture and watch the coverage check refuse it, then register one
  // that has a fixture and watch it accept.
  it('the coverage gate refuses a migration with no fixture', () => {
    const fixtures = load()
    // (a) whatever is really registered must be covered
    for (const m of listMigrations()) expect(covered(fixtures, m), `${m.type}@${m.fromV}`).toBe(true)
    // (b) an uncovered migration must make the same predicate false, by name
    registerMigration('x/core/uncovered', 0, (d) => d)
    expect(
      listMigrations()
        .filter((m) => !covered(fixtures, m))
        .map((m) => `${m.type}@${m.fromV}`),
    ).toEqual(['x/core/uncovered@0'])
    // (c) and a covered one must not be reported
    registerMigration('x/core/example', 0, (d) => ({ ...(d as object), migrated: true }))
    expect(
      listMigrations()
        .filter((m) => !covered(fixtures, m))
        .map((m) => `${m.type}@${m.fromV}`),
    ).toEqual(['x/core/uncovered@0'])
  })

  it('the example fixture round-trips through a temporary migration', () => {
    registerMigration('x/core/example', 0, (d) => ({ ...(d as object), migrated: true }))
    for (const f of load()) {
      const r = runFixtureLine(f)
      expect(r.pass, `${f.id}: ${r.detail ?? ''}`).toBe(true)
      expect(r.skipped, `${f.id} must not be skipped once its migration is registered`).toBeFalsy()
    }
  })

  // The migration is registered but does the wrong thing: the fixture has to catch it, otherwise
  // the round-trip case above only proves that normalize() ran.
  it('a migration that produces the wrong data fails its fixture', () => {
    registerMigration('x/core/example', 0, (d) => ({ ...(d as object), migrated: false }))
    const r = runFixtureLine(load()[0] as MigrateFixture)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('migrated')
  })

  // The skip path, walked on purpose: with nothing registered the runner must report the row as
  // skipped and not as passed, or an unregistered migration would read as a green fixture.
  it('an unregistered migration is skipped, not silently passed', () => {
    const r = runFixtureLine(load()[0] as MigrateFixture)
    expect(r.skipped).toBe(true)
    expect(runFixtureFiles([fileURLToPath(EXAMPLE)])).toMatchObject({ total: 1, skipped: 1, failed: [] })
  })

  it('normalize carries the fixture forward exactly one version', () => {
    registerMigration('x/core/example', 0, (d) => ({ ...(d as object), migrated: true }))
    const f = load()[0] as MigrateFixture
    const out = normalize({
      seq: 1,
      ts: '2026-09-07T00:00:00Z',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: f.type,
      data: f.before,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      v: f.fromV,
      ignorable: true,
    } as never)
    expect(out.data).toEqual(f.after)
    expect(out.v).toBe(Math.min(f.fromV + 1, CURRENT_V))
  })
})
