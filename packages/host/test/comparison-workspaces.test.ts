import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ComparisonWorkspaceOptions,
  createComparisonWorkspaces,
  verifyComparisonWorkspaceReferences,
} from '../src/runtime/comparison-workspaces.js'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup(overrides: Partial<ComparisonWorkspaceOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-comparison-workspaces-')))
  temporary.push(root)
  const cwd = join(root, 'source')
  const directory = join(root, 'snapshots')
  await mkdir(cwd)
  const authorized: string[] = []
  const options: ComparisonWorkspaceOptions = {
    directory,
    async authorizeRead(path) {
      authorized.push(path)
    },
    ...overrides,
  }
  return { root, cwd, directory, authorized, options, port: createComparisonWorkspaces(options) }
}

describe('comparison workspace snapshots', () => {
  it('freezes dirty and untracked bytes once and creates two ordinary independent file trees', async () => {
    const f = await setup()
    await mkdir(join(f.cwd, '.git'))
    await writeFile(join(f.cwd, '.git', 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(f.cwd, 'tracked.txt'), 'old content')
    await writeFile(join(f.cwd, 'tracked.txt'), 'dirty working bytes')
    await mkdir(join(f.cwd, 'nested'))
    await writeFile(join(f.cwd, 'nested', 'untracked.bin'), Buffer.from([0, 255, 23]))
    await writeFile(join(f.cwd, 'executable'), '#!/bin/sh\nexit 0\n')
    await chmod(join(f.cwd, 'executable'), 0o755)
    await mkdir(join(f.cwd, 'node_modules'))
    await writeFile(join(f.cwd, 'node_modules', 'dependency'), 'retained dependency')
    const snapshot = await f.port.prepare({ comparisonId: '../../opaque-id', cwd: f.cwd })
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.policyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.roots.left).not.toBe(snapshot.roots.right)
    for (const root of Object.values(snapshot.roots)) {
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('dirty working bytes')
      expect(await readFile(join(root, 'nested', 'untracked.bin'))).toEqual(Buffer.from([0, 255, 23]))
      expect(await readdir(root)).toEqual(['executable', 'nested', 'node_modules', 'tracked.txt'])
      expect((await lstat(join(root, 'executable'))).mode & 0o777).toBe(0o755)
    }
    const sourceStat = await lstat(join(f.cwd, 'tracked.txt'))
    const leftStat = await lstat(join(snapshot.roots.left, 'tracked.txt'))
    const rightStat = await lstat(join(snapshot.roots.right, 'tracked.txt'))
    expect(leftStat.ino).not.toBe(sourceStat.ino)
    expect(leftStat.ino).not.toBe(rightStat.ino)
    await writeFile(join(snapshot.roots.left, 'tracked.txt'), 'left changed')
    expect(await readFile(join(snapshot.roots.right, 'tracked.txt'), 'utf8')).toBe('dirty working bytes')
    expect(await readFile(join(f.cwd, 'tracked.txt'), 'utf8')).toBe('dirty working bytes')
    await writeFile(join(f.cwd, 'tracked.txt'), 'source later changed')
    expect(await readFile(join(snapshot.roots.right, 'tracked.txt'), 'utf8')).toBe('dirty working bytes')
    await f.port.release('../../opaque-id')
    await f.port.release('../../opaque-id')
    expect(await readdir(f.directory)).toEqual([])
    expect(await readFile(join(f.cwd, 'tracked.txt'), 'utf8')).toBe('source later changed')
  })

  it('has content-stable digests, policy-sensitive hashes and exclusive id reservation', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'file'), 'content')
    const first = await f.port.prepare({ comparisonId: 'one', cwd: f.cwd })
    const second = await f.port.prepare({ comparisonId: 'two', cwd: f.cwd })
    expect(second.digest).toBe(first.digest)
    expect(second.policyHash).toBe(first.policyHash)
    await expect(f.port.prepare({ comparisonId: 'one', cwd: f.cwd })).rejects.toMatchObject({
      code: 'SNAPSHOT_EXISTS',
    })
    expect(await readFile(join(first.roots.left, 'file'), 'utf8')).toBe('content')
    const changed = createComparisonWorkspaces({ ...f.options, maxFiles: 100 })
    expect((await changed.prepare({ comparisonId: 'three', cwd: f.cwd })).policyHash).not.toBe(
      first.policyHash,
    )
  })

  it('refuses external symlinks without explicit authorization and removes partial snapshots', async () => {
    const f = await setup()
    await writeFile(join(f.root, 'private'), 'private outside bytes')
    await symlink(join(f.root, 'private'), join(f.cwd, 'link'))
    await expect(f.port.prepare({ comparisonId: 'linked', cwd: f.cwd })).rejects.toMatchObject({
      code: 'EXTERNAL_REFERENCE_DENIED',
    })
    expect(f.authorized).not.toContain(join(f.root, 'private'))
    expect(await readdir(f.directory)).toEqual([])
    expect(await readFile(join(f.root, 'private'), 'utf8')).toBe('private outside bytes')
  })

  it('rebases internal absolute directory links and retains dependency chains independently in both lanes', async () => {
    const f = await setup()
    await mkdir(join(f.cwd, '.uv-cache', 'package'), { recursive: true })
    await writeFile(join(f.cwd, '.uv-cache', 'package', 'module.py'), 'original')
    await symlink(join(f.cwd, '.uv-cache', 'package'), join(f.cwd, '.uv-cache', 'alias'))
    await symlink('.uv-cache/alias', join(f.cwd, 'dependency'))
    const snapshot = await f.port.prepare({ comparisonId: 'internal', cwd: f.cwd })
    for (const root of Object.values(snapshot.roots)) {
      expect(await readlink(join(root, '.uv-cache', 'alias'))).toBe('package')
      expect(await realpath(join(root, 'dependency', 'module.py'))).toBe(
        join(root, '.uv-cache', 'package', 'module.py'),
      )
    }
    await writeFile(join(snapshot.roots.left, 'dependency', 'module.py'), 'left')
    expect(await readFile(join(snapshot.roots.right, 'dependency', 'module.py'), 'utf8')).toBe('original')
    expect(await readFile(join(f.cwd, 'dependency', 'module.py'), 'utf8')).toBe('original')
    expect(await verifyComparisonWorkspaceReferences(f.options, 'internal')).toEqual([])
  })

  it('pins authorized canonical external regular dependencies without copying interpreters and revalidates changes', async () => {
    const f = await setup({ authorizeExternalRead: async () => {} })
    const interpreter = join(f.root, 'interpreter')
    await writeFile(interpreter, 'external runtime bytes')
    await chmod(interpreter, 0o755)
    await mkdir(join(f.cwd, '.venv', 'bin'), { recursive: true })
    await symlink(interpreter, join(f.cwd, '.venv', 'bin', 'python3'))
    await symlink('python3', join(f.cwd, '.venv', 'bin', 'python'))
    const snapshot = await f.port.prepare({ comparisonId: 'python', cwd: f.cwd })
    for (const root of Object.values(snapshot.roots)) {
      expect(await readlink(join(root, '.venv', 'bin', 'python3'))).toBe(interpreter)
      expect(await readlink(join(root, '.venv', 'bin', 'python'))).toBe('python3')
      expect(await realpath(join(root, '.venv', 'bin', 'python'))).toBe(interpreter)
    }
    expect(await verifyComparisonWorkspaceReferences(f.options, 'python', snapshot)).toEqual([interpreter])
    await expect(
      verifyComparisonWorkspaceReferences(f.options, 'python', { ...snapshot, digest: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
    await expect(
      verifyComparisonWorkspaceReferences({ directory: f.directory }, 'python'),
    ).rejects.toMatchObject({ code: 'EXTERNAL_REFERENCE_DENIED' })
    await writeFile(interpreter, 'changed external bytes')
    await expect(verifyComparisonWorkspaceReferences(f.options, 'python')).rejects.toMatchObject({
      code: 'EXTERNAL_REFERENCE_CHANGED',
    })
    await f.port.release('python')
    expect(await readFile(interpreter, 'utf8')).toBe('changed external bytes')
  })

  it.each([
    'dangling',
    'cycle',
    'excluded',
    'external-directory',
    'storage-target',
    'external-limit',
    'retarget',
  ] as const)('rejects %s links without retaining a partial baseline', async (kind) => {
    const f = await setup({ authorizeExternalRead: async () => {} })
    const link = join(f.cwd, 'link')
    const target = kind === 'storage-target' ? join(f.directory, 'dependency') : join(f.root, 'dependency')
    if (kind === 'storage-target') await mkdir(f.directory)
    if (kind === 'dangling') await symlink('missing', link)
    else if (kind === 'cycle') await symlink('link', link)
    else if (kind === 'excluded') {
      await mkdir(join(f.cwd, '.git'))
      await writeFile(join(f.cwd, '.git', 'HEAD'), 'ref')
      await symlink('.git/HEAD', link)
    } else {
      if (kind === 'external-directory') await mkdir(target)
      else await writeFile(target, 'dependency')
      await symlink(target, link)
    }
    const port = createComparisonWorkspaces({
      ...f.options,
      ...(kind === 'external-limit' ? { maxBytes: 1 } : {}),
      authorizeExternalRead: async () => {
        if (kind === 'retarget') {
          await rm(link)
          await symlink('missing', link)
        }
      },
    })
    await expect(port.prepare({ comparisonId: kind, cwd: f.cwd })).rejects.toMatchObject({
      code:
        kind === 'dangling' || kind === 'cycle'
          ? 'SYMLINK_UNRESOLVED'
          : kind === 'excluded'
            ? 'SYMLINK_EXCLUDED_TARGET'
            : kind === 'external-limit'
              ? 'SNAPSHOT_LIMIT'
              : kind === 'retarget'
                ? 'SOURCE_CHANGED'
                : kind === 'storage-target'
                  ? 'EXTERNAL_REFERENCE_DENIED'
                  : 'EXTERNAL_REFERENCE_UNSUPPORTED',
    })
    expect(await readdir(f.directory)).toEqual(kind === 'storage-target' ? ['dependency'] : [])
  })

  it('counts unique external bytes once while bounding every symlink entry', async () => {
    const f = await setup({ authorizeExternalRead: async () => {}, maxBytes: 4, maxFiles: 2 })
    const target = join(f.root, 'dependency')
    await writeFile(target, '1234')
    await symlink(target, join(f.cwd, 'one'))
    await symlink(target, join(f.cwd, 'two'))
    await f.port.prepare({ comparisonId: 'dedup', cwd: f.cwd })
    expect(await verifyComparisonWorkspaceReferences(f.options, 'dedup')).toEqual([target])
    await symlink(target, join(f.cwd, 'three'))
    await expect(f.port.prepare({ comparisonId: 'exceeded', cwd: f.cwd })).rejects.toMatchObject({
      code: 'SNAPSHOT_LIMIT',
    })
    expect((await readdir(f.directory)).length).toBe(1)
  })

  it.each(['deleted', 'replacement', 'authorization', 'manifest'] as const)(
    'refuses %s changes on manifest revalidation',
    async (change) => {
      const f = await setup({ authorizeExternalRead: async () => {} })
      const target = join(f.root, 'dependency')
      await writeFile(target, 'same bytes')
      await symlink(target, join(f.cwd, 'link'))
      const snapshot = await f.port.prepare({ comparisonId: 'recheck', cwd: f.cwd })
      let options = f.options
      if (change === 'deleted') await rm(target)
      if (change === 'replacement') {
        await rename(target, join(f.root, 'old-dependency'))
        await writeFile(target, 'same bytes')
      }
      if (change === 'authorization')
        options = {
          ...f.options,
          authorizeExternalRead: async () => {
            throw new Error('private reason')
          },
        }
      if (change === 'manifest') await writeFile(join(dirname(snapshot.roots.left), 'manifest.json'), '{}')
      await expect(verifyComparisonWorkspaceReferences(options, 'recheck')).rejects.toMatchObject({
        code:
          change === 'manifest'
            ? 'MANIFEST_INVALID'
            : change === 'authorization'
              ? 'EXTERNAL_REFERENCE_DENIED'
              : 'EXTERNAL_REFERENCE_CHANGED',
      })
      // A failed recheck never removes existing execution workspaces or touches the dependency.
      expect((await lstat(snapshot.roots.left)).isDirectory()).toBe(true)
    },
  )

  it.each(['bytes', 'entries', 'files', 'authorization', 'concurrent-edit'] as const)(
    'fails closed for %s and cleans both copies',
    async (reason) => {
      const f = await setup()
      await writeFile(join(f.cwd, 'file'), 'content')
      await writeFile(join(f.cwd, 'second'), 'more content')
      let seen = 0
      const port = createComparisonWorkspaces({
        ...f.options,
        ...(reason === 'bytes' ? { maxBytes: 1 } : {}),
        ...(reason === 'entries' ? { maxEntries: 1 } : {}),
        ...(reason === 'files' ? { maxFiles: 1 } : {}),
        async authorizeRead(path) {
          if (reason === 'authorization' && path.endsWith('/file')) throw new Error('denied private path')
          if (reason === 'concurrent-edit' && path.endsWith('/file') && ++seen === 1)
            await writeFile(path, 'edited during read')
        },
      })
      await expect(port.prepare({ comparisonId: 'bad', cwd: f.cwd })).rejects.toThrow(
        'Comparison workspace preparation failed',
      )
      expect(await readdir(f.directory)).toEqual([])
    },
  )

  it('rejects overlapping storage before creating files in the source workspace', async () => {
    const f = await setup()
    const port = createComparisonWorkspaces({ ...f.options, directory: join(f.cwd, 'inside') })
    await expect(port.prepare({ comparisonId: 'overlap', cwd: f.cwd })).rejects.toMatchObject({
      code: 'WORKSPACE_OVERLAP',
    })
    expect(await readdir(f.cwd)).toEqual([])
  })

  it('releases read-only snapshot directories and never follows lane-created links during cleanup', async () => {
    const f = await setup()
    await mkdir(join(f.cwd, 'readonly'))
    await writeFile(join(f.cwd, 'readonly', 'file'), 'retained')
    await chmod(join(f.cwd, 'readonly'), 0o555)
    const snapshot = await f.port.prepare({ comparisonId: 'read-only', cwd: f.cwd })
    await symlink(f.cwd, join(snapshot.roots.left, 'outside-link'))
    await f.port.release('read-only')
    expect(await readdir(f.directory)).toEqual([])
    expect(await readFile(join(f.cwd, 'readonly', 'file'), 'utf8')).toBe('retained')
    await chmod(join(f.cwd, 'readonly'), 0o755)
  })

  it('refuses a replaced storage root when releasing an existing comparison', async () => {
    const f = await setup()
    await writeFile(join(f.cwd, 'file'), 'source')
    await f.port.prepare({ comparisonId: 'root-swap', cwd: f.cwd })
    const saved = join(f.root, 'saved-storage')
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'retained'), 'outside')
    await rename(f.directory, saved)
    await symlink(outside, f.directory)
    await expect(f.port.release('root-swap')).rejects.toMatchObject({ code: 'INVALID_STORAGE' })
    expect(await readFile(join(outside, 'retained'), 'utf8')).toBe('outside')
  })
})
