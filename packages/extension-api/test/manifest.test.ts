import { describe, expect, it } from 'vitest'
import { checkManifest, extEventType, isExtensionError, RESOURCE_KINDS } from '../src/index.js'

const manifest = {
  id: 'agnes/example',
  version: '1.2.0',
  apiRange: '^1.0',
  entry: './dist/index.js',
  capabilities: {
    hooks: ['tool_call'],
    events: true,
    resources: ['skill'],
    network: { hosts: ['erp.internal:443'] },
    artifacts: true,
    subagent: true,
    'tools.invoke': true,
    tools: { prefix: 'sales_', names: ['sales_read'] },
  },
  lease: { budget: 10000 },
}
describe('author manifest validation', () => {
  it('accepts current protocol capabilities and returns an independent snapshot', () => {
    const result = checkManifest(manifest)
    expect(result).toEqual({ ok: true, value: manifest })
    if (!result.ok) throw new Error('manifest rejected')
    expect(result.value).not.toBe(manifest)
    expect(result.value.capabilities).not.toBe(manifest.capabilities)
    expect(RESOURCE_KINDS).toEqual(['skill', 'mcp', 'kb', 'datasource', 'model'])
    expect(Object.isFrozen(RESOURCE_KINDS)).toBe(true)
    expect(checkManifest({ ...manifest, capabilities: { network: [] } }).ok).toBe(true)
  })
  it('rejects malformed capability values without throwing', () => {
    for (const capabilities of [
      null,
      [],
      { hooks: 1 },
      { hooks: ['nope'] },
      { events: [] },
      { network: ['erp.internal'] },
      { network: { hosts: ['http://erp'] } },
      { resources: ['shell'] },
      { extra: true },
    ] as const) {
      expect(checkManifest({ ...manifest, capabilities }).ok).toBe(false)
    }
    for (const value of [
      undefined,
      null,
      [],
      {},
      { ...manifest, id: 'core' },
      { ...manifest, lease: { budget: 0 } },
    ])
      expect(checkManifest(value).ok).toBe(false)
  })
  it('validates version syntax without pretending to check runtime compatibility', () => {
    for (const version of ['', 'v1.0.0', '01.0.0', '1.2.3-01', '1.2.3-a..b', '1.2.3+'])
      expect(checkManifest({ ...manifest, version }).ok).toBe(false)
    expect(checkManifest({ ...manifest, version: '1.2.3-alpha.1+build.01' }).ok).toBe(true)
    expect(checkManifest({ ...manifest, apiRange: '' }).ok).toBe(false)
  })
  it('rejects package entry traversal and ambiguous portable paths', () => {
    for (const entry of [
      './../evil.js',
      './dir/../evil.js',
      '../evil.js',
      '/tmp/x',
      './dir\\evil.js',
      './x\0.js',
      './C:evil.js',
      './',
      './dir//x.js',
      '././x.js',
    ])
      expect(checkManifest({ ...manifest, entry }).ok, entry).toBe(false)
    expect(checkManifest({ ...manifest, entry: './dir/file-name.js' }).ok).toBe(true)
  })
  it('rejects accessors without executing them or exposing their values', () => {
    let calls = 0
    const input = { ...manifest }
    Object.defineProperty(input, 'id', {
      enumerable: true,
      get() {
        calls++
        throw new Error('private detail')
      },
    })
    expect(checkManifest(input)).toEqual({ ok: false, problems: ['manifest: expected plain JSON data'] })
    expect(calls).toBe(0)
  })
  it('namespaces bundled and partner events and rejects reserved shortcuts', () => {
    expect(extEventType('agnes/subagent', 'worktree-skipped')).toBe('x/agnes/subagent/worktree-skipped')
    expect(extEventType('vendor/tool', 'done')).toBe('x/vendor/tool/done')
    for (const [id, name] of [
      ['core', 'done'],
      ['vendor/tool', 'Bad Name'],
      ['vendor/tool', 'x/other'],
      ['', 'done'],
      ['vendor/tool', 'done\n'],
      ['vendor/tool\n', 'done'],
    ] as const) {
      try {
        extEventType(id, name)
        expect.unreachable()
      } catch (e) {
        expect(isExtensionError(e) && e.code).toBe('E_EVENT_NAMESPACE')
      }
    }
  })
})

// A skin is pure data: a stylesheet path plus optional semantic-token overrides. The schema owns
// id/name/css shape, reserved ids and the token value charset; these cases cover what it cannot
// express — the capability coupling, in-package id uniqueness, path containment and whitelist
// membership. Sizes and resolved (symlink-safe) containment belong to the package loader.
describe('author manifest skin validation', () => {
  const skin = { id: 'midnight', name: '午夜', css: './skins/midnight/skin.css' }
  const withSkins = (skins: unknown, ui?: unknown) => ({
    ...manifest,
    capabilities: { ...manifest.capabilities, ...(ui === undefined ? { ui: ['skin'] } : { ui }) },
    contributes: { skins },
  })
  it('accepts a skin that declares both the capability and the contribution', () => {
    expect(checkManifest(withSkins([skin])).ok).toBe(true)
    expect(
      checkManifest(
        withSkins([
          {
            ...skin,
            tokens: { '--agnes-bg-page': { light: '#fdfeff', dark: '#161b21' } },
          },
        ]),
      ).ok,
    ).toBe(true)
    // A manifest without any skin keeps the pre-skin behaviour untouched.
    expect(checkManifest(manifest).ok).toBe(true)
    expect(checkManifest({ ...manifest, capabilities: { ...manifest.capabilities, ui: [] } }).ok).toBe(true)
  })
  it('rejects a contribution or capability that appears without its counterpart', () => {
    expect(checkManifest(withSkins([skin], [])).ok).toBe(false)
    expect(checkManifest(withSkins([])).ok).toBe(false)
    expect(checkManifest(withSkins(undefined, ['skin'])).ok).toBe(false)
  })
  it('rejects duplicate skin ids inside one package', () => {
    expect(checkManifest(withSkins([skin, skin])).ok).toBe(false)
    expect(
      checkManifest(withSkins([skin, { ...skin, id: 'aurora', css: './skins/aurora/skin.css' }])).ok,
    ).toBe(true)
  })
  it('rejects a stylesheet path that escapes the package', () => {
    for (const css of [
      './../evil.css',
      './dir/../evil.css',
      '../evil.css',
      '/tmp/x.css',
      './dir\\evil.css',
      './x\0.css',
      './C:evil.css',
      './',
      './dir//x.css',
      '././x.css',
      'skins/x.css',
    ])
      expect(checkManifest(withSkins([{ ...skin, css }])).ok, css).toBe(false)
    expect(checkManifest(withSkins([{ ...skin, css: './dir/skin-name.css' }])).ok).toBe(true)
  })
  it('rejects a reserved skin id that would shadow a built-in theme word', () => {
    for (const id of ['light', 'dark', 'system', 'none', 'Light', 'a b', '-x', 'x-'])
      expect(checkManifest(withSkins([{ ...skin, id }])).ok, id).toBe(false)
    expect(checkManifest(withSkins([{ ...skin, id: 'solarized-light' }])).ok).toBe(true)
  })
  it('rejects token overrides outside the generated semantic whitelist', () => {
    const modes = { light: '#fff', dark: '#000' }
    for (const token of [
      '--agnes-color-neutral-500',
      '--radius-md',
      '--font-sans',
      '--s8',
      '--transition',
      '--not-a-token',
      'agnes-bg-page',
    ])
      expect(checkManifest(withSkins([{ ...skin, tokens: { [token]: modes } }])).ok, token).toBe(false)
    for (const token of ['--agnes-bg-page', '--shadow-elevation', '--agnes-text-primary'])
      expect(checkManifest(withSkins([{ ...skin, tokens: { [token]: modes } }])).ok, token).toBe(true)
  })
  it('rejects a token override that supplies only one palette mode', () => {
    for (const value of [{}, { light: '#fff' }, { dark: '#000' }, { light: '#fff', extra: 1 }])
      expect(
        checkManifest(withSkins([{ ...skin, tokens: { '--agnes-bg-page': value } }])).ok,
        JSON.stringify(value),
      ).toBe(false)
  })
  it('rejects token values that could break out of their declaration or fetch a remote resource', () => {
    for (const value of [
      '',
      'url(http://tracker/x.png)',
      '#fff;color:red',
      '#fff}',
      '@import "x"',
      '#fff{',
      'a'.repeat(257),
    ])
      expect(
        checkManifest(withSkins([{ ...skin, tokens: { '--agnes-bg-page': { light: value, dark: value } } }]))
          .ok,
        value,
      ).toBe(false)
    // Gradients carry parentheses and must stay legal: they are the documented non-flat background.
    for (const value of [
      'linear-gradient(180deg, #ffffff, #f0f0f0)',
      'radial-gradient(circle, transparent 48%, #000 50%)',
    ])
      expect(
        checkManifest(withSkins([{ ...skin, tokens: { '--agnes-bg-page': { light: value, dark: value } } }]))
          .ok,
        value,
      ).toBe(true)
  })
})
