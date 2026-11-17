import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsPolicy } from '@agnes/core'
import { CliWorkspaceAuthority } from '@agnes/host-common/workspace-authority'
import type { SessionEnvironment } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExec, type ExecAdapter } from '../../src/adapters/exec.js'
import { createPlatform } from '../../src/adapters/platform.js'
import { sessionCommandEnvironment, withSessionEnvironment } from '../../src/adapters/session-environment.js'
import { createSessionWorkspaceAdapterFactory } from '../../src/adapters/session-workspace.js'

// guards-allow-platform: the child below is a POSIX shell.
const posixIt = process.platform === 'win32' ? it.skip : it
const AGENT: SessionEnvironment = {
  pathPrepend: ['/state/worker-bin'],
  set: { GIT_CONFIG_GLOBAL: '/state/worker-gitconfig', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '' },
  unset: ['GH_TOKEN', 'GITHUB_TOKEN', 'LANG'],
}
const roots: string[] = []
const policyFor = (root: string, digest: string): FsPolicy =>
  Object.freeze({
    workspaceRoot: root,
    rules: Object.freeze([
      Object.freeze({ effect: 'allow' as const, path: root, source: 'workspace' as const, hard: false }),
      Object.freeze({
        effect: 'deny' as const,
        path: join(root, '.git'),
        source: 'host-integrity' as const,
        hard: true,
      }),
      Object.freeze({
        effect: 'deny' as const,
        path: join(root, '.agh', 'secrets'),
        source: 'host-integrity' as const,
        hard: true,
      }),
    ]),
    networkAllow: Object.freeze([]),
    digest,
  })
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("a session's own environment", () => {
  it('applies after the floor and the caller: removals, then variables, then PATH directories first', () => {
    const floor = { PATH: '/usr/bin', HOME: '/srv/operator', LANG: 'C' }
    const env = sessionCommandEnvironment(
      { PYTHONUTF8: '1', GH_TOKEN: 'from-caller', GIT_CONFIG_GLOBAL: '/caller' },
      AGENT,
      floor,
    )
    expect(env).toEqual({
      PATH: '/state/worker-bin:/usr/bin',
      HOME: '/srv/operator',
      LANG: undefined,
      PYTHONUTF8: '1',
      GH_TOKEN: undefined,
      GIT_CONFIG_GLOBAL: '/state/worker-gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ASKPASS: '',
    })
  })

  posixIt(
    'reaches the spawned command and its processes, and the daemon environment it leaves out stays out',
    async () => {
      vi.stubEnv('GH_TOKEN', 'daemon-token')
      vi.stubEnv('GIT_CONFIG_COUNT', '1')
      vi.stubEnv('LANG', 'C')
      let environment: SessionEnvironment | undefined = AGENT
      const exec = withSessionEnvironment(createExec(), () => environment)
      const script =
        'echo "path=$PATH"; echo "global=$GIT_CONFIG_GLOBAL"; echo "token=${GH_TOKEN-unset}"; echo "count=${GIT_CONFIG_COUNT-unset}"; echo "lang=${LANG-unset}"'
      const ran = await exec.run(['sh', '-c', script], { cwd: tmpdir(), env: { GH_TOKEN: 'caller' } })
      expect(ran.stdout).toContain(`path=/state/worker-bin:${process.env.PATH}`)
      expect(ran.stdout).toContain('global=/state/worker-gitconfig')
      expect(ran.stdout).toContain('token=unset')
      expect(ran.stdout).toContain('count=unset')
      expect(ran.stdout, 'a floor variable is removed too').toContain('lang=unset')
      // An interactive process, as a job or a persistent shell, gets the same.
      const process_ = await exec.openProcess!(['sh', '-c', script], { cwd: tmpdir() })
      let output = ''
      process_.onOutput((chunk) => {
        output += chunk.text
      })
      await process_.exited
      await process_.close()
      expect(output).toContain('global=/state/worker-gitconfig')
      expect(output).toContain('token=unset')
      // Read for each command: a changed environment applies to the next one.
      environment = undefined
      const plain = await exec.run(['sh', '-c', script], { cwd: tmpdir() })
      expect(plain.stdout).toContain(`path=${process.env.PATH}\n`)
      expect(plain.stdout).toContain('global=\n')
    },
  )

  it('refuses the command when the environment cannot be read, without starting it', async () => {
    const run = vi.fn<ExecAdapter['run']>()
    const exec = withSessionEnvironment({ run, killAll: async () => undefined }, () => {
      throw new Error('E_SESSION_ENVIRONMENT: damaged')
    })
    await expect(exec.run(['true'], { cwd: tmpdir() })).rejects.toThrow('E_SESSION_ENVIRONMENT')
    expect(run).not.toHaveBeenCalled()
  })

  it("is applied by a session's workspace fence for that session only", async () => {
    const rootA = await realpath(await mkdtemp(join(tmpdir(), 'agnes-env-a-')))
    const rootB = await realpath(await mkdtemp(join(tmpdir(), 'agnes-env-b-')))
    roots.push(rootA, rootB)
    const run = vi.fn<ExecAdapter['run']>(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
    }))
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createPlatform(),
      exec: { run, killAll: async () => undefined },
      sessionEnvironment: (key) => (key === 'agent' ? AGENT : undefined),
    })
    const fenceFor = async (root: string, key: string, digest: string) => {
      const handle = await factory.openWorkspace(new CliWorkspaceAuthority(root).bind(key))
      const fence = await factory.openFence(handle)
      fence.bind(policyFor(root, digest))
      fence.activateGate({ backend: 'none', onUnavailable: 'allow' })
      return { fence, handle }
    }
    const agent = await fenceFor(rootA, 'agent', 'a'.repeat(64))
    const owner = await fenceFor(rootB, 'owner', 'b'.repeat(64))
    await agent.fence.exec(['tool'], {
      cwd: rootA,
      env: { PYTHONUTF8: '1' },
      sandbox: { policyDigest: 'a'.repeat(64), backend: 'none' },
    })
    await owner.fence.exec(['tool'], {
      cwd: rootB,
      env: { PYTHONUTF8: '1' },
      sandbox: { policyDigest: 'b'.repeat(64), backend: 'none' },
    })
    expect(run.mock.calls[0]?.[1].env).toMatchObject({
      PATH: expect.stringMatching(/^\/state\/worker-bin/),
      GIT_CONFIG_GLOBAL: '/state/worker-gitconfig',
      PYTHONUTF8: '1',
    })
    expect(run.mock.calls[1]?.[1].env).toEqual({ PYTHONUTF8: '1' })
    for (const { fence, handle } of [agent, owner]) {
      await fence.close()
      await handle.close()
    }
  })

  // guards-allow-platform: a real Windows Job command through a Windows workspace's fence.
  it.runIf(process.platform === 'win32')(
    "reaches a Windows workspace's commands with one prepended Path and without the removed variables",
    async () => {
      vi.stubEnv('GH_TOKEN', 'daemon-token')
      const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-env-w-')))
      roots.push(root)
      const factory = createSessionWorkspaceAdapterFactory({
        platform: createPlatform(),
        exec: createExec({ windowsNodeExecutable: process.execPath }),
        sessionEnvironment: () => ({ ...AGENT, pathPrepend: [join(root, 'worker-bin')] }),
      })
      const handle = await factory.openWorkspace(new CliWorkspaceAuthority(root).bind('agent'))
      const fence = await factory.openFence(handle)
      fence.bind(policyFor(root, 'c'.repeat(64)))
      fence.activateGate({ backend: 'none', onUnavailable: 'allow' })
      const script =
        'const e=process.env;process.stdout.write(JSON.stringify([Object.keys(e).filter(k=>k.toUpperCase()==="PATH").length,e.PATH,e.GH_TOKEN??null,e.GIT_CONFIG_GLOBAL]))'
      const ran = await fence.exec([process.execPath, '-e', script], {
        cwd: root,
        env: { Gh_Token: 'caller' },
        sandbox: { policyDigest: 'c'.repeat(64), backend: 'none' },
      })
      const [paths, path, token, global] = JSON.parse(ran.stdout) as [number, string, string | null, string]
      expect(paths).toBe(1)
      expect(path.startsWith(`${join(root, 'worker-bin')};`)).toBe(true)
      expect(token).toBeNull()
      expect(global).toBe('/state/worker-gitconfig')
      await fence.close()
      await handle.close()
    },
  )
})
