import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkManifest, type ExtensionManifest } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectSkinRoster,
  resolveSkinAsset,
  resolveSkins,
  rewriteSkinAssetUrls,
  SKIN_ASSET_EXTENSIONS,
  SKIN_MAX_ASSET_BYTES,
  SKIN_MAX_ASSETS_TOTAL_BYTES,
  SKIN_MAX_CSS_BYTES,
  skinCssUrl,
} from '../src/index.js'

const roots: string[] = []
function makePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-skin-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifestWith(skins: unknown[], ui: unknown = ['skin']): ExtensionManifest {
  return {
    id: 'agnes/example',
    version: '1.0.0',
    apiRange: '^1.1',
    entry: './index.mjs',
    capabilities: { ui },
    contributes: { skins },
  } as unknown as ExtensionManifest
}
/** A skin whose stylesheet sits at `skins/<id>/skin.css`, plus an optional `assets/` tree. */
function writeSkin(
  dir: string,
  id: string,
  options: { css?: string; assets?: Record<string, number> } = {},
): string {
  const skinDir = join(dir, 'skins', id)
  mkdirSync(skinDir, { recursive: true })
  writeFileSync(join(skinDir, 'skin.css'), options.css ?? '.sidebar { background: #000; }\n')
  if (options.assets) {
    mkdirSync(join(skinDir, 'assets'), { recursive: true })
    for (const [name, bytes] of Object.entries(options.assets))
      writeFileSync(join(skinDir, 'assets', name), Buffer.alloc(bytes, 1))
  }
  return `./skins/${id}/skin.css`
}

describe('skin asset resolution', () => {
  it('resolves a skin stylesheet and its sibling assets directory', () => {
    const dir = makePackage()
    const css = writeSkin(dir, 'midnight', { assets: { 'paper.webp': 128, 'font.woff2': 64 } })
    const resolved = resolveSkins(
      dir,
      manifestWith([
        { id: 'midnight', name: '午夜', css, tokens: { '--agnes-bg-page': { light: '#f', dark: '#0' } } },
      ]),
    )
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.id).toBe('midnight')
    expect(resolved[0]?.cssPath?.endsWith(join('skins', 'midnight', 'skin.css'))).toBe(true)
    expect(resolved[0]?.assetsDir?.endsWith(join('skins', 'midnight', 'assets'))).toBe(true)
    expect(resolved[0]?.tokens).toEqual({ '--agnes-bg-page': { light: '#f', dark: '#0' } })
  })
  it('reports no assets directory when the skin ships none, and no skins at all', () => {
    const dir = makePackage()
    const css = writeSkin(dir, 'plain')
    expect(
      resolveSkins(dir, manifestWith([{ id: 'plain', name: 'Plain', css }]))[0]?.assetsDir,
    ).toBeUndefined()
    expect(resolveSkins(dir, manifestWith([]))).toEqual([])
  })
  it('rejects a stylesheet over the byte cap', () => {
    const dir = makePackage()
    const css = writeSkin(dir, 'huge', { css: 'a'.repeat(SKIN_MAX_CSS_BYTES + 1) })
    expect(() => resolveSkins(dir, manifestWith([{ id: 'huge', name: 'Huge', css }]))).toThrow(
      /stylesheet is \d+ bytes, over the \d+-byte cap/,
    )
    // Exactly at the cap is allowed: the bound is inclusive.
    writeSkin(dir, 'exact', { css: 'a'.repeat(SKIN_MAX_CSS_BYTES) })
    const exact = resolveSkins(
      dir,
      manifestWith([{ id: 'exact', name: 'Exact', css: './skins/exact/skin.css' }]),
    )
    expect(exact).toHaveLength(1)
  })
  it('rejects an asset whose extension is outside the allowlist', () => {
    const dir = makePackage()
    const css = writeSkin(dir, 'oddext', { assets: { 'logo.svg': 16, 'notes.txt': 16 } })
    expect(() => resolveSkins(dir, manifestWith([{ id: 'oddext', name: 'Odd', css }]))).toThrow(
      /asset extension \./,
    )
    for (const extension of SKIN_ASSET_EXTENSIONS) {
      writeSkin(dir, 'ok', { assets: { [`a.${extension}`]: 16 } })
      const one = resolveSkins(dir, manifestWith([{ id: 'ok', name: 'Ok', css: './skins/ok/skin.css' }]))
      expect(one, extension).toHaveLength(1)
    }
  })
  it('rejects one oversized asset and an oversized asset total separately', () => {
    const dir = makePackage()
    const big = writeSkin(dir, 'big', { assets: { 'huge.webp': SKIN_MAX_ASSET_BYTES + 1 } })
    expect(() => resolveSkins(dir, manifestWith([{ id: 'big', name: 'Big', css: big }]))).toThrow(
      /asset is \d+ bytes, over the \d+-byte cap/,
    )

    const many = makePackage()
    const perFile = Math.ceil(SKIN_MAX_ASSETS_TOTAL_BYTES / 5)
    const total = writeSkin(many, 'many', {
      assets: Object.fromEntries(
        ['a.webp', 'b.webp', 'c.webp', 'd.webp', 'e.webp'].map((name) => [name, perFile]),
      ),
    })
    expect(() => resolveSkins(many, manifestWith([{ id: 'many', name: 'Many', css: total }]))).toThrow(
      /assets total \d+ bytes, over the \d+-byte cap/,
    )
  })
  it('rejects a stylesheet that only reaches the package through a symlink', () => {
    const dir = makePackage()
    const outside = makePackage()
    mkdirSync(join(dir, 'skins'), { recursive: true })
    writeFileSync(join(outside, 'evil.css'), '.x { color: red; }\n')
    symlinkSync(join(outside, 'evil.css'), join(dir, 'skins', 'link.css'))
    // `checkManifest` accepts the portable relative path; only the loader can see the escape.
    expect(() =>
      resolveSkins(dir, manifestWith([{ id: 'link', name: 'Link', css: './skins/link.css' }])),
    ).toThrow(/escapes the directory/)
  })
})

// The roster is what a client addresses skins by, so uniqueness across packages is the contract that
// lets the HTTP route be `/skins/<id>/...` instead of encoding a scoped package name into a segment.
describe('skin roster assembly', () => {
  function installed(
    id: string,
    directory: string | null,
    flags: { enabled?: boolean; trusted?: boolean } = {},
  ) {
    return {
      id,
      entry: { trust: 'builtin' },
      directory,
      capabilityHash: 'h',
      trusted: flags.trusted ?? true,
      enabled: flags.enabled ?? true,
      contributions: [],
      blockers: [],
      verifiedRollbackTarget: null,
    }
  }
  const inventory = (packages: unknown[], profile = 'local') => ({ profile, hash: 'h', packages }) as never

  function packageWithSkin(skinId: string, name = skinId): string {
    const dir = makePackage()
    writeFileSync(
      join(dir, 'agnes.extension.json'),
      JSON.stringify({
        id: 'agnes/example',
        version: '1.0.0',
        apiRange: '^1.1',
        entry: './index.mjs',
        capabilities: { ui: ['skin'] },
        contributes: { skins: [{ id: skinId, name, css: `./skins/${skinId}/skin.css` }] },
      }),
    )
    writeFileSync(join(dir, 'index.mjs'), 'export {}\n')
    writeSkin(dir, skinId)
    return dir
  }

  it('collects skins only from enabled, trusted packages and skips the rest', () => {
    const kept = packageWithSkin('kept')
    const disabled = packageWithSkin('disabled')
    const untrusted = packageWithSkin('untrusted')
    const roster = collectSkinRoster(
      inventory([
        installed('acme/kept', kept),
        installed('acme/disabled', disabled, { enabled: false }),
        installed('acme/untrusted', untrusted, { trusted: false }),
        installed('acme/no-directory', null),
      ]),
    )
    expect(roster.skins.map((s) => s.id)).toEqual(['kept'])
    expect(roster.skins[0]?.packageName).toBe('acme/kept')
    expect(roster.shadowed).toEqual([])
  })
  it('keeps the lexicographically first package for a contested id and reports the loser', () => {
    const roster = collectSkinRoster(
      inventory([
        installed('zebra/pkg', packageWithSkin('midnight')),
        installed('alpha/pkg', packageWithSkin('midnight')),
      ]),
    )
    expect(roster.skins.map((s) => [s.id, s.packageName])).toEqual([['midnight', 'alpha/pkg']])
    expect(roster.shadowed).toEqual(['zebra/pkg#midnight'])
  })
  it('reports a revision that moves with the roster and holds still otherwise', () => {
    const one = packageWithSkin('one')
    const base = collectSkinRoster(inventory([installed('acme/one', one)]))
    expect(base.revision).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(collectSkinRoster(inventory([installed('acme/one', one)])).revision).toBe(base.revision)
    const two = packageWithSkin('two')
    const grown = collectSkinRoster(inventory([installed('acme/one', one), installed('acme/two', two)]))
    expect(grown.revision).not.toBe(base.revision)
    // The profile is part of the digest: the same files under another profile are a different roster.
    expect(collectSkinRoster(inventory([installed('acme/one', one)], 'other')).revision).not.toBe(
      base.revision,
    )
  })
  it('ignores a package directory that carries no manifest', () => {
    const bare = makePackage()
    expect(collectSkinRoster(inventory([installed('acme/bare', bare)])).skins).toEqual([])
  })
})

// The HTTP route is the only new network input this feature adds, so its path authority is pinned
// here rather than in the server: the server must not be able to widen what a skin id can reach.
describe('skin asset request resolution', () => {
  function rosterWith(id: string, assets?: Record<string, number>, nested = false) {
    const dir = makePackage()
    writeFileSync(
      join(dir, 'agnes.extension.json'),
      JSON.stringify({
        id: 'agnes/example',
        version: '1.0.0',
        apiRange: '^1.1',
        entry: './index.mjs',
        capabilities: { ui: ['skin'] },
        contributes: { skins: [{ id, name: id, css: `./skins/${id}/skin.css` }] },
      }),
    )
    writeFileSync(join(dir, 'index.mjs'), 'export {}\n')
    writeSkin(dir, id, assets ? { assets } : {})
    if (nested) {
      mkdirSync(join(dir, 'skins', id, 'assets', 'deep'), { recursive: true })
      writeFileSync(join(dir, 'skins', id, 'assets', 'deep', 'x.webp'), Buffer.alloc(8, 1))
    }
    return collectSkinRoster({
      profile: 'local',
      hash: 'h',
      packages: [
        {
          id: 'agnes/example',
          entry: { trust: 'builtin' },
          directory: dir,
          capabilityHash: 'h',
          trusted: true,
          enabled: true,
          contributions: [],
          blockers: [],
          verifiedRollbackTarget: null,
        },
      ],
    } as never)
  }

  it('serves the stylesheet and assets for a known skin id', () => {
    const roster = rosterWith('midnight', { 'paper.webp': 16 }, true)
    const css = resolveSkinAsset(roster, '/skins/midnight/skin.css')
    expect(css?.endsWith(join('skins', 'midnight', 'skin.css'))).toBe(true)
    expect(resolveSkinAsset(roster, '/skins/midnight/assets/paper.webp')).not.toBeNull()
    // Nested asset directories are reachable; the stylesheet's relative url() may use them.
    expect(resolveSkinAsset(roster, '/skins/midnight/assets/deep/x.webp')).not.toBeNull()
  })
  it('refuses anything outside the two shapes it owns', () => {
    const roster = rosterWith('midnight', { 'paper.webp': 16 })
    for (const pathname of [
      '/skins/midnight',
      '/skins/midnight/',
      '/skins/midnight/assets',
      '/skins/midnight/assets/',
      '/skins/midnight/other.css',
      '/skins/unknown/skin.css',
      '/skins/unknown/assets/paper.webp',
      '/skins//skin.css',
      '/skins/midnight/assets/nope.webp',
      '/skins/midnight/assets/paper.webp/extra',
      '/other/midnight/skin.css',
      '/skins/%E0%A4%A/skin.css',
    ])
      expect(resolveSkinAsset(roster, pathname), pathname).toBeNull()
  })
  it('refuses traversal out of the assets directory', () => {
    const roster = rosterWith('midnight', { 'paper.webp': 16 })
    for (const pathname of [
      '/skins/midnight/assets/../skin.css',
      '/skins/midnight/assets/../../agnes.extension.json',
      '/skins/midnight/assets/deep/../../skin.css',
    ])
      expect(resolveSkinAsset(roster, pathname), pathname).toBeNull()
  })
  it('refuses a symlink inside the assets directory that leaves the package', () => {
    const outside = makePackage()
    writeFileSync(join(outside, 'secret.webp'), Buffer.alloc(8, 1))
    const roster = rosterWith('midnight', { 'paper.webp': 16 })
    const skin = roster.skins[0]
    if (skin?.assetsDir === undefined) throw new Error('expected an assets directory')
    symlinkSync(join(outside, 'secret.webp'), join(skin.assetsDir, 'linked.webp'))
    expect(resolveSkinAsset(roster, '/skins/midnight/assets/linked.webp')).toBeNull()
    // The real asset beside it still resolves, so the refusal is the link, not the directory.
    expect(resolveSkinAsset(roster, '/skins/midnight/assets/paper.webp')).not.toBeNull()
  })
  it('serves assets only under the assets/ prefix, not any sibling of the stylesheet', () => {
    // A real file beside the stylesheet must stay unreachable: the route's prefix is the boundary,
    // not the file's existence. Without this case the prefix guard is masked by "file not found".
    const roster = rosterWith('midnight', { 'paper.webp': 16 })
    const skin = roster.skins[0]
    if (skin?.cssPath === undefined) throw new Error('expected a disk-resolved skin')
    const beside = join(skin.cssPath, '..', 'beside.webp')
    writeFileSync(beside, Buffer.alloc(8, 1))
    expect(resolveSkinAsset(roster, '/skins/midnight/beside.webp')).toBeNull()
    expect(resolveSkinAsset(roster, '/skins/midnight/assets/beside.webp')).toBeNull()
    // The sharp case: seven leading characters would be sliced off as if they were `assets/`, so
    // dropping the prefix check would serve a real asset from a path that never named `assets/`.
    expect(resolveSkinAsset(roster, '/skins/midnight/zzzzzzzpaper.webp')).toBeNull()
  })
  it('refuses a skin that ships no assets directory', () => {
    const roster = rosterWith('bare')
    expect(resolveSkinAsset(roster, '/skins/bare/skin.css')).not.toBeNull()
    expect(resolveSkinAsset(roster, '/skins/bare/assets/paper.webp')).toBeNull()
  })
})

// The checked-in example is what the authoring guide points at, so it must satisfy the real contract
// rather than merely look plausible. Reading it from here is what keeps it from rotting.
describe('checked-in skin example', () => {
  const exampleMain = (variant: string): string =>
    fileURLToPath(
      new URL(`../../../examples/packages/skin-example/${variant}/extensions/main`, import.meta.url),
    )
  const manifestIn = (variant: string): unknown =>
    variant === 'broken'
      ? JSON.parse(readFileSync(join(exampleMain(variant), 'agnes.extension.json'), 'utf8'))
      : {
          id: 'examples/skin-example',
          version: '1.0.0',
          apiRange: '^1.0',
          entry: './index.mjs',
          capabilities: { ui: ['skin'] },
          contributes: JSON.parse(readFileSync(join(exampleMain(variant), 'agnes.client.json'), 'utf8')),
        }
  const clientRoster = (root: string, id: string) => {
    const descriptor = JSON.parse(readFileSync(join(root, 'extensions/main/agnes.client.json'), 'utf8'))
    const rowId = `ext:examples/${id.split('/').at(-1)}/main`
    const integrity = `sha256-${'a'.repeat(64)}`
    return collectSkinRoster(
      {
        profile: 'local',
        hash: 'h',
        packages: [
          {
            id,
            entry: { integrity, trust: 'trusted' },
            directory: root,
            capabilityHash: 'h',
            trusted: true,
            enabled: true,
            contributions: [
              {
                kind: 'client',
                id: 'skin/descriptor',
                rowId,
                path: './extensions/main/agnes.client.json',
                skins: descriptor.skins,
              },
            ],
            blockers: [],
            verifiedRollbackTarget: null,
          },
        ],
      } as never,
      [],
      new Set([`${rowId}\0${id}\0${integrity}`]),
    )
  }

  it('passes the real manifest check and resolves its stylesheet and asset', () => {
    const checked = checkManifest(manifestIn('v1'))
    expect(checked.ok, checked.ok ? '' : checked.problems.join('; ')).toBe(true)
    if (!checked.ok) return
    const resolved = resolveSkins(exampleMain('v1'), checked.value)
    expect(resolved.map((skin) => skin.id)).toEqual(['midnight'])
    expect(resolved[0]?.assetsDir).toBeDefined()
    // The stylesheet is the one the authoring guide documents: region hooks only, both palettes.
    const css = readFileSync(resolved[0]?.cssPath ?? '', 'utf8')
    expect(css).toContain('[data-agnes-region="transcript"]')
    expect(css).toContain('[data-agnes-region="composer"]')
    expect(css).toContain('.dark ')
    // No internal class or id may appear: those are not a contract.
    expect(css).not.toMatch(/\.[a-z-]*(sidebar|topbar|composer|transcript)\s*\{/i)
  })
  it('serves the example stylesheet and its real asset through the request resolver', () => {
    // The request resolver is the only authority for the `/skins/*` route, and until now it had only
    // ever seen synthetic directories. Running it against the checked-in example ties the route to a
    // package that really ships an asset, which is the case the asset half of the feature exists for.
    const checked = checkManifest(manifestIn('v1'))
    if (!checked.ok) throw new Error(checked.problems.join('; '))
    const root = fileURLToPath(new URL('../../../examples/packages/skin-example/v1', import.meta.url))
    const roster = clientRoster(root, 'examples/skin-example')
    expect(roster.skins.map((skin) => skin.id)).toEqual(['midnight'])
    const css = resolveSkinAsset(roster, '/skins/midnight/skin.css')
    expect(css).not.toBeNull()
    expect(readFileSync(css as string, 'utf8')).toContain('data-agnes-region')
    const asset = resolveSkinAsset(roster, '/skins/midnight/assets/paper.png')
    expect(asset?.endsWith(join('assets', 'paper.png'))).toBe(true)
    // The route stays shut for anything the example does not actually ship.
    for (const pathname of [
      '/skins/midnight/assets/missing.png',
      '/skins/midnight/agnes.extension.json',
      '/skins/midnight/assets/../agnes.extension.json',
    ])
      expect(resolveSkinAsset(roster, pathname), pathname).toBeNull()
  })
  it('validates all four built-in preset skins against the same contract as third parties', () => {
    // The presets must not get a private shortcut: they are checked with the very same
    // checkManifest/resolveSkins pair a third-party package goes through.
    const presetMain = fileURLToPath(
      new URL('../../../examples/packages/skins-builtin/v1/extensions/main', import.meta.url),
    )
    const checked = checkManifest({
      id: 'examples/skins-builtin',
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.mjs',
      capabilities: { ui: ['skin'] },
      contributes: JSON.parse(readFileSync(join(presetMain, 'agnes.client.json'), 'utf8')),
    })
    expect(checked.ok, checked.ok ? '' : checked.problems.join('; ')).toBe(true)
    if (!checked.ok) return
    const resolved = resolveSkins(presetMain, checked.value)
    expect(resolved.map((skin) => skin.id)).toEqual(['high-contrast', 'midnight', 'paper', 'aurora'])
    // Three presets carry no assets on purpose, so they work on the inline stylesheet alone.
    expect(resolved.filter((skin) => skin.assetsDir !== undefined).map((skin) => skin.id)).toEqual(['aurora'])
    for (const skin of resolved) {
      const css = readFileSync(skin.cssPath, 'utf8')
      expect(css, skin.id).toContain('data-agnes-region')
      // Internal classes and ids are not a contract, so a preset must not lean on them.
      expect(css, skin.id).not.toMatch(/\.(sidebar|topbar|composer|transcript|node-body|turn-user)\b/)
    }
    // Token-only presets still owe both palettes for every token they declare.
    const highContrast = checked.value.contributes?.skins?.find((skin) => skin.id === 'high-contrast')
    expect(Object.keys(highContrast?.tokens ?? {}).length).toBeGreaterThan(5)
    for (const modes of Object.values(highContrast?.tokens ?? {}) as Array<{ light: string; dark: string }>) {
      expect(modes.light).not.toBe('')
      expect(modes.dark).not.toBe('')
    }
  })

  it('finds a skin declared in the package client descriptor', () => {
    // This is the shape a real install has: the package root carries `package.json` naming its
    // extension directories, and the manifest lives one level down. Reading only the root finds no
    // manifest at all, so the skin would silently never appear.
    const pkgRoot = fileURLToPath(new URL('../../../examples/packages/skin-example/v1', import.meta.url))
    expect(existsSync(join(pkgRoot, 'agnes.extension.json'))).toBe(false)
    const roster = clientRoster(pkgRoot, 'examples/skin-example')
    expect(roster.skins.map((skin) => skin.id)).toEqual(['midnight'])
    // The resolved paths hang off the extension directory, which is what the asset route serves from.
    expect(roster.skins[0]?.cssPath).toContain(join('extensions', 'main'))
    expect(roster.skins[0]?.assetsDir).toContain(join('extensions', 'main'))
  })

  it('surfaces the shipped presets from the catalog package, which is the proven install path', () => {
    // The presets ship as a repository-local example family, so an install gives them a real
    // directory and the roster reads them exactly like any third-party skin. Building the roster
    // from the package root is the acceptance for that: it exercises bundled-extension discovery.
    const baseDir = fileURLToPath(new URL('../../../examples/packages/skins-builtin/v1', import.meta.url))
    const roster = clientRoster(baseDir, '@agnes-examples/skins-builtin')
    expect(roster.skins.map((skin) => skin.id).sort()).toEqual([
      'aurora',
      'high-contrast',
      'midnight',
      'paper',
    ])
    expect(roster.skins.every((skin) => skin.packageName === '@agnes-examples/skins-builtin')).toBe(true)
    // Only aurora ships an asset, and every stylesheet must resolve to a real file.
    for (const skin of roster.skins) {
      expect(readFileSync(skin.cssPath ?? '', 'utf8'), skin.id).toContain('data-agnes-region')
      if (skin.id !== 'aurora') expect(skin.assetsDir, skin.id).toBeUndefined()
    }
    expect(roster.skins.find((skin) => skin.id === 'aurora')?.assetsDir).toBeDefined()
  })

  it('falls back to build-embedded skin data when the directory has no manifest', () => {
    // The packaged distribution compiles builtin packages in and gives them no source tree, so the
    // roster has to work from what the build embedded. This is the shape S15 delivers.
    const empty = makePackage()
    const embedded = [
      {
        packageId: '@agnes/base',
        id: 'midnight',
        name: '午夜',
        css: '[data-agnes-region="app"] { color: #fff; }',
        tokens: { '--agnes-bg-page': { light: '#fff', dark: '#000' } },
      },
      {
        packageId: '@agnes/base',
        id: 'paper',
        name: '纸质',
        css: '[data-agnes-region="app"] { color: #111; }',
      },
      { packageId: '@agnes/other', id: 'ignored', name: 'Ignored', css: '.x{}' },
    ]
    const roster = collectSkinRoster(
      {
        profile: 'local',
        hash: 'h',
        packages: [
          {
            id: '@agnes/base',
            entry: {},
            directory: empty,
            capabilityHash: 'h',
            trusted: true,
            enabled: true,
            contributions: [],
            blockers: [],
            verifiedRollbackTarget: null,
          },
        ],
      } as never,
      embedded,
    )
    expect(roster.skins.map((skin) => [skin.id, skin.packageName])).toEqual([
      ['midnight', '@agnes/base'],
      ['paper', '@agnes/base'],
    ])
    // Embedded skins have text, not a file, and must not pretend otherwise.
    expect(roster.skins[0]?.cssPath).toBeUndefined()
    expect(roster.skins[0]?.css).toContain('data-agnes-region')
    expect(roster.skins[1]?.tokens).toEqual({})
    // The asset route serves files only, so an embedded skin has nothing for it to resolve.
    expect(resolveSkinAsset(roster, '/skins/midnight/skin.css')).toBeNull()
    // A disabled or untrusted package contributes nothing, embedded or not.
    const off = collectSkinRoster(
      {
        profile: 'local',
        hash: 'h',
        packages: [
          {
            id: '@agnes/base',
            entry: {},
            directory: empty,
            capabilityHash: 'h',
            trusted: true,
            enabled: false,
            contributions: [],
            blockers: [],
            verifiedRollbackTarget: null,
          },
        ],
      } as never,
      embedded,
    )
    expect(off.skins).toEqual([])
  })

  it('does not report phantom conflicts for embedded skins in a shared directory', () => {
    // A packaged distribution maps every builtin package at one directory. Reading it once per
    // package would let the second reader re-claim the first reader's skins, which surfaces as a
    // bogus "shadowed" entry for a package that never shipped a conflicting skin.
    const dir = makePackage()
    const pkg = (id: string) => ({
      id,
      entry: { trust: 'builtin' },
      directory: dir,
      capabilityHash: 'h',
      trusted: true,
      enabled: true,
      contributions: [],
      blockers: [],
      verifiedRollbackTarget: null,
    })
    const roster = collectSkinRoster(
      {
        profile: 'local',
        hash: 'h',
        packages: [pkg('@agnes/base'), pkg('@agnes/code')],
      } as never,
      [{ packageId: '@agnes/base', id: 'midnight', name: '午夜', css: '.x{}' }],
    )
    expect(roster.skins.map((skin) => skin.id)).toEqual(['midnight'])
    expect(roster.shadowed).toEqual([])
  })

  it('contributes nothing for a builtin package that resolves to no directory', () => {
    // This is the shape the daemon actually produces: `createPackageManager` is built without a
    // `builtinDirectory`, so `readInventory` leaves every `trust: 'builtin'` package with a null
    // directory. Pinning it here keeps the boundary visible: built-in skins need either an embedded
    // source of truth or a builtin directory resolver, and neither exists yet.
    const roster = collectSkinRoster({
      profile: 'local',
      hash: 'h',
      packages: [
        {
          id: '@agnes/base',
          entry: { trust: 'builtin' },
          directory: null,
          capabilityHash: 'h',
          trusted: true,
          enabled: true,
          contributions: [],
          blockers: [],
          verifiedRollbackTarget: null,
        },
      ],
    } as never)
    expect(roster.skins).toEqual([])
    expect(roster.shadowed).toEqual([])
    // The same package with a directory does contribute, which is what the embedded path mirrors.
    const withDir = clientRoster(
      fileURLToPath(new URL('../../../examples/packages/skins-builtin/v1', import.meta.url)),
      '@agnes-examples/skins-builtin',
    )
    expect(withDir.skins.map((skin) => skin.id).sort()).toEqual([
      'aurora',
      'high-contrast',
      'midnight',
      'paper',
    ])
  })
  it('rejects the broken variant at the capability/contribution coupling', () => {
    const checked = checkManifest(manifestIn('broken'))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems.join(' ')).toContain("capabilities.ui to include 'skin'")
  })
})

/**
 * The client applies the stylesheet as inline text through `replaceSync`, whose base URL is the
 * document rather than the stylesheet. Without this rewrite an author's `url('assets/x.png')`
 * resolved against the page root and 404'd even though the asset route worked (design §21).
 */
describe('skin stylesheet url rewriting', () => {
  it('resolves a relative reference against the stylesheet, not the asset base twice', () => {
    // The layout is `<skin>/skin.css` beside `<skin>/assets/x.png`, and the route mirrors it. Naively
    // prefixing the asset base would emit `/assets/assets/x.png`; the base has to be `cssUrl`.
    expect(
      rewriteSkinAssetUrls("[data-agnes-region='app']{background:url('assets/aurora.png')}", 'aurora'),
    ).toBe("[data-agnes-region='app']{background:url('/skins/aurora/assets/aurora.png')}")
    expect(skinCssUrl('aurora')).toBe('/skins/aurora/skin.css')
  })

  it('keeps quote style, whitespace form and every already-absolute reference', () => {
    const cases: Array<[string, string]> = [
      ['url("assets/a.woff2")', 'url("/skins/x/assets/a.woff2")'],
      ['url(assets/a.woff2)', 'url(/skins/x/assets/a.woff2)'],
      ['url(  assets/a.woff2  )', 'url(/skins/x/assets/a.woff2)'],
      // Already carries its own origin: absolute route, fragment, data:, and scheme URLs.
      ["url('/skins/x/assets/a.png')", "url('/skins/x/assets/a.png')"],
      ['url(/skins/x/assets/a.png)', 'url(/skins/x/assets/a.png)'],
      ['url(#mask)', 'url(#mask)'],
      ["url('data:image/png;base64,AAAA')", "url('data:image/png;base64,AAAA')"],
      ['url(https://example.test/a.png)', 'url(https://example.test/a.png)'],
      ['url(HTTP://example.test/a.png)', 'url(HTTP://example.test/a.png)'],
      // Uppercase `URL(` is the same function to a CSS parser.
      ['URL(assets/a.png)', 'url(/skins/x/assets/a.png)'],
    ]
    for (const [input, expected] of cases)
      expect(rewriteSkinAssetUrls(`a{b:${input}}`, 'x'), input).toBe(`a{b:${expected}}`)
  })

  it('normalises dot segments and preserves query and fragment', () => {
    expect(rewriteSkinAssetUrls("a{b:url('./assets/../assets/a.png')}", 'x')).toBe(
      "a{b:url('/skins/x/assets/a.png')}",
    )
    // A query is how fonts are versioned (`?#iefix`); dropping it would break the reference.
    expect(rewriteSkinAssetUrls("a{b:url('assets/a.woff2?v=2#iefix')}", 'x')).toBe(
      "a{b:url('/skins/x/assets/a.woff2?v=2#iefix')}",
    )
    // Escaping the skin's own prefix is allowed to normalise, but the route will still refuse it:
    // `resolveSkinAsset` only serves `/skins/<id>/assets/...`, so authority stays with the route.
    expect(rewriteSkinAssetUrls("a{b:url('../../skin.css')}", 'x')).toBe("a{b:url('/skin.css')}")
  })

  it('leaves an empty or unparseable reference alone instead of emitting a broken url()', () => {
    expect(rewriteSkinAssetUrls('a{b:url()}', 'x')).toBe('a{b:url()}')
    expect(rewriteSkinAssetUrls('a{b:url("")}', 'x')).toBe('a{b:url("")}')
  })

  it('rewrites the shipped image preset onto its own asset route', () => {
    const dir = makePackage()
    const skinDir = join(dir, 'skins', 'aurora')
    mkdirSync(join(skinDir, 'assets'), { recursive: true })
    writeFileSync(join(skinDir, 'assets', 'aurora.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const css = "[data-agnes-region='app'] { background-image: url('assets/aurora.png'); }"
    writeFileSync(join(skinDir, 'skin.css'), css)
    const manifest = {
      id: 'x',
      version: '1.0.0',
      apiRange: '^1.0',
      entry: './index.mjs',
      runtime: { supports: ['in-process'] },
      capabilities: { ui: ['skin'] },
      contributes: {
        skins: [{ id: 'aurora', name: '流光', css: './skins/aurora/skin.css' }],
      },
    } as unknown as ExtensionManifest
    const [skin] = resolveSkins(dir, manifest)
    if (!skin) throw new Error('resolveSkins returned nothing')
    expect(rewriteSkinAssetUrls(readFileSync(skin.cssPath, 'utf8'), skin.id)).toBe(
      "[data-agnes-region='app'] { background-image: url('/skins/aurora/assets/aurora.png'); }",
    )
  })
})
