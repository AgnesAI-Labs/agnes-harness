import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-extra-dirs-')))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const bytes = (text: string) => new TextEncoder().encode(text)

describe('extra directories in a session binding', () => {
  const open = async (dataDir: string, root: string, extraRoots: string[], key = 'extra-session') => {
    const { host } = await createTestHost({ dataDir, disableSessionTitle: true })
    const binding = host.acceptWorkspaceBinding(
      {
        version: 1,
        sessionKey: key,
        workspaceId: 'd'.repeat(64),
        revision: 1,
        canonicalRoot: root,
        ...(extraRoots.length ? { extraRoots } : {}),
      },
      key,
    )
    return { host, session: () => host.createSession({ key, cwd: root, binding }) }
  }

  it('reads and writes the extra tree, keeps .git and everything else refused, and pins the list on reopen', async () => {
    const dataDir = tempDir()
    const root = tempDir()
    const extra = tempDir()
    const other = tempDir()
    mkdirSync(join(extra, '.git'))
    writeFileSync(join(extra, '.git', 'config'), 'x')
    writeFileSync(join(extra, 'lib.txt'), 'library')
    writeFileSync(join(other, 'a.txt'), 'other')

    const first = await open(dataDir, root, [extra])
    try {
      const session = await first.session()
      const invoke = session.d.workspaceInvocation
      if (!invoke) throw new Error('session has no workspace invocation')
      await expect(invoke.run((view) => view.fs().read(join(extra, 'lib.txt')))).resolves.toEqual(
        bytes('library'),
      )
      await invoke.run((view) => view.fs().write(join(extra, 'new.txt'), bytes('written')))
      expect(readFileSync(join(extra, 'new.txt'), 'utf8')).toBe('written')
      await expect(invoke.run((view) => view.fs().read(join(extra, '.git', 'config')))).rejects.toMatchObject(
        {
          code: 'E_FS_DENIED',
        },
      )
      await expect(invoke.run((view) => view.fs().read(join(other, 'a.txt')))).rejects.toMatchObject({
        code: 'E_FS_DENIED',
      })
    } finally {
      await first.host.close()
    }

    const same = await open(dataDir, root, [extra])
    try {
      await expect(same.session()).resolves.toBeDefined()
    } finally {
      await same.host.close()
    }

    for (const changed of [[], [extra, other]]) {
      const reopened = await open(dataDir, root, changed)
      try {
        await expect(reopened.session()).rejects.toThrow()
      } finally {
        await reopened.host.close()
      }
    }
  })
})
