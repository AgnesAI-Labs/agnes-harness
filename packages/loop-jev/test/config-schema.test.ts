import { readFileSync } from 'node:fs'
import { compilePluginConfig } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/index.js'

const row = (path: string) =>
  (
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
      agnes: { plugins: Array<{ id: string }> }
    }
  ).agnes.plugins.find((p) => p.id === 'loop:agnes.jev') as Record<string, unknown>

describe('loop:agnes.jev plugin row', () => {
  it('is declared identically by the package and by the Base distribution', () => {
    expect(row('../../base/package.json')).toEqual(row('../package.json'))
    expect(row('../package.json')).toMatchObject({
      export: 'jevLoopPlugin',
      default: false,
      configReload: 'next-session',
      inject: ['providers'],
      runtime: 'in-process',
      apiRange: '^4.0.0',
    })
  })
  it('compiles as a plugin configuration schema that accepts the defaults and refuses out-of-range values', () => {
    const validate = compilePluginConfig(row('../package.json').configSchema as never)
    expect(validate({})).toEqual([])
    expect(validate(DEFAULT_CONFIG)).toEqual([])
    expect(validate({ stepCap: 0 }).map((i) => i.path)).toEqual(['/stepCap'])
    expect(validate({ jev: { deadlineMs: 500 } }).map((i) => i.path)).toEqual(['/jev/deadlineMs'])
  })
})
