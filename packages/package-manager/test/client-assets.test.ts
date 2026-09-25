import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkManifest, type ExtensionManifest } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIENT_ASSET_EXTENSIONS,
  CLIENT_MAX_FILE_BYTES,
  CLIENT_MAX_TOTAL_BYTES,
  capabilityHash,
  hashDirectory,
  normalizeClientContribution,
  resolveClientAssets,
  resolveClientModuleAsset,
} from '../src/index.js'
import { inspectStaged } from '../src/inspect.js'
import { snapshotHash } from '../src/integrity.js'
import { readManifestIn } from '../src/manifest.js'

const roots: string[] = []
function makePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-client-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manifestWith(client: unknown, ui: unknown = ['client']): ExtensionManifest {
  return {
    id: 'agnes/example',
    version: '1.0.0',
    apiRange: '^1.1',
    entry: './index.mjs',
    capabilities: { ui },
    ...(client === undefined ? {} : { contributes: { client } }),
  } as unknown as ExtensionManifest
}

/** 在包目录里写好 client 入口与样式文件，返回声明用的包内相对路径。 */
function writeClientFiles(
  dir: string,
  options: { entryBytes?: number; styles?: Record<string, number> } = {},
) {
  const clientDir = join(dir, 'dist', 'client')
  mkdirSync(clientDir, { recursive: true })
  writeFileSync(join(clientDir, 'index.js'), Buffer.alloc(options.entryBytes ?? 64, 1))
  const styles: string[] = []
  for (const [name, bytes] of Object.entries(options.styles ?? {})) {
    writeFileSync(join(clientDir, name), Buffer.alloc(bytes, 1))
    styles.push(`dist/client/${name}`)
  }
  return { entry: 'dist/client/index.js', styles }
}

describe('client asset resolution', () => {
  it('resolves the entry and styles of a declared client module', () => {
    const dir = makePackage()
    const { entry, styles } = writeClientFiles(dir, { styles: { 'index.css': 32, 'theme.css': 16 } })
    const resolved = resolveClientAssets(dir, manifestWith({ entry, styles }))
    expect(resolved?.entryPath).toBe(realpathSync(join(dir, 'dist', 'client', 'index.js')))
    // styles 保序，与声明顺序一致。
    expect(resolved?.stylePaths).toEqual(styles.map((p) => realpathSync(join(dir, p))))
  })
  it('accepts ./-prefixed paths and reports no client when none is declared', () => {
    const dir = makePackage()
    writeClientFiles(dir, { styles: { 'index.css': 32 } })
    const resolved = resolveClientAssets(
      dir,
      manifestWith({ entry: './dist/client/index.js', styles: ['./dist/client/index.css'] }),
    )
    expect(resolved?.entryPath).toBe(realpathSync(join(dir, 'dist', 'client', 'index.js')))
    expect(resolveClientAssets(dir, manifestWith(undefined, []))).toBeUndefined()
  })
  it('rejects paths that are absolute, escaping, or not portable', () => {
    const dir = makePackage()
    writeClientFiles(dir)
    for (const entry of [
      '/etc/passwd.js',
      '../outside.js',
      'dist/../agnes.extension.json',
      './dist/../index.mjs',
      'dist\\client\\index.js',
      'C:dist/client/index.js',
      'dist/client/index.js\0',
      'dist//client/index.js',
      'dist/./client/index.js',
      '',
      './',
    ])
      expect(() => resolveClientAssets(dir, manifestWith({ entry })), JSON.stringify(entry)).toThrow(
        /not a portable relative path|cannot be resolved/,
      )
  })
  it('requires a JavaScript entry and CSS-only declared styles', () => {
    const dir = makePackage()
    writeClientFiles(dir, { styles: { 'index.css': 16 } })
    for (const bad of [
      'dist/client/index.svg',
      'dist/client/index.txt',
      'dist/client/index',
      'dist/client/index.css',
      'dist/client/index.map',
    ])
      expect(() => resolveClientAssets(dir, manifestWith({ entry: bad })), bad).toThrow(
        /not valid for this field/,
      )
    for (const badStyle of ['x.png', 'x.js', 'x.mjs', 'x.map']) {
      writeFileSync(join(dir, 'dist', 'client', badStyle), Buffer.alloc(4, 1))
      expect(() =>
        resolveClientAssets(
          dir,
          manifestWith({ entry: 'dist/client/index.js', styles: [`dist/client/${badStyle}`] }),
        ),
      ).toThrow(/not valid for this field/)
    }
    writeFileSync(join(dir, 'dist', 'client', 'entry.mjs'), 'export {}\n')
    expect(resolveClientAssets(dir, manifestWith({ entry: 'dist/client/entry.mjs' }))).toBeDefined()
    // `.map` may be served as a transitive source-map resource, but it cannot be declared as entry/style.
    expect(CLIENT_ASSET_EXTENSIONS).toEqual(['js', 'mjs', 'css', 'map'])
  })
  it('rejects a single file over the byte cap and allows exactly the cap', () => {
    const dir = makePackage()
    writeClientFiles(dir, { entryBytes: CLIENT_MAX_FILE_BYTES + 1 })
    expect(() => resolveClientAssets(dir, manifestWith({ entry: 'dist/client/index.js' }))).toThrow(
      /client asset is \d+ bytes, over the \d+-byte cap/,
    )
    // 恰好顶到上限是允许的：上限是闭区间。
    writeClientFiles(dir, { entryBytes: CLIENT_MAX_FILE_BYTES })
    expect(resolveClientAssets(dir, manifestWith({ entry: 'dist/client/index.js' }))).toBeDefined()
  })
  it('rejects a package whose client assets exceed the total cap', () => {
    const dir = makePackage()
    const perFile = Math.ceil(CLIENT_MAX_TOTAL_BYTES / 5)
    const { entry, styles } = writeClientFiles(dir, {
      styles: Object.fromEntries(['a.css', 'b.css', 'c.css', 'd.css', 'e.css'].map((n) => [n, perFile])),
    })
    expect(() => resolveClientAssets(dir, manifestWith({ entry, styles }))).toThrow(
      /client assets total \d+ bytes, over the \d+-byte cap/,
    )
  })
  it('rejects an entry that does not exist in the install tree', () => {
    const dir = makePackage()
    expect(() => resolveClientAssets(dir, manifestWith({ entry: 'dist/client/missing.js' }))).toThrow(
      /cannot be resolved/,
    )
  })
  it('rejects an entry that only reaches the package through a symlink', () => {
    const dir = makePackage()
    const outside = makePackage()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(outside, 'evil.js'), 'export {}\n')
    symlinkSync(join(outside, 'evil.js'), join(dir, 'dist', 'link.js'))
    expect(() => resolveClientAssets(dir, manifestWith({ entry: 'dist/link.js' }))).toThrow(
      /escapes the directory/,
    )
  })
  it('makes readManifestIn fail the package when declared client files are missing', () => {
    // 运行时读取路径（readManifestIn → checkManifest → resolveClientAssets）与 staging 走同一道门。
    const dir = makePackage()
    writeFileSync(join(dir, 'index.mjs'), 'export {}\n')
    writeFileSync(
      join(dir, 'agnes.extension.json'),
      JSON.stringify({
        id: 'agnes/example',
        version: '1.0.0',
        apiRange: '^1.1',
        entry: './index.mjs',
        capabilities: { ui: ['client'] },
        contributes: { client: { entry: 'dist/client/index.js' } },
      }),
    )
    expect(() => readManifestIn(dir)).toThrow(/cannot be resolved/)
    writeClientFiles(dir)
    expect(readManifestIn(dir)?.contributes?.client?.entry).toBe('dist/client/index.js')
  })
})

// 词法耦合（双向必备）是 checkManifest 的职责；文件系统真相归上面的 resolveClientAssets。
describe('client capability/contribution coupling', () => {
  const base = {
    id: 'agnes/example',
    version: '1.0.0',
    apiRange: '^1.1',
    entry: './index.mjs',
  }
  it('accepts a manifest that declares both sides, and one that declares neither', () => {
    expect(
      checkManifest({
        ...base,
        capabilities: { ui: ['client'] },
        contributes: { client: { entry: 'dist/client/index.js' } },
      }).ok,
    ).toBe(true)
    expect(checkManifest({ ...base, capabilities: {} }).ok).toBe(true)
    expect(checkManifest({ ...base, capabilities: { ui: ['skin'] } }).ok).toBe(false)
  })
  it('rejects a contribution without the capability and a capability without the contribution', () => {
    const withoutCapability = checkManifest({
      ...base,
      capabilities: {},
      contributes: { client: { entry: 'dist/client/index.js' } },
    })
    expect(withoutCapability.ok).toBe(false)
    if (!withoutCapability.ok)
      expect(withoutCapability.problems.join(' ')).toContain("capabilities.ui to include 'client'")
    const withoutContribution = checkManifest({ ...base, capabilities: { ui: ['client'] } })
    expect(withoutContribution.ok).toBe(false)
    if (!withoutContribution.ok)
      expect(withoutContribution.problems.join(' ')).toContain('requires a contributes.client')
    // ui 为空数组同样不满足「含 client」。
    expect(
      checkManifest({
        ...base,
        capabilities: { ui: [] },
        contributes: { client: { entry: 'dist/client/index.js' } },
      }).ok,
    ).toBe(false)
  })
})

describe('client contribution normalization', () => {
  it('keeps styles in order, dedupes and sorts the sets, and defaults missing lists to []', () => {
    const normalized = normalizeClientContribution({
      entry: './dist/client/index.js',
      styles: ['./dist/client/b.css', 'dist/client/a.css'],
      slots: ['workbench.panel', 'client.card', 'workbench.panel'],
      services: ['s.b', 's.a', 's.b'],
    })
    expect(normalized).toEqual({
      entry: 'dist/client/index.js',
      styles: ['dist/client/b.css', 'dist/client/a.css'],
      slots: ['client.card', 'workbench.panel'],
      services: ['s.a', 's.b'],
      projections: [],
    })
  })
  it('normalizes a bare entry with no optional fields', () => {
    expect(normalizeClientContribution({ entry: 'dist/client/index.js' })).toEqual({
      entry: 'dist/client/index.js',
      styles: [],
      slots: [],
      services: [],
      projections: [],
    })
  })
})

// `/plugins/*` 是本功能新增的唯一网络输入，路径权威钉在这里：web-server 无权放宽它能到达的文件。
describe('client module request resolution', () => {
  const revision = `sha256-${'a'.repeat(64)}`
  function snapshotRoot(): string {
    const root = makePackage()
    const one = join(root, 'acme', 'panel', revision)
    mkdirSync(join(one, 'dist', 'client'), { recursive: true })
    writeFileSync(join(one, 'dist', 'client', 'index.js'), 'export {}\n')
    writeFileSync(join(one, 'dist', 'client', 'index.css'), '.x{}\n')
    // 快照目录里真实存在、但不在下发白名单内的文件：扩展名这道门（而非「文件不存在」）必须拒绝它。
    writeFileSync(join(one, 'agnes.extension.json'), '{}\n')
    const two = join(root, '@scope', 'pkg', revision)
    mkdirSync(two, { recursive: true })
    writeFileSync(join(two, 'index.mjs'), 'export {}\n')
    return root
  }

  it('serves entry and styles for one-segment and two-segment package ids', () => {
    const root = snapshotRoot()
    const entry = resolveClientModuleAsset(root, `/plugins/acme/panel/${revision}/dist/client/index.js`)
    expect(entry).toBe(realpathSync(join(root, 'acme', 'panel', revision, 'dist', 'client', 'index.js')))
    expect(
      resolveClientModuleAsset(root, `/plugins/acme/panel/${revision}/dist/client/index.css`),
    ).not.toBeNull()
    expect(resolveClientModuleAsset(root, `/plugins/@scope/pkg/${revision}/index.mjs`)).toBe(
      realpathSync(join(root, '@scope', 'pkg', revision, 'index.mjs')),
    )
  })
  it('strictly decodes URL path segments without allowing encoded separators or traversal', () => {
    const root = snapshotRoot()
    const base = join(root, 'acme', 'panel', revision, 'dist', 'client')
    // Windows file names cannot contain '?', so that one character is exercised on POSIX only.
    const name = process.platform === 'win32' ? '空 格#%.js' : '空 格?#%.js'
    writeFileSync(join(base, name), 'export {}\n')
    expect(
      resolveClientModuleAsset(
        root,
        `/plugins/acme/panel/${revision}/dist/client/${encodeURIComponent(name)}`,
      ),
    ).toBe(realpathSync(join(base, name)))
    for (const encoded of ['%2e%2e', '%2Fetc', '%5Cetc', '%00'])
      expect(
        resolveClientModuleAsset(root, `/plugins/acme/panel/${revision}/dist/client/${encoded}/x.js`),
      ).toBeNull()
  })
  it('refuses the reserved _api prefix and every _-led revision segment', () => {
    const root = snapshotRoot()
    for (const pathname of [
      `/plugins/acme/panel/_api/dist/client/index.js`,
      `/plugins/acme/_api/${revision}/dist/client/index.js`,
      `/plugins/acme/panel/_next/dist/client/index.js`,
      `/plugins/@scope/pkg/_api/index.mjs`,
    ])
      expect(resolveClientModuleAsset(root, pathname), pathname).toBeNull()
  })
  it('refuses traversal, dot segments, and a dot revision', () => {
    const root = snapshotRoot()
    for (const pathname of [
      `/plugins/acme/panel/${revision}/../agnes.extension.json`,
      `/plugins/acme/panel/${revision}/dist/../../agnes.extension.json`,
      `/plugins/acme/panel/${revision}/./dist/client/index.js`,
      `/plugins/acme/panel/../panel/${revision}/dist/client/index.js`,
      `/plugins/acme/panel/./dist/client/index.js`,
      `/plugins/acme/panel/${revision}//dist/client/index.js`,
    ])
      expect(resolveClientModuleAsset(root, pathname), pathname).toBeNull()
  })
  it('refuses files outside the allowlist, unknown packages, and non-plugin prefixes', () => {
    const root = snapshotRoot()
    for (const pathname of [
      `/plugins/acme/panel/${revision}/agnes.extension.json`,
      `/plugins/acme/panel/${revision}/dist/client/missing.js`,
      `/plugins/acme/panel/${revision}/dist/client`,
      `/plugins/acme/unknown/${revision}/dist/client/index.js`,
      `/plugins/acme/panel/sha256-${'b'.repeat(64)}/dist/client/index.js`,
      `/plugins//panel/${revision}/dist/client/index.js`,
      `/plugins/ACME/panel/${revision}/dist/client/index.js`,
      `/skins/acme/panel/${revision}/dist/client/index.js`,
      '/plugins/',
    ])
      expect(resolveClientModuleAsset(root, pathname), pathname).toBeNull()
  })
  it('refuses a symlink inside the snapshot that leaves the revision directory', () => {
    const root = snapshotRoot()
    const outside = makePackage()
    writeFileSync(join(outside, 'secret.js'), 'export {}\n')
    symlinkSync(
      join(outside, 'secret.js'),
      join(root, 'acme', 'panel', revision, 'dist', 'client', 'linked.js'),
    )
    expect(resolveClientModuleAsset(root, `/plugins/acme/panel/${revision}/dist/client/linked.js`)).toBeNull()
    // 旁边真实的文件仍能裁决，说明被拒的是链接本身而不是目录。
    expect(
      resolveClientModuleAsset(root, `/plugins/acme/panel/${revision}/dist/client/index.js`),
    ).not.toBeNull()
  })
  it('refuses a revision directory that is itself a symlink out of the snapshot root', () => {
    // base 的 containment 根是它自己 realpath 后的位置；不做这道检查，被埋进快照根的符号链接
    // 目录会把裁决放行到快照根之外。
    const root = snapshotRoot()
    const outside = makePackage()
    mkdirSync(join(outside, 'dist'), { recursive: true })
    writeFileSync(join(outside, 'dist', 'served.js'), 'export {}\n')
    const planted = `sha256-${'c'.repeat(64)}`
    symlinkSync(outside, join(root, 'acme', 'panel', planted))
    expect(resolveClientModuleAsset(root, `/plugins/acme/panel/${planted}/dist/served.js`)).toBeNull()
  })
})

// 能力哈希的两条硬规则：没声明 client 的旧包摘要不多字段、哈希与旧算法逐字节一致；
// 声明了 client 的包把规范化 client 纳入哈希，只改集合也必须动哈希。
describe('client capability hash integration', () => {
  function staged(manifest: Record<string, unknown>, files: Record<string, number>) {
    const dir = makePackage()
    const rowId = 'ext:agnes/example/main'
    const client = (manifest.contributes as { client?: Record<string, unknown> } | undefined)?.client
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@agnes-examples/client-hash',
        version: '1.0.0',
        agnes: {
          plugins: [{ id: rowId, export: 'main', runtime: 'in-process' }],
          ...(client ? { clientDescriptors: [{ rowId, path: './dist/agnes.client.json' }] } : {}),
        },
      }),
    )
    if (client) {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      const relativeClient = Object.fromEntries(
        Object.entries(client).map(([key, value]) => [
          key,
          key === 'entry' && typeof value === 'string'
            ? value.replace(/^\.?(?:\/)?dist\//, './')
            : key === 'styles' && Array.isArray(value)
              ? value.map((item: string) => item.replace(/^\.?(?:\/)?dist\//, './'))
              : value,
        ]),
      )
      writeFileSync(join(dir, 'dist', 'agnes.client.json'), JSON.stringify({ client: relativeClient }))
    }
    writeFileSync(join(dir, 'index.mjs'), 'export {}\n')
    for (const [name, bytes] of Object.entries(files)) {
      mkdirSync(join(dir, 'dist', 'client'), { recursive: true })
      writeFileSync(join(dir, name), Buffer.alloc(bytes, 1))
    }
    const integrity = hashDirectory(dir, { exclude: [] })
    return inspectStaged({
      dir,
      source: { type: 'file', ref: 'file:./candidate' },
      fetched: { dir, version: '1.0.0', integrity, dependencies: {} },
      ceiling: ['ui'],
    })
  }
  const baseManifest = {
    id: 'agnes/example',
    version: '1.0.0',
    apiRange: '^1.1',
    entry: './index.mjs',
  }

  it('keeps a client-less package summary free of the field and its hash identical to the old algorithm', () => {
    const { preview } = staged({ ...baseManifest, capabilities: {} }, {})
    expect(preview.contributions).toHaveLength(0)
    expect(JSON.stringify(preview.contributions)).not.toContain('"client"')
    // 旧算法基线：无 client 字段的贡献摘要 + runtimeSupports 缺省归一，逐字段照抄改动前的计算。
    const baseline = snapshotHash({ contributions: [], dependencies: {} })
    expect(preview.capabilityHash).toBe(baseline)
    expect(capabilityHash({ contributions: preview.contributions, dependencies: {} })).toBe(baseline)
  })
  it('adds the normalized client field to the summary and the hash for a declaring package', () => {
    const { preview } = staged(
      {
        ...baseManifest,
        capabilities: { ui: ['client'] },
        contributes: {
          client: {
            entry: './dist/client/index.js',
            styles: ['./dist/client/index.css'],
            slots: ['workbench.panel', 'client.card'],
            services: ['hello.query'],
          },
        },
      },
      { 'dist/client/index.js': 64, 'dist/client/index.css': 32 },
    )
    const contribution = preview.contributions[0]
    expect(contribution?.kind).toBe('client')
    if (contribution?.kind !== 'client' || !('client' in contribution))
      throw new Error('expected client contribution')
    expect(contribution.client).toEqual({
      entry: 'client/index.js',
      styles: ['client/index.css'],
      slots: ['client.card', 'workbench.panel'],
      services: ['hello.query'],
      projections: [],
    })
    const expected = capabilityHash({ contributions: preview.contributions, dependencies: {} })
    expect(preview.capabilityHash).toBe(expected)
  })
  it('moves the capability hash when only the declared services change', () => {
    const files = { 'dist/client/index.js': 64 }
    const withServices = (services: string[]) => ({
      ...baseManifest,
      capabilities: { ui: ['client'] },
      contributes: { client: { entry: 'dist/client/index.js', services } },
    })
    const first = staged(withServices(['hello.query']), files).preview.capabilityHash
    const second = staged(withServices(['hello.other']), files).preview.capabilityHash
    expect(second).not.toBe(first)
  })
  it('rejects a staged package whose declared client files are missing or oversized', () => {
    // inspect/staging 与运行时读取走同一道校验：文件系统真相在 staging 上就把坏包挡下。
    expect(() =>
      staged(
        {
          ...baseManifest,
          capabilities: { ui: ['client'] },
          contributes: { client: { entry: 'dist/client/index.js' } },
        },
        {},
      ),
    ).toThrow(/cannot be resolved/)
  })
})
