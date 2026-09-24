import { describe, expect, it } from 'vitest'
import {
  aggregateDeviations,
  DEVIATION_STATS_SQL,
  type DeviationInput,
  deviationGate,
  REQUESTS_BY_MODEL_SQL,
  toDeviationRows,
} from '../src/index.js'

const rows: DeviationInput[] = [
  { model: 'flash', rule: 'qwen3_coder', parserVersion: '2' },
  { model: 'flash', rule: 'qwen3_coder', parserVersion: '2' },
  { model: 'flash', rule: 'unparsed', parserVersion: '2' },
  { model: 'pro', responseModel: 'pro-2', rule: 'hermes_tool_call', parserVersion: '2' },
]

describe('deviation quality gate', () => {
  it('groups the current camelCase event shape and computes deterministic rates', () => {
    expect(aggregateDeviations(rows, { flash: 10, pro: 5 })).toEqual([
      {
        model: 'flash',
        rule: 'qwen3_coder',
        parserVersion: '2',
        count: 2,
        requests: 10,
        rate: 0.2,
      },
      {
        model: 'pro',
        responseModel: 'pro-2',
        rule: 'hermes_tool_call',
        parserVersion: '2',
        count: 1,
        requests: 5,
        rate: 0.2,
      },
      {
        model: 'flash',
        rule: 'unparsed',
        parserVersion: '2',
        count: 1,
        requests: 10,
        rate: 0.1,
      },
    ])
  })

  it('pools the denominator for equal model ids because neither frozen event carries route', () => {
    const sameNameAcrossRoutes: DeviationInput[] = [
      { model: 'shared', responseModel: 'route-a-v1', rule: 'inline_json', parserVersion: '2' },
      { model: 'shared', responseModel: 'route-b-v1', rule: 'inline_json', parserVersion: '2' },
    ]
    const stats = aggregateDeviations(sameNameAcrossRoutes, { shared: 20 })
    expect(stats.map(({ responseModel, requests, rate }) => ({ responseModel, requests, rate }))).toEqual([
      { responseModel: 'route-a-v1', requests: 20, rate: 0.05 },
      { responseModel: 'route-b-v1', requests: 20, rate: 0.05 },
    ])
  })

  it('keeps an absent response model distinct from an explicit empty response model', () => {
    const stats = aggregateDeviations(
      [
        { model: 'm', rule: 'unparsed', parserVersion: '2' },
        { model: 'm', responseModel: '', rule: 'unparsed', parserVersion: '2' },
      ],
      { m: 2 },
    )
    expect(stats).toHaveLength(2)
  })

  it('fails above the threshold, passes at it, and fails closed without a denominator', () => {
    const known = aggregateDeviations(rows.slice(0, 2), { flash: 10 })
    expect(deviationGate(known, 0.2)).toEqual({ pass: true, offenders: [] })
    expect(deviationGate(known, 0.19).offenders).toEqual(known)
    const unknown = aggregateDeviations([rows[3] as DeviationInput], {})
    expect(unknown[0]).toMatchObject({ requests: 0, rate: 0 })
    expect(deviationGate(unknown, 1)).toEqual({ pass: false, offenders: unknown })
  })

  it('rejects invalid thresholds and denominators', () => {
    expect(() => deviationGate([], Number.NaN)).toThrow(RangeError)
    expect(() => deviationGate([], 1.01)).toThrow(RangeError)
    expect(() => aggregateDeviations(rows, { flash: -1 })).toThrow(RangeError)
    expect(() => aggregateDeviations(rows, { flash: 1.5 })).toThrow(RangeError)
  })

  it('queries frozen fields and converts only the outbound report field to snake_case', () => {
    expect(DEVIATION_STATS_SQL).toContain("json_extract(data, '$.model')")
    expect(DEVIATION_STATS_SQL).toContain("json_extract(data, '$.responseModel')")
    expect(DEVIATION_STATS_SQL).toContain("json_extract(data, '$.parserVersion')")
    expect(DEVIATION_STATS_SQL).not.toContain('$.model.id')
    expect(REQUESTS_BY_MODEL_SQL).toContain("type = 'request/header'")
    expect(toDeviationRows(aggregateDeviations(rows, { flash: 10, pro: 5 }))[0]).toEqual({
      model: 'flash',
      rule: 'qwen3_coder',
      parser_version: '2',
      count: 2,
    })
  })
})
