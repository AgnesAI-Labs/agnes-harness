import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DECODE_FIXTURE_FILES, type DecodeFixture, loadDecodeFixtures } from '../src/decode/fixtures.js'
import { PARSER_VERSION, type RULES, RULES_DIGEST } from '../src/decode/rules/index.js'

type RuleId = (typeof RULES)[number]['id'] | 'lenient_json'
type RuleLock = {
  parserVersion: string
  rulesDigest: string
  sourceDigest: string
  fixtureDigest: string
  sampleCoverage: Partial<Record<RuleId, string | null>>
}

const lock = JSON.parse(
  readFileSync(new URL('../fixtures/decode/RULES.lock', import.meta.url), 'utf8'),
) as RuleLock

const semanticSources = [
  'src/decode/hash-sha256.ts',
  'src/decode/machine.ts',
  'src/decode/types.ts',
  'src/decode/rules/anthropic-invoke.ts',
  'src/decode/rules/hermes-tool-call.ts',
  'src/decode/rules/index.ts',
  'src/decode/rules/inline-json.ts',
  'src/decode/rules/lenient-json.ts',
  'src/decode/rules/qwen3-coder.ts',
  'src/decode/rules/think-tag.ts',
] as const

function digestFiles(paths: readonly string[]): string {
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path).update('\0')
    hash.update(readFileSync(new URL(`../${path}`, import.meta.url))).update('\0')
  }
  return hash.digest('hex')
}

const fixturePaths = DECODE_FIXTURE_FILES.map((file) => `fixtures/decode/${file}`)
const fixtures: DecodeFixture[] = DECODE_FIXTURE_FILES.flatMap((file) =>
  loadDecodeFixtures(readFileSync(new URL(`../fixtures/decode/${file}`, import.meta.url), 'utf8')),
)

describe('decode parser version lock', () => {
  it('binds the public parser version to the ordered rule digest', () => {
    expect(PARSER_VERSION).toBe(lock.parserVersion)
    expect(RULES_DIGEST).toBe(lock.rulesDigest)
  })

  it('pins rule helpers, closeAt logic, the pure hash, and the fixture corpus', () => {
    expect(digestFiles(semanticSources)).toBe(lock.sourceDigest)
    expect(digestFiles(fixturePaths)).toBe(lock.fixtureDigest)
  })

  it('accepts only real captured fixtures as real-sample coverage', () => {
    const expectedRules: RuleId[] = [
      'qwen3_coder',
      'anthropic_invoke',
      'hermes_tool_call',
      'inline_json',
      'lenient_json',
    ]
    expect(Object.keys(lock.sampleCoverage).sort()).toEqual([...expectedRules].sort())
    for (const [ruleId, fixtureId] of Object.entries(lock.sampleCoverage)) {
      if (fixtureId === null) continue
      const fixture = fixtures.find((candidate) => candidate.id === fixtureId)
      expect(fixture, `${ruleId}:${fixtureId}`).toBeDefined()
      expect(fixture?.provenance, `${ruleId}:${fixtureId}`).toBe('captured')
      expect(fixture?.model_hint, `${ruleId}:${fixtureId}`).toBeTruthy()
    }
  })
})
