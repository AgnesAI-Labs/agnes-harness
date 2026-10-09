import { describe, expect, it } from 'vitest'
import {
  PUBLIC_PACKAGE_NAME,
  PUBLIC_PACKAGE_VERSION,
  publishableManifest,
  SUPPORTED_PLATFORMS,
} from './npx-package.js'
import { guardPackedFiles } from './pack-guard.js'
import { guardTarEntries } from './packed-tarball.js'

describe('publishable npx manifest', () => {
  it('ships @agnes/harness with the alpha version and no install-time dependencies', () => {
    const manifest = publishableManifest('darwin-arm64')
    expect(manifest.name).toBe(PUBLIC_PACKAGE_NAME)
    expect(manifest.name).toBe('@agnes/harness')
    expect(manifest.version).toBe(PUBLIC_PACKAGE_VERSION)
    expect(manifest.version).toMatch(/^0\.1\.0-alpha\.\d+$/)
    expect(manifest.bin).toEqual({ agh: './bin/agh' })
    expect(manifest.exports).toEqual({ './package.json': './package.json' })
    expect(manifest.engines).toEqual({ node: '>=24.10' })
    expect(manifest.os).toEqual(['darwin'])
    expect(manifest.cpu).toEqual(['arm64'])
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
    expect(Object.hasOwn(manifest, 'dependencies')).toBe(false)
    expect(Object.hasOwn(manifest, 'private')).toBe(false)
    expect(SUPPORTED_PLATFORMS).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ])
  })

  it('rejects a triple outside the supported set', () => {
    expect(() => publishableManifest('freebsd-x64')).toThrow(/Unsupported prebuild triple/)
  })
})

function packedFixture(): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const path of [
    'bin/agh',
    'LICENSE',
    'NOTICE',
    'README.md',
    'dist/agnes.mjs',
    'dist/daemon.mjs',
    'dist/worker.mjs',
    'dist/authoring-sdk.mjs',
    'dist/authoring-sdk-exports.json',
    'dist/prebuilds/index.json',
    'dist/prebuilds/darwin-arm64/agnes-system.node',
    'dist/vendor/@agnes/system-node/dist/native/agnes-system.node',
    'dist/vendor/esbuild/lib/main.js',
    'dist/vendor/sharp/lib/index.js',
    'dist/vendor/sharp/LICENSE',
    'dist/vendor/example/LICENSE',
    'dist/vendor/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
    'dist/vendor/@img/sharp-libvips-darwin-arm64/lib/index.js',
    'dist/vendor/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib',
    'dist/vendor/@img/sharp-libvips-darwin-arm64/README.md',
    'dist/native/pty-relay',
    'dist/native/macos-process-identity',
    'dist/native/macos-live-app-identity',
    'dist/project-notices/cordis-LICENSE',
    'dist/project-notices/cosmokit-LICENSE',
    'dist/THIRD-PARTY-NOTICES/ws.txt',
    'dist/vendor/@esbuild/darwin-arm64/bin/esbuild',
    'dist/ripgrep/LICENSE',
    'dist/ripgrep/rg',
    'dist/ripgrep/WRAPPER-LICENSE',
    'dist/THIRD-PARTY-NOTICES/computer-use-hermes.txt',
    'dist/web/THIRD-PARTY-NOTICES/ant-design-x-markdown.txt',
    'dist/bundled-plugins/document-reader/LICENSE',
    'dist/bundled-plugins/skill-helper/LICENSE',
    'dist/web/app.js',
    'dist/web/vendor/react.js',
  ])
    files.set(path, Buffer.from('runtime payload'))
  files.set('dist/vendor/sharp/package.json', Buffer.from('{"name":"sharp"}'))
  files.set('dist/license-provenance/sources.json', Buffer.from('[]'))
  for (const directory of [
    'dist',
    'dist/authoring',
    'dist/web',
    'dist/bundled-plugins/document-reader/src/runtime',
  ])
    files.set(`${directory}/THIRD-PARTY-NOTICES/index.json`, Buffer.from('[]'))
  files.set('bin/agh', Buffer.from('#!/usr/bin/env node\n'))
  files.set('package.json', Buffer.from(JSON.stringify(publishableManifest('darwin-arm64'))))
  for (const page of ['index', 'admin', 'resources'])
    files.set(
      `dist/web/${page}.html`,
      Buffer.from(
        '<html><script type="importmap">{"imports":{"react":"/vendor/react.js"}}</script><script src="/app.js"></script></html>',
      ),
    )
  return files
}

describe('pack guard', () => {
  it('accepts a self-contained prebuilt candidate', () => {
    expect(() => guardPackedFiles(packedFixture(), 'darwin-arm64')).not.toThrow()
  })

  it.each([
    ['workspace dependency', { dependencies: { example: 'workspace:*' } }, /Workspace protocol/],
    ['dev dependency metadata', { devDependencies: { typescript: '7.0.2' } }, /Development-only payload/],
    ['dev tool in runtime dependencies', { dependencies: { vitest: '5.0.0' } }, /Development-only runtime/],
    ['local dependency', { dependencies: { example: 'file:../../../private' } }, /Development-only runtime/],
    [
      'linked dependency',
      { optionalDependencies: { example: 'link:../private' } },
      /Development-only runtime/,
    ],
    [
      'dev peer dependency',
      { peerDependencies: { '@playwright/test': '1.0.0' } },
      /Development-only runtime/,
    ],
    ['missing runtime dependency', { dependencies: { missing: '1.0.0' } }, /Missing or empty/],
    ['install script', { scripts: { postinstall: 'node build.js' } }, /Install\/build scripts/],
    ['missing conditional export', { exports: { '.': { import: './missing.js' } } }, /Missing or empty/],
    ['missing wildcard export', { exports: { './*': './missing/*.js' } }, /Missing export/],
    ['escaping export', { exports: '../outside.js' }, /Escaping package target/],
    ['dev tool shipped as a package', { name: 'typescript' }, /Development-only payload/],
  ])('rejects %s in an embedded runtime manifest', (_name, manifest, message) => {
    const files = packedFixture()
    files.set('dist/vendor/example/package.json', Buffer.from(JSON.stringify(manifest)))
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(message)
  })

  it.each([
    'LICENSE',
    'NOTICE',
    'dist/vendor/sharp/lib/index.js',
    'dist/worker.mjs',
    'dist/prebuilds/darwin-arm64/agnes-system.node',
    'dist/web/app.js',
    'dist/web/vendor/react.js',
    'dist/native/pty-relay',
    'dist/ripgrep/rg',
    'dist/vendor/@img/sharp-libvips-darwin-arm64/lib/index.js',
    'dist/authoring/THIRD-PARTY-NOTICES/index.json',
  ])('rejects missing %s in the actual tarball', (path) => {
    const files = packedFixture()
    files.delete(path)
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Missing or empty packed file/)
  })

  it('rejects a vendor package without its license', () => {
    const files = packedFixture()
    files.delete('dist/vendor/sharp/LICENSE')
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Missing vendor license/)
  })

  it.each(['missing.js', '../outside.js'])('rejects broken Web chunk import %s', (target) => {
    const files = packedFixture()
    files.set('dist/web/app.js', Buffer.from(`import './${target}'`))
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Missing or empty|Escaping Web import/)
  })

  it('accepts prebuilt Web chunks and rejects missing inventoried notices', () => {
    const files = packedFixture()
    files.set('dist/web/app.js', Buffer.from("export { app } from './chunk.js'"))
    files.set('dist/web/chunk.js', Buffer.from('export const app = 1'))
    expect(() => guardPackedFiles(files, 'darwin-arm64')).not.toThrow()
    files.set('dist/THIRD-PARTY-NOTICES/index.json', Buffer.from('[{"file":"missing-license.txt"}]'))
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Missing or empty packed file/)
  })

  it.each([
    { exports: undefined },
    { engines: { node: '>=18' } },
    { publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' } },
  ])('rejects a changed public manifest contract: %j', (change) => {
    const files = packedFixture()
    files.set(
      'package.json',
      Buffer.from(JSON.stringify({ ...publishableManifest('darwin-arm64'), ...change })),
    )
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Unexpected candidate/)
  })

  it('rejects install-time dependencies and unusable executables', () => {
    const files = packedFixture()
    files.set(
      'package.json',
      Buffer.from(
        JSON.stringify({ ...publishableManifest('darwin-arm64'), dependencies: { yaml: '2.9.0' } }),
      ),
    )
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/no install-time dependencies/)
    files.set('package.json', Buffer.from(JSON.stringify(publishableManifest('darwin-arm64'))))
    files.set('bin/agh', Buffer.from('broken launcher'))
    expect(() => guardPackedFiles(files, 'darwin-arm64')).toThrow(/Invalid agh executable/)
  })
})

describe('tarball extraction guard', () => {
  it('accepts regular files under the package root', () => {
    expect(() => guardTarEntries(['package/', 'package/bin/agh'], ['d', '-'])).not.toThrow()
  })

  it.each([
    ['../outside', '-'],
    ['package/../../outside', '-'],
    ['/package/bin/agh', '-'],
    ['package/link', 'l'],
    ['package/hard-link', 'h'],
    ['package/pipe', 'p'],
    ['package/../package/bin/agh', '-'],
  ])('refuses %s before extraction', (path, mode) => {
    expect(() => guardTarEntries([path], [mode])).toThrow(/Unsafe tarball entry/)
  })

  it('refuses duplicate paths and incomplete inventories', () => {
    expect(() => guardTarEntries(['package/bin/agh', 'package/bin/agh'], ['-', '-'])).toThrow(/Unsafe/)
    expect(() => guardTarEntries([], [])).toThrow(/Invalid tarball inventory/)
    expect(() => guardTarEntries(['package/bin/agh'], [])).toThrow(/Invalid tarball inventory/)
  })
})
