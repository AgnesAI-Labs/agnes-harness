import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ExecFn,
  fetchSource,
  forgetDirectoryDigests,
  hashDirectory,
  hashDirectoryAsync,
  packageDir,
  parseSource,
} from '../src/sources.js'
import { invalidatePackageVerification, withoutPackageVerification } from '../src/verification-operation.js'

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
    'git:https://example.com/x.git#bad?ref',
    'git:https://example.com/x.git?token=x#0123456789012345678901234567890123456789',
  ])('refuses an unpinned or unsafe network source: %s', (source) => {
    expect(() => parseSource(source)).toThrow()
  })

  it('accepts explicit local paths while keeping workspace references contained', () => {
    expect(parseSource('file:./vendor/x')).toEqual({ type: 'file', ref: 'file:./vendor/x' })
    expect(parseSource('workspace:extensions/sales')).toEqual({
      type: 'workspace',
      ref: 'workspace:extensions/sales',
    })
    for (const source of [
      'file:',
      'file:./bad\0path',
      'file:.\\x',
      'workspace:/extensions/x',
      'workspace:extensions/../x',
      'workspace:other/x',
    ])
      expect(() => parseSource(source), source).toThrow()
    for (const ref of ['file:/tmp/x', 'file:../x', 'file:.', 'file:./a/../x', 'file:./a//x'])
      expect(parseSource(ref)).toEqual({ type: 'file', ref })
    expect(parseSource('git:https://example.com/x.git#main')).toMatchObject({ type: 'git' })
    expect(parseSource('git:https://example.com/x.git')).toMatchObject({ type: 'git' })
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

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))

describe('hashDirectory', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-hash-'))
  })
  // Each test starts without reused digests, so sync/async comparisons compute both sides.
  afterEach(() => {
    forgetDirectoryDigests()
    rmSync(root, { recursive: true, force: true })
  })

  it('is deterministic, path-sensitive, and excludes only the configured trees', async () => {
    mkdirSync(join(root, '中文 空间', 'nested dir'), { recursive: true })
    writeFileSync(join(root, '中文 空间', 'nested dir', '文件 name.txt'), '字节一致')
    mkdirSync(join(root, 'z'))
    mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true })
    mkdirSync(join(root, 'fixtures', 'out'), { recursive: true })
    writeFileSync(join(root, 'z', 'b'), 'two')
    writeFileSync(join(root, 'a'), 'one')
    writeFileSync(join(root, 'large'), Buffer.alloc(256 * 1024 + 17, 0xa5))
    writeFileSync(join(root, 'small-after-large'), 'short tail')
    writeFileSync(join(root, 'empty'), '')
    for (let index = 0; index < 8; index++) {
      const directory = join(root, `分支 ${index}`, 'nested')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'bytes'), `branch ${index}`)
    }
    writeFileSync(join(root, 'node_modules', 'ignored', 'x'), 'ignored')
    writeFileSync(join(root, 'fixtures', 'out', 'x'), 'ignored')
    const first = hashDirectory(root)
    expect(first).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(hashDirectory(root)).toBe(first)
    expect(await hashDirectoryAsync(root)).toBe(first)
    expect(await hashDirectoryAsync(root, { exclude: [] })).toBe(hashDirectory(root, { exclude: [] }))
    writeFileSync(join(root, 'node_modules', 'ignored', 'x'), 'changed but excluded')
    expect(hashDirectory(root)).toBe(first)
    writeFileSync(join(root, 'z', 'b'), 'changed')
    expect(hashDirectory(root)).not.toBe(first)
    expect(await hashDirectoryAsync(root)).toBe(hashDirectory(root))
  })

  it('reuses a digest without reading file contents while sizes, mtimes and inodes hold', async () => {
    const file = join(root, 'payload')
    writeFileSync(file, 'first')
    writeFileSync(join(root, 'other'), 'other')
    // Whole seconds, so restoring the time below is exact on every filesystem; and old, because a
    // tree with a file written in the last two seconds is never stored.
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    utimesSync(join(root, 'other'), 1_700_000_000, 1_700_000_000)
    const first = hashDirectory(root)
    // The documented blind spot: a same-size rewrite that restores mtime is not read again.
    writeFileSync(file, 'xxxxx')
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    expect(hashDirectory(root)).toBe(first)
    const open = vi.spyOn(asyncFs, 'open')
    try {
      expect(await hashDirectoryAsync(root)).toBe(first)
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
    forgetDirectoryDigests()
    expect(hashDirectory(root)).not.toBe(first)
  })

  it('hashes again when a size or mtime changes, or a verification refusal clears what it knows', async () => {
    const file = join(root, 'payload'),
      old = 1_700_000_000
    writeFileSync(file, 'first')
    utimesSync(file, old, old)
    const first = hashDirectory(root)
    writeFileSync(file, 'longer than before')
    utimesSync(file, old, old)
    const grown = hashDirectory(root)
    expect(grown).not.toBe(first)
    expect(await hashDirectoryAsync(root)).toBe(grown)
    writeFileSync(file, 'longer than BEFORE')
    utimesSync(file, old, old + 5)
    const touched = hashDirectory(root)
    expect(touched).not.toBe(grown)
    writeFileSync(file, 'longer than before')
    utimesSync(file, old, old + 5)
    expect(hashDirectory(root)).toBe(touched)
    invalidatePackageVerification()
    expect(hashDirectory(root)).toBe(grown)
  })

  it('keeps digests across a routine write boundary', () => {
    // Every Host publication enters and leaves one; clearing here made each worker start hash again.
    const file = join(root, 'payload'),
      old = 1_700_000_000
    writeFileSync(file, 'first')
    utimesSync(file, old, old)
    const first = hashDirectory(root)
    writeFileSync(file, 'xxxxx')
    utimesSync(file, old, old)
    withoutPackageVerification(() => undefined)
    expect(hashDirectory(root)).toBe(first)
  })

  it('does not keep a digest for a tree with a file written moments before hashing', async () => {
    // File times advance in ticks; a same-size rewrite in the same tick must not reuse the digest.
    const file = join(root, 'payload'),
      now = Math.floor(Date.now() / 1000)
    writeFileSync(file, 'first')
    utimesSync(file, now, now)
    const first = hashDirectory(root)
    writeFileSync(file, 'xxxxx')
    utimesSync(file, now, now)
    const second = hashDirectory(root)
    expect(second).not.toBe(first)
    writeFileSync(file, 'yyyyy')
    utimesSync(file, now, now)
    expect(await hashDirectoryAsync(root)).not.toBe(second)
  })

  it('still refuses a symbolic link that appears after a digest was reused', async () => {
    writeFileSync(join(root, 'payload'), 'first')
    hashDirectory(root)
    await hashDirectoryAsync(root)
    const outside = mkdtempSync(join(tmpdir(), 'agnes-hash-outside-'))
    try {
      symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => hashDirectory(root)).toThrow(/symbolic link/)
      await expect(hashDirectoryAsync(root)).rejects.toThrow(/symbolic link/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.each(['failure', 'cancellation'] as const)(
    'bounds directory reads and drains started siblings before returning a %s',
    async (mode) => {
      const canonicalRoot = realpathSync(root)
      for (let index = 0; index < 8; index++) {
        const directory = join(root, `branch-${index}`)
        mkdirSync(directory)
        writeFileSync(join(directory, 'bytes'), `branch ${index}`)
      }
      const gate = () => {
        let resolve = () => {}
        let reject = (_error: Error) => {}
        const promise = new Promise<void>((yes, no) => {
          resolve = yes
          reject = no
        })
        return { promise, resolve, reject }
      }
      const first = gate(),
        others = gate(),
        entered = gate(),
        finishedFirst = gate()
      const abort = new AbortController()
      let active = 0,
        peak = 0,
        settled = false
      const readdir = asyncFs.readdir
      const spy = vi.spyOn(asyncFs, 'readdir').mockImplementation((async (
        ...args: Parameters<typeof readdir>
      ) => {
        const path = String(args[0])
        if (dirname(path) !== canonicalRoot) return readdir(...args)
        const isFirst = path === join(canonicalRoot, 'branch-0')
        peak = Math.max(peak, ++active)
        if (isFirst) entered.resolve()
        try {
          await (isFirst ? first.promise : others.promise)
          return await readdir(...args)
        } finally {
          active--
          if (isFirst) finishedFirst.resolve()
        }
      }) as typeof readdir)
      const pending = hashDirectoryAsync(root, { signal: abort.signal })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true
        })
      try {
        await entered.promise
        expect(active).toBeGreaterThan(1)
        expect(peak).toBeLessThanOrEqual(4)
        if (mode === 'failure') first.reject(new Error('directory read refused'))
        else {
          abort.abort()
          first.resolve()
        }
        await finishedFirst.promise
        await Promise.resolve()
        expect(settled).toBe(false)
      } finally {
        first.resolve()
        others.resolve()
        await pending
        spy.mockRestore()
      }
      expect(await pending).toBeInstanceOf(Error)
      expect(await pending).toMatchObject(
        mode === 'failure' ? { message: 'directory read refused' } : { code: 'E_PACKAGE_CANCELLED' },
      )
      expect(active).toBe(0)
      expect(peak).toBeLessThanOrEqual(4)
      expect(await hashDirectoryAsync(root)).toBe(hashDirectory(root))
    },
  )

  it('refuses symlinks and special entries instead of hashing outside the tree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'agnes-hash-outside-'))
    const rootAlias = `${root}-alias`
    writeFileSync(join(outside, 'secret'), 'secret')
    try {
      symlinkSync(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => hashDirectory(rootAlias)).toThrow(/symbolic link/)
      await expect(hashDirectoryAsync(rootAlias)).rejects.toThrow(/symbolic link/)
      symlinkSync(
        process.platform === 'win32' ? outside : join(outside, 'secret'),
        join(root, 'escape'),
        process.platform === 'win32' ? 'junction' : 'file',
      )
      expect(() => hashDirectory(root)).toThrow(/symbolic link/)
      await expect(hashDirectoryAsync(root)).rejects.toThrow(/symbolic link/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      unlinkSync(rootAlias)
    }
  })
  it.each(['during-read', 'after-close'] as const)(
    'rejects a same-size restored-mtime edit %s during the walk',
    async (timing) => {
      const file = join(root, 'a-payload'),
        tail = join(root, 'z-tail')
      writeFileSync(file, 'first')
      writeFileSync(tail, 'tail')
      const before = statSync(file)
      const canonicalFile = realpathSync(file),
        canonicalTail = realpathSync(tail)
      const change = () => {
        writeFileSync(file, 'other')
        utimesSync(file, before.atime, before.mtime)
      }
      const open = asyncFs.open
      const spy = vi.spyOn(asyncFs, 'open').mockImplementation(async (...args) => {
        if (timing === 'after-close' && args[0] === canonicalTail) change()
        const handle = await open(...args)
        if (timing === 'during-read' && args[0] === canonicalFile) {
          const stat = handle.stat.bind(handle)
          vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
            const observed = await stat()
            change()
            return observed
          })
        }
        return handle
      })
      try {
        await expect(hashDirectoryAsync(root)).rejects.toMatchObject({ detail: { reason: 'tree-changed' } })
      } finally {
        spy.mockRestore()
      }
    },
  )
  it('hashes a snapshot whose file a runtime generation hard-links mid-walk', async () => {
    // A Host worker links snapshot files into a new generation while the daemon verifies them.
    const generation = mkdtempSync(join(tmpdir(), 'agnes-hash-generation-'))
    const file = join(root, 'a-payload')
    writeFileSync(file, 'first')
    writeFileSync(join(root, 'z-tail'), 'tail')
    const expected = hashDirectory(root)
    // Walk the tree for real: a reused digest would never open the file this test links.
    forgetDirectoryDigests()
    const canonicalFile = realpathSync(file)
    const open = asyncFs.open
    let linked = false
    const spy = vi.spyOn(asyncFs, 'open').mockImplementation(async (...args) => {
      if (!linked && args[0] === canonicalFile) {
        linked = true
        linkSync(file, join(generation, 'a-payload'))
      }
      return open(...args)
    })
    try {
      expect(await hashDirectoryAsync(root)).toBe(expected)
      expect(linked).toBe(true)
    } finally {
      spy.mockRestore()
      rmSync(generation, { recursive: true, force: true })
    }
  })

  it.each([
    '../../../examples/acme',
    '../../../examples/demos/business-agent',
    '../../../examples/demos/hot-upgrade',
    '../../../examples/demos/growing-skills',
  ])('matches the synchronous digest for bundled example %s', async (path) => {
    const directory = fileURLToPath(new URL(path, import.meta.url))
    expect(await hashDirectoryAsync(directory)).toBe(hashDirectory(directory))
    expect(await hashDirectoryAsync(directory, { exclude: [] })).toBe(
      hashDirectory(directory, { exclude: [] }),
    )
  })
  it('yields while hashing file contents and honours cancellation', async () => {
    writeFileSync(join(root, 'payload'), Buffer.alloc(1024 * 1024, 23))
    let progressed = false
    const immediate = new Promise<void>((resolve) =>
      setImmediate(() => {
        progressed = true
        resolve()
      }),
    )
    const digest = await hashDirectoryAsync(root)
    expect(progressed).toBe(true)
    await immediate
    expect(digest).toBe(hashDirectory(root))
    const abort = new AbortController()
    abort.abort()
    await expect(hashDirectoryAsync(root, { signal: abort.signal })).rejects.toMatchObject({
      code: 'E_PACKAGE_CANCELLED',
    })
    for (let index = 0; index < 3; index++)
      writeFileSync(join(root, `parallel-${index}`), Buffer.alloc(256 * 1024, index))
    const duringRead = new AbortController()
    const handles = new Set<object>()
    const open = asyncFs.open
    const spy = vi.spyOn(asyncFs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      handles.add(handle)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        const result = await read(...args)
        duringRead.abort()
        return result
      })
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        try {
          await close()
        } finally {
          handles.delete(handle)
        }
      })
      return handle
    })
    try {
      await expect(hashDirectoryAsync(root, { signal: duringRead.signal })).rejects.toMatchObject({
        code: 'E_PACKAGE_CANCELLED',
      })
      expect(handles.size).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('fetchSource', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-source-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.each(['installed', '安装 目录'])(
    'copies a file source atomically into %s and returns checked metadata',
    async (name) => {
      const into = join(dir, name)
      const fetched = await fetchSource(parseSource('file:./pkg-a'), into, { cwd: fixtures })
      expect(fetched).toMatchObject({
        dir: into,
        version: '1.0.0',
        license: 'MIT',
        dependencies: { '@agnes/extension-api': '2.0.0' },
      })
      expect(fetched.integrity).toBe(hashDirectory(into))
      expect(readFileSync(join(into, 'package.json'), 'utf8')).toContain('acme/pkg-a')
      const outside = join(dir, 'absolute')
      await fetchSource(parseSource('file:' + join(fixtures, 'pkg-a').split(sep).join('/')), outside, {
        cwd: dir,
      })
      expect(hashDirectory(outside)).toBe(fetched.integrity)
    },
  )

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
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'secret')
    symlinkSync(
      process.platform === 'win32' ? outside : join(outside, 'secret'),
      join(source, 'escape'),
      process.platform === 'win32' ? 'junction' : 'file',
    )
    await expect(fetchSource(parseSource('file:./pkg'), join(dir, 'bad'), { cwd })).rejects.toThrow(
      /symbolic link/,
    )
    expect(existsSync(join(dir, 'bad'))).toBe(false)

    const into = join(dir, 'existing')
    mkdirSync(into)
    writeFileSync(join(into, 'sentinel'), 'keep')
    await expect(fetchSource(parseSource('file:./pkg'), into, { cwd })).rejects.toThrow(/destination exists/)
    expect(readFileSync(join(into, 'sentinel'), 'utf8')).toBe('keep')
    unlinkSync(join(source, 'escape'))
    const during = join(dir, 'created-during-hash')
    const pending = fetchSource(parseSource('file:./pkg'), during, { cwd })
    mkdirSync(during)
    await expect(pending).rejects.toThrow(/destination exists/)
    expect(readdirSync(during)).toEqual([])
    expect(readdirSync(dir).some((name) => name.startsWith('.agnes-fetch-'))).toBe(false)
  })

  it('treats a dangling destination symlink as occupied', async () => {
    const into = join(dir, 'dangling')
    symlinkSync(join(dir, 'missing'), into, process.platform === 'win32' ? 'junction' : 'file')
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
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, {
        cwd: dir,
        exec,
        extract,
        npmProvenance: async () => ({
          publisher: 'npm:fixture',
          signatureVerified: false,
          verification: 'unverified',
        }),
      }),
    ).resolves.toMatchObject({
      provenance: { publisher: 'npm:fixture', signatureVerified: false },
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

    const rejectedTarget = join(dir, 'npm-invalid-provenance')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), rejectedTarget, {
        cwd: dir,
        exec,
        extract,
        npmProvenance: async () => {
          throw Object.assign(new Error('invalid provenance'), { code: 'E_PACKAGE_PROVENANCE' })
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_PROVENANCE' })
    expect(existsSync(rejectedTarget)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('.agnes-fetch-'))).toBe(false)

    releasedAt = '2026-02-31T00:00:00Z'
    const invalidTimeTarget = join(dir, 'npm-invalid-time')
    await expect(
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), invalidTimeTarget, {
        cwd: dir,
        exec,
        extract,
        npmProvenance: async () => undefined,
      }),
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
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, {
        cwd: dir,
        exec,
        extract,
        npmProvenance: async () => undefined,
      }),
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
      fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, {
        cwd: dir,
        exec,
        npmProvenance: async () => undefined,
      }),
    ).resolves.toMatchObject({ dir: into, integrity, version: '1.2.3' })
    expect(readFileSync(join(into, 'package.json'), 'utf8')).toContain('@agnes/base')
    const localArchive = join(dir, 'local-tarball')
    await fetchSource(parseSource('file:' + tarball.split(sep).join('/')), localArchive, { cwd: fixtures })
    expect(readFileSync(join(localArchive, 'package.json'), 'utf8')).toContain('@agnes/base')
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
        fetchSource(parseSource('npm:@agnes/base@1.2.3'), into, {
          cwd: dir,
          exec,
          npmProvenance: async () => undefined,
        }),
      ).rejects.toThrow(/link or special entry/)
      expect(existsSync(into)).toBe(false)
    },
  )

  it.each(['valid', 'manifest-missing', 'manifest-invalid', 'git-fetch'] as const)(
    'fetches a pinned Git source or classifies its refusal (%s)',
    async (outcome) => {
      const commit = '0123456789012345678901234567890123456789'
      const calls: string[][] = []
      const exec: ExecFn = async (_command, args) => {
        calls.push([...args])
        if (outcome === 'git-fetch' && args.includes('fetch')) throw new Error('private Git stderr')
        const at = args.indexOf('-C')
        const checkout = args.includes('checkout')
        if (checkout && at >= 0 && args[at + 1] && outcome !== 'manifest-missing') {
          writeFileSync(
            join(args[at + 1] as string, 'package.json'),
            outcome === 'manifest-invalid'
              ? '{'
              : JSON.stringify({ name: 'acme/git', version: '2.0.0', license: 'MIT', dependencies: {} }),
          )
        }
        return { stdout: args.includes('rev-parse') ? `${commit}\n` : '' }
      }
      const into = join(dir, 'git')
      const fetching = fetchSource(parseSource(`git:https://example.com/x.git#${commit}`), into, {
        cwd: dir,
        exec,
        npmProvenance: async () => undefined,
      })
      if (outcome !== 'valid') {
        await expect(fetching).rejects.toMatchObject({
          code: 'E_PACKAGE_SOURCE',
          detail: {
            reason:
              outcome === 'manifest-missing'
                ? 'package-json-missing'
                : outcome === 'manifest-invalid'
                  ? 'package-json'
                  : 'git-fetch',
          },
        })
        expect(existsSync(into)).toBe(false)
        return
      }
      const fetched = await fetching
      expect(fetched).toMatchObject({ dir: into, version: '2.0.0', license: 'MIT' })
      expect(
        calls.some((args) => args.includes('fetch') && args.includes(commit) && args.includes('--depth')),
      ).toBe(true)
      expect(existsSync(join(into, '.git'))).toBe(false)
    },
  )

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
      fetchSource(parseSource(`git:https://example.com/x.git#${commit}`), into, {
        cwd: dir,
        exec,
        npmProvenance: async () => undefined,
      }),
    ).rejects.toThrow(/E_PACKAGE_INTEGRITY/)
    expect(existsSync(into)).toBe(false)
    expect(readdirSync(dir).some((name) => name.startsWith('.agnes-fetch-'))).toBe(false)
  })
})
