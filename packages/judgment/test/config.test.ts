import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { resolveJudgeChain, resolveStopConfig, resolveToolConfig } from '../src/config.js'

const native = { route: 'jev', model: 'j', api: 'typesafe-systemone' }
const chat = { route: 'chat', model: 'c', api: 'openai-completions' }
it('auto-selects the only Jev route', () =>
  expect(resolveJudgeChain({}, [native, chat])).toEqual([{ route: 'jev', model: 'j', native: true }]))
it('does not choose an arbitrary model on the sole native route', () =>
  expect(resolveJudgeChain({}, [native, { ...native, model: 'other' }])).toBeNull())
it('uses an explicit model on the sole native route without a route setting', () =>
  expect(resolveJudgeChain({ judge: { model: 'other' } }, [native, { ...native, model: 'other' }])).toEqual([
    { route: 'jev', model: 'other', native: true },
  ]))
it('returns null when nothing is configured', () => expect(resolveJudgeChain({}, [])).toBeNull())
it('does not fall back to a chat model unless chosen', () => {
  expect(resolveJudgeChain({}, [chat])).toBeNull()
  expect(resolveJudgeChain({ judge: { route: 'chat', model: 'c' } }, [chat])).toEqual([
    { route: 'chat', model: 'c', native: false },
  ])
  expect(resolveJudgeChain({ judge: { fallback: { route: 'chat', model: 'c' } } }, [native, chat])).toEqual([
    { route: 'jev', model: 'j', native: true },
  ])
})
it('accepts only one distinct native fallback and leaves ambiguity idle', () => {
  const other = { ...native, route: 'other' }
  expect(resolveJudgeChain({}, [native, other])).toBeNull()
  expect(
    resolveJudgeChain({ judge: { route: 'jev', fallback: { route: 'other', model: 'j' } } }, [native, other]),
  ).toHaveLength(2)
  expect(resolveJudgeChain({ judge: { route: 'missing' } }, [native])).toBeNull()
})
it('requires explicit U2 opt-in', () => {
  expect(resolveStopConfig({})).toEqual({ enabled: false })
  expect(resolveStopConfig({ uses: { stop: { enabled: true } } })).toEqual({ enabled: true })
  expect(resolveStopConfig({ uses: { stop: { enabled: 'true' } } })).toEqual({ enabled: false })
})

it('requires explicit independent find and batch opt-in', () => {
  expect(resolveToolConfig({})).toEqual({ find: false, batch: false })
  expect(resolveToolConfig({ uses: { find: { enabled: true }, batch: { enabled: 'true' } } })).toEqual({
    find: true,
    batch: false,
  })
})

it('publishes title cadence opt-in consistently in both manifests and registers its lifecycle', async () => {
  const { CONFIG_SCHEMA } = await import('../src/config.js')
  const source = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const bundled = JSON.parse(
    readFileSync(
      new URL('../../package-manager/bundled-plugins/judgment/package.json', import.meta.url),
      'utf8',
    ),
  )
  const title = (CONFIG_SCHEMA.properties.uses.properties as Record<string, unknown>).title
  expect(title).toMatchObject({
    additionalProperties: false,
    properties: {
      enabled: { default: false },
      refreshAfterPrompts: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
    },
  })
  expect(source.agnes.plugins[0]?.default).toBe(false)
  for (const manifest of [source, bundled]) {
    const row = manifest.agnes.plugins[0]
    expect(row.apiRange).toBe('^5.20.0')
    expect(row.inject).toContain('sessionWork')
    expect(row.capabilities).toMatchObject({ sessionWork: true, autoTitle: true })
    expect(row.configSchema).toEqual(CONFIG_SCHEMA)
    expect(
      row.capabilities.projections.find(
        (item: { name: string; maxStateBytes: number }) => item.name === 'title.context',
      )?.maxStateBytes,
    ).toBeLessThanOrEqual(262144)
  }
})
