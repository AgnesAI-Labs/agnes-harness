import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Fixture, findFixtureFiles, runFixtureFiles, runFixtureLine } from '../tools/conformance-core.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const ENVELOPE = `${fixtures}events/envelope.jsonl`
const I1_TYPES = `${fixtures}events/i1-types.jsonl`
const I2_TYPES = `${fixtures}events/i2-types.jsonl`
const REQUEST_MEDIA = `${fixtures}events/request-media.jsonl`
const METHODS = `${fixtures}methods/i1.jsonl`
const TOOLDEF = `${fixtures}tooldef/tooldef.jsonl`
const HOOKS = `${fixtures}hooks/hooks.jsonl`
const SLOTS = `${fixtures}slots/slots.jsonl`
const TASK21 = `${fixtures}configs/task21.jsonl`
const TASK20 = `${fixtures}configs/task20.jsonl`
const PRESET = `${fixtures}configs/preset.jsonl`
const MODEL = `${fixtures}model/model.jsonl`
const MIGRATE = `${fixtures}migrate/example-x-core.jsonl`
const SEQUENCES = `${fixtures}sequences/meta-quiescence.jsonl`
const WORKER_RUNTIME_TARGET = `${fixtures}worker/runtime-target.jsonl`

// Counts are pinned to their measured values rather than a lower bound. The fixtures are now also the
// data source for the ajv comparison (ajv-parity.test.ts reads these three jsonl files directly), and
// a loose lower bound — it used to be `toBeGreaterThanOrEqual(31)` against an actual 62 — would let
// half the fixtures be deleted without this assertion going red. The failure would instead surface as
// byId() throwing "fixture not found" in the comparison, a message far from the cause.
// Pinning the count per file means a deleted or missing row names the file directly.
const COUNTS = {
  envelope: 6,
  i1Types: 23,
  i2Types: 39,
  requestMedia: 12,
  methods: 65,
  tooldef: 3,
  hooks: 34,
  slots: 8,
  model: 8,
  preset: 143,
  task20: 211,
  task21: 178,
  migrate: 1,
  sequences: 4,
  workerRuntimeTarget: 8,
} as const
const ALL_FIXTURE_COUNT = 1391

describe('conformance fixtures', () => {
  it('all checked-in fixtures across the complete fixture tree pass', () => {
    const r = runFixtureFiles(findFixtureFiles(fixtures))
    expect(r.failed).toEqual([])
    expect(r.total).toBe(ALL_FIXTURE_COUNT)
    // Exactly one row is skipped: the migrate example, whose migration nothing registers while
    // CURRENT_V is 1. A skip counter nobody reads is a way to make skipping look like passing, so
    // the number is pinned rather than merely returned.
    expect(r.skipped).toBe(1)
  })
  it('each fixture file holds exactly the expected number of rows', () => {
    expect(runFixtureFiles([ENVELOPE]).total, 'events/envelope.jsonl').toBe(COUNTS.envelope)
    expect(runFixtureFiles([I1_TYPES]).total, 'events/i1-types.jsonl').toBe(COUNTS.i1Types)
    expect(runFixtureFiles([I2_TYPES]).total, 'events/i2-types.jsonl').toBe(COUNTS.i2Types)
    expect(runFixtureFiles([REQUEST_MEDIA]).total, 'events/request-media.jsonl').toBe(COUNTS.requestMedia)
    expect(runFixtureFiles([METHODS]).total, 'methods/i1.jsonl').toBe(COUNTS.methods)
    expect(runFixtureFiles([TOOLDEF]).total, 'tooldef/tooldef.jsonl').toBe(COUNTS.tooldef)
    expect(runFixtureFiles([HOOKS]).total, 'hooks/hooks.jsonl').toBe(COUNTS.hooks)
    expect(runFixtureFiles([SLOTS]).total, 'slots/slots.jsonl').toBe(COUNTS.slots)
    expect(runFixtureFiles([TASK21]).total, 'configs/task21.jsonl').toBe(COUNTS.task21)
    expect(runFixtureFiles([TASK20]).total, 'configs/task20.jsonl').toBe(COUNTS.task20)
    expect(runFixtureFiles([PRESET]).total, 'configs/preset.jsonl').toBe(COUNTS.preset)
    expect(runFixtureFiles([MODEL]).total, 'model/model.jsonl').toBe(COUNTS.model)
    expect(runFixtureFiles([MIGRATE]).total, 'migrate/example-x-core.jsonl').toBe(COUNTS.migrate)
    expect(runFixtureFiles([SEQUENCES]).total, 'sequences/meta-quiescence.jsonl').toBe(COUNTS.sequences)
    expect(runFixtureFiles([WORKER_RUNTIME_TARGET]).total, 'worker/runtime-target.jsonl').toBe(
      COUNTS.workerRuntimeTarget,
    )
  })
  it('a wrong expectation fails', () => {
    const r = runFixtureLine({ id: 'x', kind: 'valid', target: 'event', payload: { seq: 1 } })
    expect(r.pass).toBe(false)
  })
  it('maps invalid params to caller error and invalid results to server error', () => {
    const params = runFixtureLine({
      id: 'bad-params',
      kind: 'invalid',
      target: 'method',
      name: '_agnes/v1/session.detach',
      side: 'params',
      payload: { sessionId: 1 },
      expect: { errorCode: -32602 },
    })
    const result = runFixtureLine({
      id: 'bad-result',
      kind: 'invalid',
      target: 'method',
      name: '_agnes/v1/session.detach',
      side: 'result',
      payload: { ok: true },
      expect: { errorCode: -32603, dataCode: 'RESULT_INVALID' },
    })
    const resultBlamingCaller = runFixtureLine({
      id: 'bad-result-wrong-code',
      kind: 'invalid',
      target: 'method',
      name: '_agnes/v1/session.detach',
      side: 'result',
      payload: { ok: true },
      expect: { errorCode: -32602 },
    })

    expect(params.pass).toBe(true)
    expect(result.pass).toBe(true)
    expect(resultBlamingCaller.pass).toBe(false)
  })
})

// ── Every kind:'invalid' fixture row must carry a non-empty `expect` ────────────────────────
// The `const e = f.expect ?? {}` fallback in tools/conformance-core.ts means a negative sample with no
// `expect` passes as long as validation **fails**, regardless of whether the reported error is the one
// it meant to provoke. All 29 negative samples then present were given an `expect`, but the fallback
// itself was left alone, so newly added negative samples could still silently degrade to "any
// non-empty result counts as a pass". This guard turns that clean-up into a rule that cannot be
// reverted.
// (The fallback in conformance-core.ts is deliberately not changed: the runner has to accept
// third-party and ad-hoc fixtures, and making the fallback throw would turn a library function into
// something that only serves this repo's fixtures. The rule applies to fixtures, so the guard sits on
// the fixture side.)
describe('every invalid fixture row carries a non-empty expect', () => {
  it.each([
    ['events/envelope.jsonl', ENVELOPE],
    ['events/i1-types.jsonl', I1_TYPES],
    ['events/i2-types.jsonl', I2_TYPES],
    ['events/request-media.jsonl', REQUEST_MEDIA],
    ['methods/i1.jsonl', METHODS],
    ['tooldef/tooldef.jsonl', TOOLDEF],
    ['hooks/hooks.jsonl', HOOKS],
    ['slots/slots.jsonl', SLOTS],
    ['model/model.jsonl', MODEL],
    ['configs/preset.jsonl', PRESET],
    ['configs/task20.jsonl', TASK20],
    ['configs/task21.jsonl', TASK21],
    ['worker/runtime-target.jsonl', WORKER_RUNTIME_TARGET],
  ])('%s', (rel, file) => {
    const offenders: string[] = []
    let invalidRows = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const f = JSON.parse(line) as Fixture
      if (f.kind !== 'invalid') continue
      invalidRows++
      const e = f.expect
      if (!e || Object.keys(e).length === 0) offenders.push(`${f.id}: missing/empty expect`)
      else if (e.errorCode === undefined && e.dataCode === undefined && e.key === undefined)
        offenders.push(`${f.id}: expect has no assertable field`)
    }
    expect(offenders, rel).toEqual([])
    // Zombie-guard check: the file really does contain negative samples, otherwise the toEqual([])
    // above is vacuously true.
    expect(
      invalidRows,
      `${rel} has no kind:'invalid' rows, which makes this guard a vacuously true assertion`,
    ).toBeGreaterThan(0)
  })
})
