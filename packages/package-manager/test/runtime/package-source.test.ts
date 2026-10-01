import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPackageSourceProvider,
  type PackageTransport,
} from '../../src/runtime/providers/package-source.js'
import {
  identifyPackage,
  installedDir,
  readPackageTree,
  sha256Hex,
  versionSatisfies,
  ZERO_DIGEST,
} from '../../src/runtime/source-snapshot.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function writeTree(
  root: string,
  packageId: string,
  version: string,
  extra: Record<string, unknown> = {},
  files: Record<string, string> = { 'readme.txt': 'hello' },
): string {
  const dir = join(root, packageId, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: packageId, version, ...extra }))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

function requirement(packageId: string, versionRange: string, sourceId?: string) {
  return { packageId, versionRange, sourceIds: sourceId === undefined ? [] : [sourceId] }
}

describe('package tree identity', () => {
  it('accepts the semver ranges used by a lock', () => {
    const rows: Array<[string, string, boolean]> = [
      ['1.2.3', '^1.2.3', true],
      ['2.0.0', '^1.2.3', false],
      ['1.2.3', '^1.2.4', false],
      ['0.1.9', '^0.1.2', true],
      ['0.2.0', '^0.1.2', false],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['1.2.9', '~1.2.3', true],
      ['1.3.0', '~1.2.3', false],
      ['1.0.0', '*', true],
      ['1.0.0-beta', '*', false],
      ['1.5.0', '>=1.0.0 <2.0.0', true],
      ['2.0.0', '>=1.0.0 <2.0.0', false],
      ['1.2.3', '1.2.3', true],
      ['1.2.4', '1.2.3', false],
      ['1.3.0-beta.1', '1.3.0-beta.1', true],
      ['1.3.0-beta.1', '^1.0.0', false],
    ]
    for (const [version, range, expected] of rows) {
      expect(versionSatisfies(version, range), `${version} ${range}`).toBe(expected)
    }
  })

  it('replaces a self-reported digest and does not run the package entry', () => {
    const root = temp('pkg-tree-')
    const marker = join(root, 'ran')
    const dir = writeTree(
      root,
      'acme.tools',
      '1.2.3',
      {
        packageDigest: 'ab'.repeat(32),
        entry: 'postinstall.js',
      },
      {
        'postinstall.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
      },
    )
    const tree = readPackageTree(dir)
    expect(tree.ok).toBe(true)
    if (!tree.ok) return
    const identified = identifyPackage(tree.value)
    expect(identified.ok).toBe(true)
    if (!identified.ok) return
    expect(identified.value.claimedPackageDigest).toBe('ab'.repeat(32))
    expect(identified.value.treeDigest).not.toBe(identified.value.claimedPackageDigest)
    expect(identified.value.treeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(identified.value.manifest.packageDigest).toBe(identified.value.treeDigest)
    expect(existsSync(marker)).toBe(false)
    expect(identified.value.integrity).toBe(`sha256-${identified.value.archiveDigest}`)
    expect(ZERO_DIGEST).toHaveLength(64)
  })

  it('refuses a symbolic link that leaves the package root', () => {
    const root = temp('pkg-link-')
    const outside = temp('pkg-outside-')
    writeFileSync(join(outside, 'secret'), 'nope')
    const dir = writeTree(root, 'acme.tools', '1.0.0')
    symlinkSync(join(outside, 'secret'), join(dir, 'escape'))
    const tree = readPackageTree(dir)
    expect(tree.ok).toBe(false)
    if (tree.ok) return
    expect(tree.detailCode).toBe('symlink_escape')
  })
})

describe('local package source', () => {
  it('reads an authorized snapshot and ignores a later edit until refresh', async () => {
    const root = temp('pkg-local-')
    const cache = join(root, 'cache')
    const source = join(root, 'source')
    writeTree(source, 'acme.tools', '1.0.0', {}, { 'readme.txt': 'one' })
    const provider = createPackageSourceProvider({
      cacheDir: cache,
      localRoots: { local: source },
      allowedFeatures: ['read'],
      allowedScopes: ['workspace'],
    })
    const refreshed = await provider.refreshCatalog({
      sourceId: 'local',
      requirements: [requirement('acme.tools', '^1.0.0', 'local')],
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.value.catalogRevision).toBe(1)
    expect(refreshed.value.diagnosticIds).toEqual([])
    const discovered = provider.discover({ query: 'acme', cursor: null, limit: 10 })
    expect(discovered.ok).toBe(true)
    if (!discovered.ok) return
    expect(discovered.value.items).toHaveLength(1)
    const item = discovered.value.items[0]
    expect(item?.digest).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(source, 'acme.tools', '1.0.0', 'readme.txt'), 'tampered')
    const again = provider.discover({ query: '', cursor: null, limit: 10 })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.items[0]?.digest).toBe(item?.digest)
    expect(provider.networkReads()).toBe(0)
    expect(provider.processSpawns()).toBe(0)
    expect(provider.executedEntries()).toEqual([])
    const metadata = provider.resolveMetadata({ packageId: 'acme.tools', version: '1.0.0' })
    expect(metadata.ok).toBe(true)
    if (!metadata.ok) return
    expect(metadata.value.digest).toBe(item?.digest)
    expect(metadata.value.provenance.trustLabels).toEqual(['content-addressed'])
    const fetched = await provider.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(fetched.ok).toBe(true)
    if (!fetched.ok) return
    expect(fetched.value.verifiedDigest).toBe(item?.digest)
    expect(existsSync(installedDir(cache))).toBe(false)
    const staged = join(cache, 'staging', item?.digest ?? '', 'archive.tar')
    expect(existsSync(staged)).toBe(true)
    const owner = readFileSync(join(cache, 'staging', item?.digest ?? '', 'OWNER'), 'utf8')
    expect(owner).toBe(provider.providerId)
    const reused = await provider.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(reused.ok).toBe(true)
    expect(provider.networkReads()).toBe(0)
    const snapshot = JSON.parse(readFileSync(join(cache, 'snapshot.json'), 'utf8')) as {
      recovery: Array<{ phase: string; packageId: string }>
    }
    expect(snapshot.recovery.some((row) => row.phase === 'reused' && row.packageId === 'acme.tools')).toBe(
      true,
    )
  })

  it('refuses a bad cursor, a missing package, an identity mismatch, and a disposed provider', async () => {
    const root = temp('pkg-refuse-')
    const source = join(root, 'source')
    writeTree(source, 'acme.tools', '1.0.0', { id: 'other.pkg' })
    const provider = createPackageSourceProvider({
      cacheDir: join(root, 'cache'),
      localRoots: { local: source },
    })
    const invalid = provider.discover({})
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.detailCode).toBe('schema_invalid')
    const refreshed = await provider.refreshCatalog({
      sourceId: 'local',
      requirements: [requirement('acme.tools', '1.0.0')],
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.value.diagnosticIds).toContain('identity_mismatch:acme.tools')
    expect(refreshed.value.candidateRefs).toEqual([])
    const missing = provider.resolveMetadata({ packageId: 'acme.tools', version: '1.0.0' })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.detailCode).toBe('cache_miss')
    const badCursor = provider.discover({ query: '', cursor: 'next', limit: 1 })
    expect(badCursor.ok).toBe(false)
    if (badCursor.ok) return
    expect(badCursor.detailCode).toBe('schema_invalid')
    provider.dispose()
    const disposed = provider.discover({ query: '', cursor: null, limit: 1 })
    expect(disposed.ok).toBe(false)
    if (disposed.ok) return
    expect(disposed.detailCode).toBe('provider_disposed')
    const sibling = createPackageSourceProvider({
      cacheDir: join(root, 'sibling'),
      localRoots: { local: source },
    })
    const open = sibling.discover({ query: '', cursor: null, limit: 1 })
    expect(open.ok).toBe(true)
  })

  it('keeps an interrupted fetch partial and verifies the bytes on the next fetch', async () => {
    const root = temp('pkg-recover-')
    const source = join(root, 'source')
    const cache = join(root, 'cache')
    writeTree(source, 'acme.tools', '1.0.0')
    const admitted = createPackageSourceProvider({ cacheDir: cache, localRoots: { local: source } })
    const refreshed = await admitted.refreshCatalog({
      sourceId: 'local',
      requirements: [requirement('acme.tools', '1.0.0')],
    })
    expect(refreshed.ok).toBe(true)
    const found = admitted.discover({ query: '', cursor: null, limit: 5 })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    const item = found.value.items[0]
    expect(item).toBeDefined()
    rmSync(join(cache, 'staging'), { recursive: true, force: true })
    const limited = createPackageSourceProvider({
      cacheDir: cache,
      localRoots: { local: source },
      stageByteLimit: 8,
    })
    const interrupted = await limited.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(interrupted.ok).toBe(false)
    if (interrupted.ok) return
    expect(interrupted.detailCode).toBe('operation_cancelled')
    const digest = item?.digest ?? ''
    expect(existsSync(join(cache, 'staging', digest, 'PARTIAL'))).toBe(true)
    expect(existsSync(join(cache, 'staging', digest, 'archive.tar'))).toBe(false)
    expect(readFileSync(join(cache, 'staging', digest, 'OWNER'), 'utf8')).toBe(limited.providerId)
    expect(existsSync(installedDir(cache))).toBe(false)
    limited.cancel()
    const cancelled = await limited.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(cancelled.ok).toBe(false)
    if (cancelled.ok) return
    expect(cancelled.detailCode).toBe('operation_cancelled')
    const recovered = createPackageSourceProvider({ cacheDir: cache, localRoots: { local: source } })
    const fetched = await recovered.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(fetched.ok).toBe(true)
    if (!fetched.ok) return
    expect(fetched.value.verifiedDigest).toBe(digest)
    expect(existsSync(join(cache, 'staging', digest, 'archive.tar'))).toBe(true)
    expect(existsSync(join(cache, 'staging', digest, 'PARTIAL'))).toBe(false)
    expect(existsSync(installedDir(cache))).toBe(false)
    const restarted = createPackageSourceProvider({ cacheDir: cache, localRoots: { local: source } })
    const page = restarted.discover({ query: 'acme.tools', cursor: null, limit: 5 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.items[0]?.digest).toBe(digest)
  })

  it('reports two tree digests for one version as a conflict', async () => {
    const root = temp('pkg-conflict-')
    const left = join(root, 'left')
    const right = join(root, 'right')
    writeTree(left, 'acme.tools', '1.0.0', {}, { 'readme.txt': 'left' })
    writeTree(right, 'acme.tools', '1.0.0', {}, { 'readme.txt': 'right' })
    const provider = createPackageSourceProvider({
      cacheDir: join(root, 'cache'),
      localRoots: { left, right },
    })
    expect(
      (
        await provider.refreshCatalog({
          sourceId: 'left',
          requirements: [requirement('acme.tools', '1.0.0')],
        })
      ).ok,
    ).toBe(true)
    expect(
      (
        await provider.refreshCatalog({
          sourceId: 'right',
          requirements: [requirement('acme.tools', '1.0.0')],
        })
      ).ok,
    ).toBe(true)
    const metadata = provider.resolveMetadata({ packageId: 'acme.tools', version: '1.0.0' })
    expect(metadata.ok).toBe(false)
    if (metadata.ok) return
    expect(metadata.detailCode).toBe('content_identity_mismatch')
  })
})

describe('npm and git package sources', () => {
  it('stages an npm archive from a local registry and rejects a mismatched integrity', async () => {
    const root = temp('pkg-npm-')
    const source = join(root, 'source')
    writeTree(source, 'acme.tools', '1.0.0', {}, { 'readme.txt': 'registry' })
    const tree = readPackageTree(join(source, 'acme.tools', '1.0.0'))
    expect(tree.ok).toBe(true)
    if (!tree.ok) return
    const identified = identifyPackage(tree.value)
    expect(identified.ok).toBe(true)
    if (!identified.ok) return
    const archive = identified.value.archive
    const server = createServer((request, response) => {
      const url = request.url ?? ''
      if (url.endsWith('/acme.tools')) {
        response.end(
          JSON.stringify({
            versions: {
              '1.0.0': {
                integrity: `sha256-${sha256Hex(archive)}`,
                dist: { tarball: 'http://127.0.0.1/tarball.tgz' },
              },
            },
          }),
        )
        return
      }
      response.end(archive)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('registry did not bind')
    const registry = `http://127.0.0.1:${address.port}`
    const cache = join(root, 'cache')
    const provider = createPackageSourceProvider({
      cacheDir: cache,
      npmRegistries: { npm: registry },
      transport: {
        async get(url: string) {
          const response = await fetch(url.replace('http://127.0.0.1/tarball.tgz', `${registry}/tarball.tgz`))
          return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
        },
      } satisfies PackageTransport,
    })
    const before = provider.networkReads()
    const refreshed = await provider.refreshCatalog({
      sourceId: 'npm',
      requirements: [requirement('acme.tools', '1.0.0', 'npm')],
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(provider.networkReads()).toBeGreaterThan(before)
    const found = provider.discover({ query: '', cursor: null, limit: 5 })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    const reads = provider.networkReads()
    expect(provider.resolveMetadata({ packageId: 'acme.tools', version: '1.0.0' }).ok).toBe(true)
    expect(provider.networkReads()).toBe(reads)
    const item = found.value.items[0]
    const fetched = await provider.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(fetched.ok).toBe(true)
    expect(provider.networkReads()).toBe(reads)
    expect(existsSync(installedDir(cache))).toBe(false)

    const mismatch = createPackageSourceProvider({
      cacheDir: join(root, 'mismatch'),
      npmRegistries: { npm: registry },
      transport: {
        async get(url: string) {
          if (url.includes('acme.tools')) {
            return {
              status: 200,
              body: Buffer.from(
                JSON.stringify({
                  versions: {
                    '1.0.0': {
                      integrity: `sha256-${'c'.repeat(64)}`,
                      dist: { tarball: `${registry}/tarball.tgz` },
                    },
                  },
                }),
              ),
            }
          }
          return { status: 200, body: archive }
        },
      },
    })
    const denied = await mismatch.refreshCatalog({
      sourceId: 'npm',
      requirements: [requirement('acme.tools', '1.0.0')],
    })
    expect(denied.ok).toBe(true)
    if (!denied.ok) return
    expect(denied.value.diagnosticIds).toContain('integrity_mismatch:acme.tools')
    expect(denied.value.candidateRefs).toEqual([])
  })

  it('checks out a full git commit and refuses a branch name', async () => {
    const root = temp('pkg-git-')
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: repo })
    writeTree(repo, 'acme.tools', '1.0.0', {}, { 'readme.txt': 'from-git' })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'package'], { cwd: repo })
    const pinned = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    writeFileSync(
      join(repo, 'catalog.json'),
      JSON.stringify({
        packages: [
          { packageId: 'acme.tools', version: '1.0.0', commit: pinned, subdirectory: 'acme.tools/1.0.0' },
          { packageId: 'acme.other', version: '1.0.0', commit: 'main', subdirectory: '.' },
        ],
      }),
    )
    execFileSync('git', ['add', 'catalog.json'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'catalog'], { cwd: repo })
    const provider = createPackageSourceProvider({
      cacheDir: join(root, 'cache'),
      gitRepositories: { origin: repo },
    })
    const refreshed = await provider.refreshCatalog({
      sourceId: 'origin',
      requirements: [requirement('acme.tools', '1.0.0'), requirement('acme.other', '1.0.0')],
    })
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return
    expect(refreshed.value.diagnosticIds).toContain('git_ref_not_commit:acme.other')
    expect(provider.processSpawns()).toBeGreaterThan(0)
    const found = provider.discover({ query: 'acme.tools', cursor: null, limit: 5 })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.items).toHaveLength(1)
    const item = found.value.items[0]
    expect(item?.locator).toMatchObject({ kind: 'git', commit: pinned, subdirectory: 'acme.tools/1.0.0' })
    const fetched = await provider.fetch({ locator: item?.locator, expectedDigest: item?.digest })
    expect(fetched.ok).toBe(true)
    expect(provider.executedEntries()).toEqual([])
    expect(existsSync(installedDir(join(root, 'cache')))).toBe(false)
    writeFileSync(join(repo, 'acme.tools', '1.0.0', 'readme.txt'), 'moved-head')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'move head'], { cwd: repo })
    const reread = createPackageSourceProvider({
      cacheDir: join(root, 'cache'),
      gitRepositories: { origin: repo },
    })
    const stable = reread.discover({ query: 'acme.tools', cursor: null, limit: 5 })
    expect(stable.ok).toBe(true)
    if (!stable.ok) return
    expect(stable.value.items[0]?.digest).toBe(item?.digest)
    expect(stable.value.items[0]?.locator).toMatchObject({ commit: pinned })
  })
})
