import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareSandboxWorkspaceAncestor } from '../src/sandbox-workspace-ancestor.js'

it.skipIf(process.platform === 'win32')(
  'prepares only .agh with ordinary permissions and preserves an existing directory',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-ancestor-')))
    try {
      await prepareSandboxWorkspaceAncestor(root)
      expect((await lstat(join(root, '.agh'))).mode & 0o777).toBe(0o777 & ~process.umask())
      await writeFile(join(root, '.agh', 'notes'), 'keep')
      await prepareSandboxWorkspaceAncestor(root)
      expect(await readFile(join(root, '.agh', 'notes'), 'utf8')).toBe('keep')
      for (const path of ['.agnes', '.git', '.agh/secrets'])
        await expect(lstat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(prepareSandboxWorkspaceAncestor(join(root, 'missing-workspace'))).rejects.toMatchObject({
        code: 'E_SANDBOX_WORKSPACE',
        detail: { reason: 'workspace-ancestor-unavailable' },
      })
      await expect(lstat(join(root, 'missing-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32').each(['symlink', 'dangling-symlink', 'file'])(
  'refuses a %s .agh without changing the entry or its target',
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-ancestor-refused-')))
    try {
      const target = join(root, 'outside')
      if (kind === 'file') await writeFile(join(root, '.agh'), 'keep')
      else {
        if (kind === 'symlink') await mkdir(target)
        await symlink(target, join(root, '.agh'))
      }
      await expect(prepareSandboxWorkspaceAncestor(root)).rejects.toMatchObject({
        code: 'E_SANDBOX_WORKSPACE',
        detail: { reason: 'workspace-ancestor-not-directory' },
      })
      if (kind === 'file') expect(await readFile(join(root, '.agh'), 'utf8')).toBe('keep')
      else expect((await lstat(join(root, '.agh'))).isSymbolicLink()).toBe(true)
      await expect(lstat(join(target, 'secrets'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
