import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { HARNESS_VERSION } from '../src/index.js'

it("writes the harness contract version once, as this package's own version", () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  expect(HARNESS_VERSION).toBe(manifest.version)
  // The placeholder of an unpublished build is not a contract version.
  expect(HARNESS_VERSION).not.toBe('0.0.0')
})
