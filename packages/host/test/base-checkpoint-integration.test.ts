import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SeamInitContext } from '@agnes/base'
import { seams } from '@agnes/base'
import { afterEach, describe, expect, it } from 'vitest'
import { type AdapterBundle, openAdapters, toSeamAdapters } from '../src/adapters/index.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { LockState, ResolvedProfile, ResolveEnv } from '../src/profile/types.js'

const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}
const log = { debug() {}, info() {}, warn() {}, error() {} }
const roots: string[] = []

async function openCheckpoint(profile: ResolvedProfile, dataDir: string, workspaceRoot: string) {
  const bundle = await openAdapters(profile, { dataDir, workspaceRoot })
  const context: SeamInitContext = {
    secrets: (ref) => bundle.secrets.resolve(ref),
    adapters: toSeamAdapters(bundle, { owner: '@agnes/base' }),
    profile: {
      name: profile.name,
      resolvedProfileHash: profile.hash,
      dataDir,
      workspaceRoot,
      homeDir: dirname(dataDir),
      limits: profile.limits,
      preset: {},
    },
    log,
    signal: new AbortController().signal,
  }
  try {
    return { bundle, checkpoint: await seams.checkpoint(context) }
  } catch (error) {
    await bundle.close()
    throw error
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('@agnes/base checkpoint against real host adapters', () => {
  it('reopens the dataFs shadow repository and lists and rewinds an earlier checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-checkpoint-host-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dataDir = join(root, 'data')
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'state.txt'), 'before')
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)

    let first: AdapterBundle | undefined
    let reopened: AdapterBundle | undefined
    try {
      const opened = await openCheckpoint(profile, dataDir, workspaceRoot)
      first = opened.bundle
      const saved = await opened.checkpoint.snapshot(['state.txt'], 'turn-1/step-1')
      expect(await opened.checkpoint.list()).toEqual([{ id: saved.id, stepId: 'turn-1/step-1' }])
      await first.close()
      first = undefined

      await writeFile(join(workspaceRoot, 'state.txt'), 'after')
      const next = await openCheckpoint(profile, dataDir, workspaceRoot)
      reopened = next.bundle
      expect(await next.checkpoint.list()).toEqual([{ id: saved.id, stepId: 'turn-1/step-1' }])
      await next.checkpoint.rewind(saved.id)
      expect(await readFile(join(workspaceRoot, 'state.txt'), 'utf8')).toBe('before')
    } finally {
      await first?.close()
      await reopened?.close()
    }
  })

  it('restores a file through an in-root directory alias with real host adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-checkpoint-directory-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const real = join(workspaceRoot, 'real')
    const alias = join(workspaceRoot, 'alias')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'inside.txt'), 'inside-before')
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir' // guards-allow-platform: real Windows directory alias without file-link privilege.
    await symlink(real, alias, directoryLink)
    expect(await realpath(alias)).toBe(await realpath(real))
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const opened = await openCheckpoint(profile, join(root, 'data'), workspaceRoot)
    try {
      const saved = await opened.checkpoint.snapshot(
        ['alias/inside.txt', 'real/inside.txt'],
        'directory-alias',
      )
      await writeFile(join(real, 'inside.txt'), 'inside-after')
      await opened.checkpoint.rewind(saved.id)
      expect(await readFile(join(real, 'inside.txt'), 'utf8')).toBe('inside-before')
    } finally {
      await opened.bundle.close()
    }
  })

  it('enforces file symlink boundaries and preflights retargets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-checkpoint-host-links-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const dataDir = join(root, 'data')
    const outside = join(root, 'outside.txt')
    await mkdir(workspaceRoot)
    await writeFile(outside, 'outside')
    await symlink(outside, join(workspaceRoot, 'outside-link'))
    await writeFile(join(workspaceRoot, 'stable.txt'), 'stable-before')
    await writeFile(join(workspaceRoot, 'retarget.txt'), 'retarget-before')
    await writeFile(join(workspaceRoot, 'alternate.txt'), 'alternate')
    const profile = await resolveProfile({ builtin: 'local-dev', lock }, env)
    const opened = await openCheckpoint(profile, dataDir, workspaceRoot)

    try {
      const beforeOutside = await opened.checkpoint.list()
      await expect(opened.checkpoint.snapshot(['outside-link'], 'outside')).rejects.toThrow(/E_FS_DENIED/)
      expect(await opened.checkpoint.list()).toEqual(beforeOutside)

      const retarget = await opened.checkpoint.snapshot(['stable.txt', 'retarget.txt'], 'retarget-preflight')
      await writeFile(join(workspaceRoot, 'stable.txt'), 'stable-after')
      await unlink(join(workspaceRoot, 'retarget.txt'))
      await symlink('alternate.txt', join(workspaceRoot, 'retarget.txt'))
      await expect(opened.checkpoint.rewind(retarget.id)).rejects.toMatchObject({
        code: 'E_CHECKPOINT_PATH_CHANGED',
      })
      expect(await readFile(join(workspaceRoot, 'stable.txt'), 'utf8')).toBe('stable-after')
      expect(await readFile(join(workspaceRoot, 'alternate.txt'), 'utf8')).toBe('alternate')
    } finally {
      await opened.bundle.close()
    }
  })
})
