import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type ConformanceFixture,
  loadConformanceFixtures,
  matchTypes,
  runConformance,
  scenarioMatrix,
} from '../src/index.js'
import { FakeAdapter, fakeModel } from '../testkit/index.js'

const fixtureDir = new URL('../fixtures/conformance/', import.meta.url)
const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
const all = protocols.flatMap((protocol) =>
  loadConformanceFixtures(readFileSync(new URL(`${protocol}.jsonl`, fixtureDir), 'utf8')),
)
const signal = () => new AbortController().signal

const adapter = (api = 'openai-completions', route = 'gw') =>
  new FakeAdapter({
    id: 'fake',
    routes: [{ route, api, baseUrl: 'https://gw.invalid' }],
    models: { [route]: [fakeModel({ id: 'm', route, api })] },
    script: (req) => {
      const text = JSON.stringify(req.messages)
      if (text.length > 3_000_000)
        return [{ type: 'error', reason: 'error', code: 'OVERFLOW', message: 'too large', retryable: false }]
      const usage = {
        type: 'usage' as const,
        tokens: { input: 1, output: 1, cacheRead: req.system.length === 8_000 ? 2 : 0, cacheWrite: 0 },
        creditSource: 'estimated' as const,
      }
      if (req.tools.length > 0) {
        const count = text.includes('a.md and b.md') ? 1 : 1
        return [
          ...Array.from({ length: count }, (_, ordinal) => ({
            type: 'toolcall_end' as const,
            call: { toolUseId: `c${ordinal}`, name: req.tools[0]?.name ?? 'read', args: {}, ordinal },
          })),
          usage,
          { type: 'done' as const, reason: 'toolUse' as const },
        ]
      }
      return [{ type: 'text_delta', delta: 'ok' }, usage, { type: 'done', reason: 'stop' }]
    },
  })

describe('gateway conformance fixtures', () => {
  it('contains every protocol/scenario pair exactly once', () => {
    const keys = all.map((fixture) => `${fixture.protocol}/${fixture.scenario}`)
    expect(all).toHaveLength(24)
    expect(new Set(keys).size).toBe(24)
    expect(keys.sort()).toEqual(
      scenarioMatrix()
        .map((entry) => `${entry.protocol}/${entry.scenario}`)
        .sort(),
    )
  })

  it('loads JSONL and rejects malformed input instead of silently dropping it', () => {
    expect(loadConformanceFixtures(`\n${JSON.stringify(all[0])}\n`)).toEqual([all[0]])
    expect(() => loadConformanceFixtures('{')).toThrow(SyntaxError)
  })
})

describe('matchTypes', () => {
  it('matches zero or many repetitions without accepting missing, extra, or reordered events', () => {
    expect(
      matchTypes(['text_delta*', 'toolcall_end', 'usage', 'done'], ['toolcall_end', 'usage', 'done']),
    ).toBe(true)
    expect(
      matchTypes(
        ['thinking_delta*', 'text_delta*', 'usage', 'done'],
        ['thinking_delta', 'text_delta', 'text_delta', 'usage', 'done'],
      ),
    ).toBe(true)
    expect(matchTypes(['usage', 'done'], ['done'])).toBe(false)
    expect(matchTypes(['usage', 'done'], ['usage', 'text_delta', 'done'])).toBe(false)
    expect(matchTypes(['usage', 'done'], ['done', 'usage'])).toBe(false)
  })
})

describe('runConformance', () => {
  it('runs one protocol, expands fill markers, evaluates predicates, cancellation, and reports diffs', async () => {
    const fake = adapter()
    const fixtures = all.filter((fixture) => fixture.protocol === 'openai-completions')
    const report = await runConformance(fake, 'gw', 'm', fixtures, { signal: signal() })

    expect(report.total).toBe(8)
    expect(report.missingScenarios).toEqual([])
    expect(report.results.find((result) => result.scenario === 'tool_call')?.pass).toBe(true)
    expect(report.results.find((result) => result.scenario === 'parallel_tools')).toMatchObject({
      pass: false,
      types: ['toolcall_end', 'usage', 'done'],
    })
    expect(report.results.find((result) => result.scenario === 'parallel_tools')?.detail).toContain(
      'toolcall_count_at_least',
    )
    expect(report.results.find((result) => result.scenario === 'cancel')).toMatchObject({
      pass: true,
      types: ['text_delta', 'error'],
    })
    expect(
      fake.calls.find((call) => {
        const message = call.req.messages[0]
        const content = message?.role === 'user' ? message.content[0] : undefined
        return content?.type === 'text' && content.text.length === 3_000_000
      }),
    ).toBeDefined()
    expect(fake.calls.find((call) => call.req.system.length === 8_000)).toBeDefined()
  })

  it('reports missing scenarios only for protocols represented in the supplied fixture set', async () => {
    const fixtures = all.filter(
      (fixture) => fixture.protocol === 'openai-completions' && fixture.scenario !== 'vision',
    )
    const report = await runConformance(adapter(), 'gw', 'm', fixtures, { signal: signal() })
    expect(report.missingScenarios).toEqual([{ protocol: 'openai-completions', scenario: 'vision' }])
  })

  it('fails closed without calling stream when the gateway route or model is unavailable', async () => {
    const fixture = all.find((candidate) => candidate.id === 'oc-tool_call') as ConformanceFixture
    const wrongRoute = adapter('openai-completions', 'other')
    const noRoute = await runConformance(wrongRoute, 'gw', 'm', [fixture], { signal: signal() })
    expect(noRoute.results[0]).toMatchObject({ pass: false, types: [] })
    expect(noRoute.results[0]?.detail).toContain('route unavailable')
    expect(wrongRoute.calls).toEqual([])

    const noModel = new FakeAdapter({
      id: 'empty',
      routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
      models: { gw: [] },
    })
    const missingModel = await runConformance(noModel, 'gw', 'm', [fixture], { signal: signal() })
    expect(missingModel.results[0]?.detail).toContain('model unavailable')
    expect(noModel.calls).toEqual([])
  })

  it('captures protocol mismatch and thrown gateway failures as failed results', async () => {
    const anthropic = all.find((candidate) => candidate.id === 'am-tool_call') as ConformanceFixture
    const mismatchAdapter = adapter()
    const mismatch = await runConformance(mismatchAdapter, 'gw', 'm', [anthropic], { signal: signal() })
    expect(mismatch.results[0]?.detail).toContain('protocol mismatch')
    expect(mismatchAdapter.calls).toEqual([])

    const fixture = all.find((candidate) => candidate.id === 'oc-tool_call') as ConformanceFixture
    const unavailable = new FakeAdapter({
      id: 'down',
      routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid' }],
      models: { gw: [fakeModel({ id: 'm', route: 'gw' })] },
      script: () => {
        throw new Error('gateway secret must not be copied into reports')
      },
    })
    const failed = await runConformance(unavailable, 'gw', 'm', [fixture], { signal: signal() })
    expect(failed.results[0]).toMatchObject({ pass: false, detail: 'threw Error', types: [] })
    expect(failed.results[0]?.detail).not.toContain('gateway secret')
  })
})
