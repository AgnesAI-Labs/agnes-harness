import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  validateExtensionManifest,
  validateProjectionCapability,
  validateProjectionReadResult,
} from '../src/index.js'
import { runFixtureFiles } from '../tools/conformance-core.js'

const path = fileURLToPath(new URL('../fixtures/projection/projection.jsonl', import.meta.url))
const validators = {
  ProjectionCapability: validateProjectionCapability,
  ProjectionReadResult: validateProjectionReadResult,
  ExtensionManifest: validateExtensionManifest,
}
describe('P1 Projection protocol', () => {
  it('executes every checked-in positive and negative fixture through production validators', () => {
    const result = runFixtureFiles([path])
    expect(result.failed).toEqual([])
    expect(result.total).toBe(16)
    expect(result.skipped).toBe(0)
  })
  for (const fixture of readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))) {
    it(fixture.id, () => {
      const validate = validators[fixture.name as keyof typeof validators]
      expect(validate(fixture.payload).ok).toBe(fixture.kind === 'valid')
    })
  }
})
