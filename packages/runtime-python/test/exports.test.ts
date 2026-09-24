import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runtimes } from '../src/index.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

describe('@agnes/runtime-python', () => {
  it('exports exactly one runtime factory under the python key', () => {
    expect(Object.keys(runtimes)).toEqual(['python'])
    expect(typeof runtimes.python).toBe('function')
  })

  it('fails loudly until the spike lands rather than pretending to work', async () => {
    const factory = runtimes.python
    if (!factory) throw new Error('python runtime factory missing')
    await expect(factory({ log: logger, signal: new AbortController().signal })).rejects.toThrow(
      /E_PRESET_UNSUPPORTED:.*not implemented.*spike-gated/i,
    )
  })

  it('imports the contract only through the code runtime subpath', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/from ['"]@agnes\/code\/runtime['"]/)
    expect(source).not.toMatch(/from ['"]@agnes\/code['"]/)
  })
})
