import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspaceDirectory, WorkspaceDirectoryError } from '../src/workspace.js'

const roots: string[] = []
const windows = process.platform === 'win32' // guards-allow-platform: real Windows directory link and ACL fixtures.
function acl(path: string, ...args: string[]): void {
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path, ...args], {
    windowsHide: true,
    stdio: 'pipe',
  })
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agnes-workspace-'))
  roots.push(root)
  return root
}

async function reasonOf(path: string): Promise<string | undefined> {
  try {
    await resolveWorkspaceDirectory(path)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceDirectoryError)
    return (error as WorkspaceDirectoryError).reason
  }
  return undefined
}

describe('resolveWorkspaceDirectory', () => {
  it('returns one canonical identity for a directory and a symlink spelling', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'project')
    const alias = join(root, 'alias')
    await mkdir(directory)
    await symlink(directory, alias, windows ? 'junction' : 'dir')

    const expected = await realpath(directory)
    await expect(resolveWorkspaceDirectory(directory)).resolves.toEqual({ path: expected, name: 'project' })
    await expect(resolveWorkspaceDirectory(alias)).resolves.toEqual({ path: expected, name: 'project' })
  })

  it('rejects relative, missing and non-directory inputs with stable reasons', async () => {
    const root = await temporaryRoot()
    const file = join(root, 'file.txt')
    await writeFile(file, 'not a directory')

    await expect(reasonOf('relative/project')).resolves.toBe('not-absolute')
    await expect(reasonOf(join(root, 'missing'))).resolves.toBe('not-found')
    await expect(reasonOf(file)).resolves.toBe('not-directory')
  })

  it('rejects a directory the current user cannot read or search', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'closed')
    await mkdir(directory, { mode: 0o700 })
    try {
      if (windows) acl(directory, '/deny', '*S-1-1-0:(RD)')
      else await chmod(directory, 0o000)
      if (windows) await expect(readdir(directory)).rejects.toThrow()
      await expect(reasonOf(directory)).resolves.toBe('not-accessible')
    } finally {
      if (windows) acl(directory, '/remove:d', '*S-1-1-0')
      else await chmod(directory, 0o700)
    }
  })
})

import { execFileSync } from 'node:child_process'
