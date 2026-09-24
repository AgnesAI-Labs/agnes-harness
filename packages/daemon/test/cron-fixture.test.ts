import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nextRunAt } from '../src/jobs/schedule.js'

type Fixture = {
  expr: string
  tz?: string
  from: string
  expectNext: string
  skip?: boolean
  reason?: string
}

const fixtures = readFileSync(new URL('../fixtures/cron-clock.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Fixture)

describe('cron clock fixtures', () => {
  it('keeps at least 100 cases and a success rate of at least 99%', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(100)
    expect(fixtures.filter((fixture) => fixture.skip).length).toBeLessThanOrEqual(1)
    let passed = 0
    for (const fixture of fixtures) {
      if (fixture.skip) {
        expect(fixture.reason).toBeTruthy()
        passed++
        continue
      }
      const actual = nextRunAt(
        { kind: 'cron', expr: fixture.expr, ...(fixture.tz ? { tz: fixture.tz } : {}) },
        Date.parse(fixture.from),
      )
      if (actual === Date.parse(fixture.expectNext)) passed++
    }
    expect(passed / fixtures.length).toBeGreaterThanOrEqual(0.99)
  })
})
