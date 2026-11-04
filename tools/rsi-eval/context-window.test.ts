import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { afterEach, describe, expect, it } from 'vitest'
import { createCompactionThreshold } from '../../packages/extension-api/src/compaction-engine.js'
import { aghProfile, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from './agh/run-agh.js'
import { readConfig } from './prime/run-prime.js'
import type { RunConfig } from './types.js'

const cfg: RunConfig = {
  provider: 'eval',
  api: 'anthropic-messages',
  upstream: 'https://api.example.test',
  model: 'model-x',
  keyEnv: 'RSI_TEST_API_KEY',
  prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  proxyPort: 4555,
  sessionTimeoutMs: 20_000,
}
const declared = (c: RunConfig) =>
  (
    aghProfile(c, 'r') as {
      provider: { routes: { models: { contextWindow: number; maxTokens: number }[] }[] }
    }
  ).provider.routes[0]?.models[0]

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the declared context window', () => {
  it('is 200,000 and 8,192 output tokens when the run config names none, as before', () => {
    expect(declared(cfg)).toMatchObject({ contextWindow: 200_000, maxTokens: 8_192 })
    expect([DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS]).toEqual([200_000, 8_192])
  })

  it('comes from the run config when it names one', () => {
    expect(declared({ ...cfg, contextWindow: 64_000, maxOutputTokens: 4_096 })).toMatchObject({
      contextWindow: 64_000,
      maxTokens: 4_096,
    })
  })

  it('must be a positive integer in the run config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsi-window-'))
    dirs.push(dir)
    const write = (extra: object) => {
      const file = join(dir, 'c.json')
      writeFileSync(file, JSON.stringify({ ...cfg, ...extra }))
      return file
    }
    expect(readConfig(write({ contextWindow: 64_000 })).contextWindow).toBe(64_000)
    expect(() => readConfig(write({ contextWindow: 0 }))).toThrow(/contextWindow/)
    expect(() => readConfig(write({ maxOutputTokens: 1.5 }))).toThrow(/maxOutputTokens/)
  })
})

// The host's own numbers, read from its code, for the README: with a 64k window it compacts.
describe('when the host compacts', () => {
  const { reserveTokens, keepRecentTokens } = presetDefaults().compaction

  it('reserves 16,384 tokens and keeps at most 20,000 recent ones by default', () => {
    expect({ reserveTokens, keepRecentTokens }).toEqual({ reserveTokens: 16_384, keepRecentTokens: 20_000 })
  })

  it('compacts once the context is past the window minus the reserve: 47,616 tokens for a 64k window', () => {
    const threshold = createCompactionThreshold()
    const at = (contextTokens: number) => threshold({ contextTokens, contextWindow: 64_000, reserveTokens })
    expect(at(47_616)).toBe(false)
    expect(at(47_617)).toBe(true)
    // The old declared window: past 183,616 tokens, which the first evaluation's runs never reached.
    expect(
      createCompactionThreshold()({ contextTokens: 183_616, contextWindow: 200_000, reserveTokens }),
    ).toBe(false)
  })

  it('waits once, by at most half the reserve, while the prompt cache is warm', () => {
    const threshold = createCompactionThreshold()
    const warm = { cacheRead: 9, input: 1 }
    const at = (contextTokens: number) =>
      threshold({ contextTokens, contextWindow: 64_000, reserveTokens, cache: warm })
    expect(at(47_616 + 8_192)).toBe(false)
    expect(at(47_616 + 8_192)).toBe(true)
    expect(
      createCompactionThreshold()({
        contextTokens: 47_616 + 8_193,
        contextWindow: 64_000,
        reserveTokens,
        cache: warm,
      }),
    ).toBe(true)
  })
})
