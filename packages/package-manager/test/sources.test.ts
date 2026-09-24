import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ExecFn, fetchSource, hashDirectory, packageDir, parseSource } from '../src/sources.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('parseSource', () => {
  it('accepts pinned npm and credential-free HTTPS git refs', () => {
    expect(parseSource('npm:@agnes/base@1.2.3')).toEqual({
      type: 'npm',
      ref: 'npm:@agnes/base@1.2.3',
    })
    expect(parseSource('npm:plain-name@1.2.3-beta.1+build.7')).toMatchObject({ type: 'npm' })
    expect(parseSource('git:https://example.com/x.git#0123456789012345678901234567890123456789')).toEqual({
      type: 'git',
      ref: 'git:https://example.com/x.git#0123456789012345678901234567890123456789',
    })
  })

  it.each([
    'npm:@agnes/base',
    'npm:@agnes/base@latest',
    'npm:@agnes/base@^1.2.3',
    'npm:@agnes/base@1.2',
    'npm:@agnes/base@1.2.3-01',
    'git:http://example.com/x.git#0123456789012345678901234567890123456789',
    'git:https://user:password@example.com/x.git#0123456789012345678901234567890123456789',
    'git:https://example.com/x.git#main',
    'git:https://example.com/x.git?token=x#0123456789012345678901234567890123456789',
  ])('refuses an unpinned or unsafe network source: %s', (source) => {
    expect(() => parseSource(source)).toThrow()
  })

  it('accepts contained local forms and refuses traversal spellings', () => {
    expect(parseSource('file:./vendor/x')).toEqual({ type: 'file', ref: 'file:./vendor/x' })
    expect(parseSource('workspace:extensions/sales')).toEqual({
      type: 'workspace',
      ref: 'workspace:extensions/sales',
    })
    for (const source of [
      'file:/tmp/x',
      'file:../x',
      'file:.',
      'file:.\\x',
      'workspace:/extensions/x',
      'workspace:extensions/../x',
      'workspace:other/x',
    ])
      expect(() => parseSource(source), source).toThrow()
    expect(() => parseSource('market:kiwi/x@1.0.0')).toThrow(/E_PACKAGE_SOURCE/)
    expect(() => parseSource('other:x')).toThrow(/unknown package source/)
  })
})

// Task 24 Step 8 delivers packageDir alone: fetchSource / parseSource / hashDirectory are Task 14
// and nothing here may rely on them.
describe('packageDir', () => {
  it('nests a package under the profile packages dir, flattening the scope separator to __', () => {
    expect(packageDir('/data', 'local-dev', '@agnes/base')).toBe(
      join('/data', 'profiles', 'local-dev', 'packages', '@agnes__base'),
    )
  })

  it('keeps an unscoped id as-is', () => {
    expect(packageDir('/data', 'local-dev', 'acme')).toBe(
      join('/data', 'profiles', 'local-dev', 'packages', 'acme'),
    )
  })

  it('refuses an id that escapes the packages root', () => {
    // Any '/' in the id is flattened to __ before the join, so the only real escape is a
    // slash-free id that is itself a climb segment.
    expect(() => packageDir('/data', 'local-dev', '..')).toThrow(/escapes packages dir/)
  })

  it('refuses an id that climbs out after the separator is flattened', () => {
    expect(() => packageDir('/data', 'local-dev', 'a/../../..')).toThrow(/escapes packages dir/)
  })

  it('does not refuse an id whose __-flattened segment merely looks like a climb', () => {
    expect(packageDir('/data', 'local-dev', 'a__/b')).toBe(
      join('/data', 'profiles', 'local-dev', 'packages', 'a____b'),
    )
  })

  it('refuses a profile traversal and malformed package ids', () => {
    expect(() => packageDir('/data', '../other', 'acme')).toThrow(/invalid profile/)
    expect(() => packageDir('/data', 'local-dev', 'a//b')).toThrow(/invalid package id/)
    expect(() => packageDir('/data', 'local-dev', '@scope/name/extra')).toThrow(/invalid package id/)
  })
})

describe('hashDirectory', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-hash-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is deterministic, path-sensitive, and excludes only the configured trees', () => {
    mkdirSync(join(root, 'z'))
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true })
    mkdirSync(join(root, 'fixtures', 'out'), { recursive: true })
    writeFileSync(join(root, 'z', 'b'), 'two')
    writeFileSync(join(root, 'a'), 'one')
    writeFileSync(join(root, 'node_modules', 'ignored', 'x'), 'ignored')
    writeFileSync(join(root, 'fixtures', 'out', 'x'), 'ignored')
    const first = hashDirectory(root)
    expect(first).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(hashDirectory(root)).toBe(first)
    writeFileSync(join(root, 'node_modules', 'ignored', 'x'), 'changed but excluded')
    expect(hashDirectory(root)).toBe(first)
    writeFileSync(join(root, 'z', 'b'), 'changed')
    expect(hashDirectory(root)).not.toBe(first)
  })

  it('refuses symlinks and special entries instead of hashing outside the tree', () => {
    const outside = join(dirname(root), `${Date.now()}-outside`)
    const rootAlias = `${root}-alias`
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => hashDirectory(rootAlias)).toThrow(/symbolic link/)
      symlinkSync(outside, join(root, 'escape'))
      expect(() => hashDirectory(root)).toThrow(/symbolic link/)
    } finally {
      rmSync(outside, { force: true })
      unlinkSync(rootAlias)
    }
  })
})

describe('fetchSource', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-source-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies a file source atomically, omits excluded trees, and returns checked metadata', async () => {
    const into = join(dir, 'installed')
    const fetched = await fetchSource(parseSource('file:./pkg-a'), into, { cwd: fixtures })
    expect(fetched).toMatchObject({
      dir: into,
      version: '1.0.0',
      license: 'MIT',
      dependencies: { '@agnes/extension-api': '^1.0.0' },
    })
    expect(fetched.integrity).toBe(hashDirectory(into))
    expect(readFileSync(join(into, 'package.json'), 'utf8')).toContain('acme/pkg-a')
  })

  it('fails closed on an escaping source symlink and leaves no destination or stage', async () => {
    const cwd = join(dir, 'cwd')
    const outside = join(dir, 'outside')
    mkdirSync(cwd)
    mkdirSync(outside)
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'acme/out', version: '1.0.0' }))
    symlinkSync(outside, join(cwd, 'pkg'), process.platform === 'win32' ? 'junction' : 'dir')
    const into = join(dir, 'installed')
    await expect(fetchSource(parseSource('file:./pkg'), into, { cwd })).rejects.toThrow(/symbolic link/)
    expect(existsSync(into)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('.agnes-fetch-'))).toBe(false)
  })

  it('refuses an included symlink and never replaces an existing destination', async () => {
    const cwd = join(dir, 'cwd')
    const source = join(cwd, 'pkg')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'acme/pkg', version: '1.0.0' }))
    writeFileSync(join(dir, 'outside'), 'secret')
    symlinkSync(join(dir, 'outside'), join(source, 'escape'))
    await expect(fetchSource(parseSource('file:./pkg'), join(dir, 'bad'), { cwd })).rejects.toThrow(
      /symbolic link/,
    )
    expect(existsSync(join(dir, 'bad'))).toBe(false)

    const into = join(dir, 'existing')
    mkdirSync(into)
    writeFileSync(join(into, 'sentinel'), 'keep')
    await expect(fetchSource(parseSource('file:./pkg'), into, { cwd })).rejects.toThrow(/destination exists/)
    expect(readFileSync(join(into, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('treats a dangling destination symlink as occupied', async () => {
    const into = join(dir, 'dangling')
    symlinkSync(join(dir, 'missing'), into)
    await expect(fetchSource(parseSource('file:./pkg-a'), into, { cwd: fixtures })).rejects.toThrow(
      /destination exists/,
    )
    expect(lstatSync(into).isSymbolicLink()).toBe(true)
  })

  it('names the resolution root when a file source is missing there, not the process cwd', async () => {
    const cwd = join(dir, 'daemon-workspace')
    mkdirSync(cwd)
    const resolvedRoot = realpathSync(cwd)
    let caught: unknown
    try {
      await fetchSource(parseSource('file:./missing-pkg'), join(dir, 'installed'), { cwd })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(resolvedRoot)
    expect((caught as { detail?: { workspaceRoot?: string } }).detail?.workspaceRoot).toBe(resolvedRoot)
  })

  it('does not copy excluded local trees', async () => {
    const cwd = join(dir, 'cwd')
    const source = join(cwd, 'pkg')
    for (const path of ['node_modules/dependency', '.git/objects', 'fixtures/out'])
      mkdirSync(join(source, path), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'acme/pkg', version: '1.0.0' }))
    writeFileSync(join(source, 'node_modules', 'dependency', 'index.js'), 'ignored')
    writeFileSync(join(source, '.git', 'objects', 'object'), 'ignored')
    writeFileSync(join(source, 'fixtures', 'out', 'generated'), 'ignored')
    const into = join(dir, 'clean')
    await fetchSource(parseSource('file:./pkg'), into, { cwd })
    expect(existsSync(join(into, 'node_modules'))).toBe(false)
    expect(existsSync(join(into, '.git'))).toBe(false)
    expect(existsSync(join(into, 'fixtures', 'out'))).toBe(false)
  })

  it('verifies npm tarball SRI, exact version, release time, and --ignore-scripts', async () => {
    const bytes = Buffer.from('synthetic npm tarball')
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const calls: Array<[string, string[]]> = []
    let releasedAt = '2026-08-30T00:00:00.000Z'
    const exec: ExecFn = async (command, args) => {
      calls.push([command, [...args]])
      if (args[0] === 'pack') {
        const destination = args[args.indexOf('--pack-destination') + 1]
        if (!destination) throw new Error('missing pack destination')
        writeFileSync(join(destination, 'pkg.tgz'), bytes)
        return { stdout: JSON.stringify([{ filename: 'pkg.tgz', integrity, version: '1.2.3' }]) }
      }
      return { stdout: JSON.stringify({ '1.2.3': releasedAt }) }
    }
    const extract = vi.fn(async (_tgz: string, into: string) => {
      mkdirSync(into, { recursive: true })
      writeFileSync(
        join(into, 'package.json'),
        JSON.stringify({ name: '@agnes/base', version: '1.2.3', license: 'MIT', dependencies: {} }),
      )
    })
    const into = join(dir, 'npm')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, { cwd: dir, exec, extract }),
    ).resolves.toMatchObject({
      dir: into,
      integrity,
      version: '1.2.3',
      releasedAt: '2026-08-30T00:00:00.000Z',
    })
    expect(calls[0]).toEqual([
      'npm',
      ['pack', '@agnes/base@1.2.3', '--pack-destination', expect.any(String), '--ignore-scripts', '--json'],
    ])
    expect(extract).toHaveBeenCalledOnce()

    releasedAt = '2026-02-31T00:00:00Z'
    const invalidTimeTarget = join(dir, 'npm-invalid-time')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), invalidTimeTarget, { cwd: dir, exec, extract }),
    ).rejects.toThrow(/release time/)
    expect(existsSync(invalidTimeTarget)).toBe(false)
  })

  it('rejects npm integrity metadata that does not match the tarball before extraction', async () => {
    const extract = vi.fn(async () => undefined)
    const exec: ExecFn = async (_command, args) => {
      if (args[0] !== 'pack') return { stdout: '{}' }
      const destination = args[args.indexOf('--pack-destination') + 1]
      if (!destination) throw new Error('missing pack destination')
      writeFileSync(join(destination, 'pkg.tgz'), 'tampered')
      return {
        stdout: JSON.stringify([{ filename: 'pkg.tgz', integrity: 'sha512-YWJj', version: '1.2.3' }]),
      }
    }
    const into = join(dir, 'npm-bad')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, { cwd: dir, exec, extract }),
    ).rejects.toThrow(/E_PACKAGE_INTEGRITY/)
    expect(extract).not.toHaveBeenCalled()
    expect(existsSync(into)).toBe(false)
  })

  it('extracts a checked npm archive through the default extractor', async () => {
    const archiveRoot = join(dir, 'archive-root')
    const packageRoot = join(archiveRoot, 'package')
    const tarball = join(dir, 'fixture.tgz')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@agnes/base', version: '1.2.3', license: 'MIT', dependencies: {} }),
    )
    execFileSync('tar', ['-czf', tarball, '-C', archiveRoot, 'package'])
    const bytes = readFileSync(tarball)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const exec: ExecFn = async (_command, args) => {
      if (args[0] === 'pack') {
        const destination = args[args.indexOf('--pack-destination') + 1]
        if (!destination) throw new Error('missing pack destination')
        writeFileSync(join(destination, 'pkg.tgz'), bytes)
        return { stdout: JSON.stringify([{ filename: 'pkg.tgz', integrity, version: '1.2.3' }]) }
      }
      return { stdout: JSON.stringify({ '1.2.3': '2026-08-30T00:00:00Z' }) }
    }
    const into = join(dir, 'npm-default')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, { cwd: dir, exec }),
    ).resolves.toMatchObject({ dir: into, integrity, version: '1.2.3' })
    expect(readFileSync(join(into, 'package.json'), 'utf8')).toContain('@agnes/base')
  })

  it.each(['npm-symlink.tgz', 'npm-hardlink.tgz'])(
    'rejects links in %s before extraction',
    async (archive) => {
      const bytes = readFileSync(join(fixtures, archive))
      const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
      const exec: ExecFn = async (_command, args) => {
        if (args[0] !== 'pack') return { stdout: '{}' }
        const destination = args[args.indexOf('--pack-destination') + 1]
        if (!destination) throw new Error('missing pack destination')
        writeFileSync(join(destination, 'pkg.tgz'), bytes)
        return { stdout: JSON.stringify([{ filename: 'pkg.tgz', integrity, version: '1.2.3' }]) }
      }
      const into = join(dir, 'npm-link')
      await expect(
        fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, { cwd: dir, exec }),
      ).rejects.toThrow(/link or special entry/)
      expect(existsSync(into)).toBe(false)
    },
  )

  it('fetches exactly the pinned git commit, verifies HEAD, and removes repository metadata', async () => {
    const commit = '0123456789012345678901234567890123456789'
    const calls: string[][] = []
    const exec: ExecFn = async (_command, args) => {
      calls.push([...args])
      const at = args.indexOf('-C')
      const checkout = args.includes('checkout')
      if (checkout && at >= 0 && args[at + 1]) {
        writeFileSync(
          join(args[at + 1] as string, 'package.json'),
          JSON.stringify({ name: 'acme/git', version: '2.0.0', license: 'MIT', dependencies: {} }),
        )
      }
      return { stdout: args.includes('rev-parse') ? `${commit}\n` : '' }
    }
    const into = join(dir, 'git')
    const fetched = await fetchSource(parseSource(`git:https://example.com/x.git#${commit}`), into, {
      cwd: dir,
      exec,
    })
    expect(fetched).toMatchObject({ dir: into, version: '2.0.0', license: 'MIT' })
    expect(
      calls.some((args) => args.includes('fetch') && args.includes(commit) && args.includes('--depth')),
    ).toBe(true)
    expect(existsSync(join(into, '.git'))).toBe(false)
  })

  it('refuses a git checkout whose resolved HEAD differs from the pin', async () => {
    const commit = '0123456789012345678901234567890123456789'
    const exec: ExecFn = async (_command, args) => {
      const at = args.indexOf('-C')
      if (args.includes('checkout') && at >= 0 && args[at + 1]) {
        writeFileSync(
          join(args[at + 1] as string, 'package.json'),
          JSON.stringify({ name: 'acme/git', version: '2.0.0', dependencies: {} }),
        )
      }
      return {
        stdout: args.includes('rev-parse') ? '1111111111111111111111111111111111111111\n' : '',
      }
    }
    const into = join(dir, 'git-mismatch')
    await expect(
      fetchSource(parseSource(`git:https://example.com/x.git#${commit}`), into, { cwd: dir, exec }),
    ).rejects.toThrow(/E_PACKAGE_INTEGRITY/)
    expect(existsSync(into)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('.agnes-fetch-'))).toBe(false)
  })
})
