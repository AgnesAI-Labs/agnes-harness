import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { readWorkspace } from '@agnes/worker-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  compileIgnore,
  ignoredBy,
  MAX_READ_BYTES,
  normalizeWorkspacePath,
  parseGitPorcelain,
} from '../src/local/workspace-files.js'
import { openTestHost } from './host.js'

const caps = {
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
}
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: caps,
    _meta: { 'ai.agnes.harness': { clientId: 'workspace-files-test' } },
  },
}

describe('workspace ignore rules and git status records', () => {
  const files = [compileIgnore('', '*.log\nbuild/\n# comment\n\n!keep.log\ndocs/*.md\n')]

  it('hides ignored names, keeps the ignore files themselves, and lets the last rule win', () => {
    expect(ignoredBy('notes.log', false, files)).toBe(true)
    expect(ignoredBy('dir/notes.log', false, files)).toBe(true)
    expect(ignoredBy('keep.log', false, files)).toBe(false)
    expect(ignoredBy('build', true, files)).toBe(true)
    expect(ignoredBy('src/build', true, files)).toBe(true)
    expect(ignoredBy('docs/a.md', false, files)).toBe(true)
    expect(ignoredBy('notes.md', false, files)).toBe(false)
    expect(ignoredBy('.gitignore', false, files)).toBe(false)
    expect(ignoredBy('src/.aghignore', false, files)).toBe(false)
    expect(ignoredBy('.git', false, files)).toBe(true)
    expect(ignoredBy('.git/config', false, files)).toBe(true)
  })

  it('parses porcelain records, including a rename', () => {
    const bytes = Buffer.from('?? new\nname.txt\0A  added.txt\0R  renamed\nname.txt\0old.txt\0', 'utf8')
    expect(Object.fromEntries(parseGitPorcelain(bytes))).toEqual({
      'new\nname.txt': 'untracked',
      'added.txt': 'added',
      'renamed\nname.txt': 'renamed',
    })
  })

  it('refuses parent segments and absolute paths before touching the filesystem', () => {
    expect(() => normalizeWorkspacePath('../secret')).toThrowError(
      expect.objectContaining({ data: expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }) }),
    )
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrowError(
      expect.objectContaining({ data: expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }) }),
    )
    expect(() => normalizeWorkspacePath('foo/../../etc')).toThrowError(
      expect.objectContaining({ data: expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }) }),
    )
    expect(normalizeWorkspacePath('./src/./a.ts')).toBe('src/a.ts')
  })
})

describe('session workspace files', () => {
  it('lists and reads only inside the session workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agh-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'agh-out-'))
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const draining = (async () => {
      for await (const _ of ep.notifications) {
        /* drain */
      }
    })()
    try {
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET_SENTINEL')
      writeFileSync(join(workspace, 'report.md'), 'hello workspace')
      writeFileSync(join(workspace, 'notes.log'), 'hidden log')
      writeFileSync(join(workspace, '.gitignore'), '*.log\n')
      mkdirSync(join(workspace, 'src'))
      writeFileSync(join(workspace, 'src', 'main.ts'), 'export const value = 1\n')
      writeFileSync(join(workspace, 'picture.bin'), Buffer.from([0, 1, 2, 3]))
      writeFileSync(join(workspace, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))
      symlinkSync(join(outside, 'secret.txt'), join(workspace, 'escape'))
      symlinkSync(outside, join(workspace, 'escape-dir'))
      const home = join(workspace, AGH_DIR)
      mkdirSync(join(home, 'secrets'), { recursive: true })
      mkdirSync(join(home, 'memory'))
      writeFileSync(join(home, 'secrets', 'key'), 'PRIVATE_KEY_SENTINEL')
      writeFileSync(join(home, 'memory', 'note'), 'PRIVATE_MEMORY_SENTINEL')
      vi.stubEnv('AGH_HOME', home)
      const git = (args: string[]) =>
        spawnSync('git', args, {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
        })
      expect(git(['init']).status).toBe(0)
      writeFileSync(join(workspace, 'old\nname.txt'), 'synthetic tracked file\n')
      writeFileSync(join(workspace, 'new\nname.txt'), 'synthetic untracked file\n')
      expect(git(['add', '--', 'old\nname.txt']).status).toBe(0)
      expect(
        git([
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          `core.hooksPath=${join(workspace, 'no-hooks')}`,
          'commit',
          '--no-gpg-sign',
          '-m',
          'Fixture',
        ]).status,
      ).toBe(0)
      expect(git(['mv', '--', 'old\nname.txt', 'renamed\nname.txt']).status).toBe(0)
      expect(git(['add', '--', 'report.md']).status).toBe(0)
      appendFileSync(join(workspace, '.git', 'config'), '\n# PRIVATE_GIT_CONFIG_SENTINEL\n')
      await h.addWorkspace(workspace)
      expect(await ep.handle(init)).toMatchObject({ result: { protocolVersion: 1 } })
      const created = (await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: workspace, mcpServers: [] },
      })) as { result?: { sessionId: string }; error?: unknown }
      expect(created.error).toBeUndefined()
      const sessionId = created.result?.sessionId
      if (!sessionId) throw new Error('session was not created')
      const call = (id: number, method: string, params: unknown) =>
        ep.handle({ jsonrpc: '2.0', id, method, params })

      const listed = (await call(3, '_agnes/v1/session.workspace.list', { sessionId })) as {
        result: { path: string; entries: { name: string; kind: string; git?: string }[]; truncated: boolean }
      }
      const names = listed.result.entries.map((entry) => entry.name)
      expect(listed.result.path).toBe('')
      expect(names).toContain('report.md')
      expect(names).toContain('src')
      expect(names).toContain('.gitignore')
      expect(names).not.toContain('notes.log')
      expect(names).not.toContain('secret.txt')
      expect(names).not.toContain(AGH_DIR)
      // Metadata badges are a controlled Host operation; document reads still deny Git internals.
      expect(listed.result).toMatchObject({
        gitStatus: 'available',
        revision: expect.any(String),
        observedAt: expect.any(String),
      })
      expect(listed.result.entries.find((entry) => entry.name === 'report.md')?.git).toBe('added')
      expect(listed.result.entries.find((entry) => entry.name === 'renamed\nname.txt')?.git).toBe('renamed')
      expect(listed.result.entries.find((entry) => entry.name === 'new\nname.txt')?.git).toBe('untracked')
      expect(names).not.toContain('.git')
      expect(JSON.stringify(listed)).not.toContain('PRIVATE_GIT_CONFIG_SENTINEL')
      expect(JSON.stringify(listed)).not.toContain('PRIVATE_KEY_SENTINEL')
      expect(JSON.stringify(listed)).not.toContain('PRIVATE_MEMORY_SENTINEL')
      expect(listed.result.entries.find((entry) => entry.name === 'escape')?.kind).toBe('other')
      expect(listed.result.entries.find((entry) => entry.name === 'escape-dir')?.kind).toBe('other')
      expect(JSON.stringify(listed)).not.toContain('OUTSIDE_SECRET_SENTINEL')

      const nested = (await call(4, '_agnes/v1/session.workspace.list', { sessionId, path: 'src' })) as {
        result: { path: string; entries: { name: string }[] }
      }
      expect(nested.result).toMatchObject({
        path: 'src',
        entries: [{ name: 'main.ts', kind: 'file', git: 'untracked' }],
      })

      const read = (await call(5, '_agnes/v1/session.workspace.read', {
        sessionId,
        path: 'src/main.ts',
      })) as {
        result: { text?: string; binary: boolean; truncated: boolean }
      }
      expect(read.result).toMatchObject({ binary: false, truncated: false, text: 'export const value = 1\n' })

      const binary = (await call(6, '_agnes/v1/session.workspace.read', {
        sessionId,
        path: 'picture.bin',
      })) as {
        result: { binary: boolean; text?: string }
      }
      expect(binary.result.binary).toBe(true)
      expect(binary.result.text).toBeUndefined()

      const large = (await call(7, '_agnes/v1/session.workspace.read', { sessionId, path: 'big.txt' })) as {
        result: { truncated: boolean; size: number; text?: string }
      }
      expect(large.result.truncated).toBe(true)
      expect(large.result.size).toBe(MAX_READ_BYTES + 1)
      expect(large.result.text).toBeUndefined()

      const hidden = (await call(8, '_agnes/v1/session.workspace.read', {
        sessionId,
        path: 'notes.log',
      })) as {
        result: { text?: string }
      }
      expect(hidden.result.text).toBe('hidden log')

      expect(await call(40, '_agnes/v1/session.workspace.changes', { sessionId })).toMatchObject({
        result: { files: [] },
      })
      for (const path of [
        '../secret',
        'escape',
        'escape-dir/secret.txt',
        '.git/config',
        `${AGH_DIR}/secrets/key`,
        `${AGH_DIR}/memory/note`,
      ]) {
        expect(await call(41, '_agnes/v1/session.workspace.changes', { sessionId, path })).toMatchObject({
          error: { data: { code: 'WORKSPACE_PATH_DENIED' } },
        })
      }
      for (const path of [
        '../secret',
        '/etc/passwd',
        'foo/../../etc',
        'escape',
        'escape-dir',
        '.git/config',
        `${AGH_DIR}/secrets/key`,
        `${AGH_DIR}/memory/note`,
      ]) {
        const denied = await call(9, '_agnes/v1/session.workspace.read', { sessionId, path })
        expect(denied, path).toMatchObject({
          error: {
            code: -32011,
            data: { code: 'WORKSPACE_PATH_DENIED', messageKey: 'appServer.errors.forbidden' },
          },
        })
        expect(JSON.stringify(denied)).not.toContain('OUTSIDE_SECRET_SENTINEL')
      }
      expect(await call(50, '_agnes/v1/session.workspace.list', { sessionId, path: '.git' })).toMatchObject({
        error: { data: { code: 'WORKSPACE_PATH_DENIED' } },
      })
      renameSync(join(workspace, '.git'), join(outside, 'repo-git'))
      symlinkSync(join(outside, 'repo-git'), join(workspace, '.git'))
      expect(await call(51, '_agnes/v1/session.workspace.list', { sessionId })).toMatchObject({
        result: { gitStatus: 'unavailable' },
      })
      rmSync(join(workspace, '.git'))
      mkdirSync(join(workspace, '.git'))
      expect(await call(52, '_agnes/v1/session.workspace.list', { sessionId })).toMatchObject({
        result: { gitStatus: 'unavailable' },
      })
      const escapedList = await call(10, '_agnes/v1/session.workspace.list', { sessionId, path: '../' })
      expect(escapedList).toMatchObject({
        error: { data: { code: 'WORKSPACE_PATH_DENIED', messageKey: 'appServer.errors.forbidden' } },
      })
      expect(
        await call(11, '_agnes/v1/session.workspace.read', { sessionId: 'missing', path: 'report.md' }),
      ).toMatchObject({
        error: { code: -32003 },
      })
    } finally {
      vi.unstubAllEnvs()
      ep.close()
      await draining
      await h.close()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

it('refuses an intermediate path swapped to a symlink after authority validation', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'agh-race-'))
  const outside = mkdtempSync(join(tmpdir(), 'agh-out-race-'))
  try {
    mkdirSync(join(workspace, 'dir'))
    writeFileSync(join(workspace, 'dir', 'file'), 'inside')
    writeFileSync(join(outside, 'file'), 'OUTSIDE_RACE_SENTINEL')
    let swapped = false
    const authority = {
      stat: async () => {
        if (!swapped) {
          swapped = true
          renameSync(join(workspace, 'dir'), join(workspace, 'old'))
          symlinkSync(outside, join(workspace, 'dir'))
        }
      },
    }
    await expect(readWorkspace(realpathSync(workspace), 'dir/file', authority)).rejects.toMatchObject({
      data: { code: 'WORKSPACE_PATH_DENIED' },
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
