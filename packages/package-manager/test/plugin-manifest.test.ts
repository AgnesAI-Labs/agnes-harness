import { describe, expect, it } from 'vitest'
import { parseAgnesPluginEntries, parseAgnesPluginKinds } from '../src/plugin-manifest.js'

describe('package.json agnes.plugins', () => {
  it('normalizes the author shape with a required contract range and freezes the result', () => {
    const entries = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^1.4.0', export: 'main' },
      {
        apiRange: '^1.4.0',
        export: 'optional',
        id: 'ext:acme/optional',
        runtime: 'isolated',
        config: { enabled: true },
        default: false,
      },
    ])

    expect(entries).toEqual([
      {
        apiRange: '^1.4.0',
        export: 'main',
        id: 'ext:@acme/example/main',
        runtime: 'in-process',
        default: true,
      },
      {
        apiRange: '^1.4.0',
        export: 'optional',
        id: 'ext:acme/optional',
        runtime: 'isolated',
        config: { enabled: true },
        default: false,
      },
    ])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
  })

  it.each([
    [[{ export: 'missing-range' }], 'apiRange'],
    [[{ export: 'incompatible', apiRange: '^99.0.0' }], 'apiRange'],
    [null, 'list'],
    [{ apiRange: '^1.4.0', export: 'main' }, 'list'],
    [[{}], 'export'],
    [[{ apiRange: '^1.4.0', export: '' }], 'export'],
    [[{ apiRange: '^1.4.0', export: 'main', runtime: 'worker' }], 'runtime'],
    [[{ apiRange: '^1.4.0', export: 'main', default: 'yes' }], 'default'],
    [[{ apiRange: '^1.4.0', export: 'main', extra: true }], 'unknown'],
    [[{ apiRange: '^1.4.0', export: 'main', id: '../escape' }], 'id'],
  ])('rejects invalid input %j', (value, message) => {
    expect(() => parseAgnesPluginEntries('@acme/example', value)).toThrow(message)
  })

  it('rejects duplicate normalized ids', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^1.4.0', export: 'main' },
        { apiRange: '^1.4.0', export: 'other', id: 'ext:@acme/example/main' },
      ]),
    ).toThrow(/duplicate/i)
  })

  it('rejects package-authored web rows because that namespace belongs to the daemon', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^1.4.0', export: 'panel', id: 'web:@victim/example' },
      ]),
    ).toThrow(/web:.*reserved/i)
  })

  it('rejects non-JSON and cyclic config values', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main', config: () => 1 }]),
    ).toThrow(/config/i)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main', config: Number.NaN }]),
    ).toThrow(/config/i)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main', config: cyclic }]),
    ).toThrow(/cyclic/i)
  })

  it('returns an empty frozen list when plugins are omitted', () => {
    const entries = parseAgnesPluginEntries('@acme/example', undefined)
    expect(entries).toEqual([])
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it('accepts declared provide and inject service names and freezes them', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^1.4.0', export: 'main', provide: ['acmeStats'], inject: ['clock', 'seam:approval'] },
    ])
    expect(entry?.provide).toEqual(['acmeStats'])
    expect(entry?.inject).toEqual(['clock', 'seam:approval'])
    expect(Object.isFrozen(entry?.provide)).toBe(true)
    expect(Object.isFrozen(entry?.inject)).toBe(true)
  })

  it('separates Surface-callable services from Cordis provide names', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [
      { apiRange: '^1.4.0', export: 'main', provide: ['clock'], services: ['data.read'] },
    ])
    expect(entry?.provide).toEqual(['clock'])
    expect(entry?.services).toEqual(['data.read'])
    expect(Object.isFrozen(entry?.services)).toBe(true)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^1.4.0', export: 'main', services: ['Bad/Name'] },
      ]),
    ).toThrow(/Surface service name syntax/)
  })

  it('leaves provide and inject absent when the author declares neither', () => {
    const [entry] = parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main' }])
    expect(entry).not.toHaveProperty('provide')
    expect(entry).not.toHaveProperty('inject')
  })

  it.each([
    ['not an array', 'abc'],
    ['a non-string name', [1]],
    ['an empty name', ['']],
    ['a padded name', [' stats']],
    ['a control character', ['a\u0000b']],
    ['a duplicate name', ['stats', 'stats']],
    ['too many names', Array.from({ length: 65 }, (_, index) => `s${index}`)],
    ['an over-long name', ['x'.repeat(129)]],
  ])('rejects provide with %s', (_label, provide) => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main', provide }]),
    ).toThrow(/provide/)
  })

  it('rejects an invalid inject list the same way', () => {
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [{ apiRange: '^1.4.0', export: 'main', inject: 'clock' }]),
    ).toThrow(/inject/)
    expect(() =>
      parseAgnesPluginEntries('@acme/example', [
        { apiRange: '^1.4.0', export: 'main', inject: ['clock', 'clock'] },
      ]),
    ).toThrow(/duplicate/)
  })
})

it('accepts multiple declared package kinds, preserves absence and rejects unsupported or duplicate kinds', () => {
  expect(parseAgnesPluginKinds(undefined)).toBeUndefined()
  expect(parseAgnesPluginKinds(['tool', 'loop', 'model-adapter', 'mcp', 'skills', 'ui'])).toEqual([
    'tool',
    'loop',
    'model-adapter',
    'mcp',
    'skills',
    'ui',
  ])
  expect(Object.isFrozen(parseAgnesPluginKinds(['tool', 'ui']))).toBe(true)
  for (const input of [null, 'tool', ['tool', 'tool'], ['unknown'], [1]])
    expect(() => parseAgnesPluginKinds(input)).toThrow('agnes.kinds')
})
