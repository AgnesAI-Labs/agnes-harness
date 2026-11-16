import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { CliWorkspaceAuthority } from '@agnes/host-common/workspace-authority'
import type { SessionEnvironment } from '@agnes/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// The Windows runners with the Job start replaced, so their environment handling runs on any platform; the merge is
// the real one over a case-insensitive comparison, as Windows compares names.
const mocks = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('@agnes/system-node/process-spawn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agnes/system-node/process-spawn')>()
  const caseless = (left: string, right: string) => left.toUpperCase() === right.toUpperCase()
  return {
    ...real,
    startWindowsJobProcess: mocks.start,
    mergeWindowsEnvironment: (...layers: Parameters<typeof real.mergeWindowsEnvironment>) =>
      real.mergeEnvironmentLayers(caseless, layers),
  }
})
vi.mock('../../src/adapters/session-environment.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapters/session-environment.js')>()
  return { ...real, withSessionEnvironment: vi.fn(real.withSessionEnvironment) }
})
vi.mock('../../src/adapters/powershell-file.js', () => ({
  preparePowerShellFile: (_: unknown, argv: string[]) => ({ argv, dispose: () => {} }),
}))

import { createExec, type ExecAdapter } from '../../src/adapters/exec.js'
import { createWin32Platform } from '../../src/adapters/platform.js'
import { sessionCommandEnvironment, withSessionEnvironment } from '../../src/adapters/session-environment.js'
import { createSessionWorkspaceAdapterFactory } from '../../src/adapters/session-workspace.js'

const AGENT: SessionEnvironment = {
  pathPrepend: ['C:\\state\\worker-bin'],
  set: { GIT_CONFIG_GLOBAL: 'C:\\state\\worker-gitconfig', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '' },
  unset: ['GH_TOKEN', 'GITHUB_TOKEN'],
}
beforeEach(() => {
  mocks.start.mockReset()
  mocks.start.mockImplementation(async () => ({
    pid: 1,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    completion: Promise.resolve({ code: 0, signal: null, cancelled: false }),
    terminate() {},
  }))
})
afterEach(() => {
  vi.unstubAllEnvs()
})

it('puts the directories first on an existing Path, in its spelling, and adds no PATH', () => {
  const env = sessionCommandEnvironment(
    { gh_token: 'from-caller', Git_Config_Global: 'C:\\caller' },
    AGENT,
    { Path: 'C:\\Windows;C:\\Program Files\\Git\\cmd', SystemRoot: 'C:\\Windows' },
    'win32',
  )
  expect(Object.keys(env).filter((name) => name.toUpperCase() === 'PATH')).toEqual(['Path'])
  expect(env.Path).toBe('C:\\state\\worker-bin;C:\\Windows;C:\\Program Files\\Git\\cmd')
  expect(env.Git_Config_Global, 'a set variable replaces every spelling').toBe('C:\\state\\worker-gitconfig')
  expect(Object.keys(env).filter((name) => name.toUpperCase() === 'GIT_CONFIG_GLOBAL')).toHaveLength(1)
  expect(Object.entries(env).filter(([name]) => name.toUpperCase() === 'GH_TOKEN')).toEqual([
    ['gh_token', undefined],
  ])
})

it('starts a Windows command and process without the removed variables, with one prepended Path', async () => {
  vi.stubEnv('PATH', 'C:\\Windows')
  const exec = createExec({
    windowsNodeExecutable: 'C:\\node.exe',
    baseEnv: { Path: 'C:\\Windows', GH_TOKEN: 'daemon', SystemRoot: 'C:\\Windows' },
  })
  const fenced = withSessionEnvironment(exec, () => AGENT, 'win32')
  await fenced.run(['tool'], { cwd: 'C:\\work', env: { github_token: 'caller', PYTHONUTF8: '1' } })
  const process_ = await fenced.openProcess?.(['tool'], { cwd: 'C:\\work' })
  await process_?.exited
  expect(mocks.start).toHaveBeenCalledTimes(2)
  for (const [, options] of mocks.start.mock.calls as [unknown, { env: Record<string, string> }][]) {
    const names = Object.keys(options.env).map((name) => name.toUpperCase())
    expect(names.filter((name) => name === 'PATH')).toHaveLength(1)
    expect(names).not.toContain('GH_TOKEN')
    expect(names).not.toContain('GITHUB_TOKEN')
    expect(Object.values(options.env)).not.toContain(undefined)
    const path = Object.entries(options.env).find(([name]) => name.toUpperCase() === 'PATH')?.[1]
    expect(path).toBe('C:\\state\\worker-bin;C:\\Windows')
    expect(options.env.GIT_CONFIG_GLOBAL).toBe('C:\\state\\worker-gitconfig')
  }
})

it("gives a Windows workspace's fence the Windows names", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-env-w-')))
  try {
    const exec: ExecAdapter = { run: vi.fn(), killAll: async () => undefined }
    const factory = createSessionWorkspaceAdapterFactory({
      platform: createWin32Platform(),
      exec,
      sessionEnvironment: () => AGENT,
    })
    const handle = await factory.openWorkspace(new CliWorkspaceAuthority(root).bind('agent'))
    const fence = await factory.openFence(handle)
    expect(withSessionEnvironment).toHaveBeenCalledWith(exec, expect.any(Function), 'win32')
    await fence.close()
    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
