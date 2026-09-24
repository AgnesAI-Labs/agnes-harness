import { readFileSync } from 'node:fs'
import { defineFixture, NEGATIVE_ACTIONS } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'

describe('optional author fixture entry', () => {
  it('resolves the public subpath, preserves fixture identity and does not run or fill defaults', () => {
    const fixture = defineFixture({
      name: 'sample',
      cases: [
        {
          kind: 'negative',
          id: 'n1',
          action: 'undeclared-api',
          expect: { errorCode: 'E_CAPABILITY_UNDECLARED' },
        },
      ],
    })
    expect(defineFixture(fixture)).toBe(fixture)
    expect(Object.hasOwn(fixture, 'manifest')).toBe(false)
    expect(NEGATIVE_ACTIONS).toEqual([
      'undeclared-api',
      'bad-slot-payload',
      'bad-event-name',
      'infinite-loop',
      'lease-exhausted',
    ])
    expect(Reflect.set(NEGATIVE_ACTIONS, 0, 'pretend-success')).toBe(false)
  })
  it('keeps the optional entry free of runtime and host dependencies', () => {
    const source = readFileSync(new URL('../testkit/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"](?:node:|@agnes\/(?:core|host|base))/)
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.exports['./testkit']).toBe('./testkit/index.ts')
  })
})
