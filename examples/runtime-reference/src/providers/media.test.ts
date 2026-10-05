import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runMediaContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/media.js'
import { createMediaContractFixture } from '../../../../packages/extension-api/testkit/runtime/contracts/media-fixture.js'
import { SCENARIOS } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import { createReferenceMediaFactory } from './media.js'

describe('reference media provider contract', () => {
  it.each(SCENARIOS)('%s', async (scenario) => {
    const result = await runMediaContractScenario(scenario, () =>
      createMediaContractFixture((d) => createReferenceMediaFactory(d)),
    )
    expect(result.providerDigest).toBe('f'.repeat(64))
  })
  it('keeps the reference independent of the default sources', () => {
    const normalized = (text: string) =>
      new Set(
        text
          .split('\n')
          .map((line) => line.replace(/\s/g, ''))
          .filter(Boolean),
      )
    const load = (paths: readonly string[]) =>
      paths.map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
    const reference = load(['./media.ts'])
    const defaults = load([
      '../../../../packages/core/src/runtime/providers/media.ts',
      ...['continuation', 'identity', 'legacy-bridge', 'plan', 'resolve', 'verify'].map(
        (name) => `../../../../packages/core/src/runtime/media/${name}.ts`,
      ),
    ])
    expect(reference).not.toMatch(
      /from\s+['"][^'"]*(?:@agnes\/core|packages\/core|orchestrator|request-media|auxiliary-vision)[^'"]*['"]/,
    )
    const a = normalized(reference)
    const b = normalized(defaults)
    expect([...a].filter((line) => b.has(line)).length / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  })
})
