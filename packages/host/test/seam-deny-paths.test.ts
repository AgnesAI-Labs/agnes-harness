import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceInvocationView } from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

/**
 * Task 6 moved policy compilation out of the package seam and into the Host-owned per-session
 * workspace runtime. These tests exercise that lifecycle: preset input is compiled when the
 * session opens, then every filesystem operation enters the session invocation capability.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-bind-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'vault'), { recursive: true })
  writeFileSync(join(dir, 'vault', 'inside'), 'a credential', 'utf8')
  return dir
}

async function fixture(sandbox: Record<string, unknown>) {
  const dataDir = scratch()
  const assembled = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        disclosure: 'standard',
        sandbox,
      },
    },
  })
  return { ...assembled, dataDir }
}

async function inWorkspace<T>(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['host']['createSession']>>,
  invoke: (view: WorkspaceInvocationView) => Promise<T>,
): Promise<T> {
  const port = session.d.workspaceInvocation
  if (!port) throw new Error('test session has no workspace invocation')
  return port.run(invoke)
}

describe('the Host binds compiled sandbox policy to each session workspace', () => {
  it('enforces a configured deny rule in every spelling', async () => {
    const { host, dataDir } = await fixture({ deny_paths: ['vault'] })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await inWorkspace(session, async (view) => {
        for (const spelling of ['vault', 'vault/inside', './vault/inside', 'x/../vault/inside'])
          await expect(view.fs().read(spelling), spelling).rejects.toThrow(/E_FS_DENIED/)
        await view.fs().write('ordinary.txt', new TextEncoder().encode('ok'))
      })
    } finally {
      await host.close()
    }
  })

  it('publishes the fitted sandbox enforcement only inside the invocation', async () => {
    const { host, dataDir } = await fixture({ deny_paths: ['vault'] })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await inWorkspace(session, async (view) => {
        expect(view.root).toBe(realpathSync(dataDir))
        expect(view.hookSandbox().enforcement()).toEqual({
          level: 'full',
          scope: ['file', 'network', 'process'],
        })
      })
    } finally {
      await host.close()
    }
  })

  it.each([
    ['a non-list deny_paths', { deny_paths: 'vault' }],
    ['an unknown setting', { invented: true }],
    ['an unsupported level', { level: 'L2' }],
  ])('refuses %s when the session workspace is compiled', async (_name, sandbox) => {
    let opened: Awaited<ReturnType<typeof fixture>>
    try {
      opened = await fixture(sandbox)
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_PRESET_UNSUPPORTED' })
      return
    }
    const { host, dataDir } = opened
    try {
      await expect(host.createSession({ cwd: dataDir })).rejects.toMatchObject({
        code: 'E_SANDBOX_WORKSPACE',
      })
    } finally {
      await host.close()
    }
  })

  it('always installs the Host integrity floor alongside preset rules', async () => {
    const { host, dataDir } = await fixture({ deny_paths: ['vault'] })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await inWorkspace(session, async (view) => {
        await expect(view.fs().read('.git/config')).rejects.toThrow(/E_FS_DENIED/)
        await expect(view.fs().read('.agh/secrets/key')).rejects.toThrow(/E_FS_DENIED/)
        // The secrets directory's name from before the `.agh` rename stays denied too.
        await expect(view.fs().read('.agnes/secrets/key')).rejects.toThrow(/E_FS_DENIED/)
      })
    } finally {
      await host.close()
    }
  })
})
