// Windows write-restricted dispatch through the local provider: the real decider and authority
// (over a fake NTFS), the real Host exec adapters, and the system-node launcher replaced by a spy
// that observes every business launch. Nothing here runs a Windows process.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { FsPolicy } from '@agnes/core'
import {
  type SandboxExecutionLease,
  type SandboxExecutionPolicy,
  type SandboxProviderInstance,
  SHELL_STDIN_SENTINEL,
} from '@agnes/extension-api'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ start: vi.fn(), seal: vi.fn() }))
vi.mock('@agnes/system-node/process-spawn', () => ({
  startWindowsJobProcess: mocks.start,
  sealWindowsConfinement: mocks.seal,
  mergeWindowsEnvironment: (...layers: object[]) => Object.assign({}, ...layers),
}))
vi.mock('../src/adapters/powershell-file.js', () => ({
  preparePowerShellFile: (_: unknown, argv: string[]) => ({ argv, dispose() {} }),
}))

import { createExec, createPolicyExec, type ExecAdapter, type ExecGateState } from '../src/adapters/exec.js'
import { createLocalSandboxProvider } from '../src/adapters/sandbox-local.js'
import {
  WINDOWS_ACL_ENFORCEMENT,
  WindowsAclExecution,
  type WindowsAclGate,
  windowsPartialPolicy,
} from '../src/windows-acl/execution.js'
import { WINDOWS_WRITE_BOUNDARY } from '../src/windows-acl/policy.js'
import { type AclWorld, aclHost, aclWorld } from './fixtures/windows-acl-fakes.js'

const DIGEST = 'd'.repeat(64)
const POWERSHELL = {
  path: 'C:\\pwsh.exe',
  version: '7.4.0',
  edition: 'Core',
  nativeArguments: 'Standard',
} as const

let base = ''
let world: AclWorld
let execution: WindowsAclExecution
let host: ReturnType<typeof aclHost>
const instances: SandboxProviderInstance[] = []

type Exit = { code: number | null; signal: string | null; cancelled: boolean }
/** A started Job as the launcher reports it; the test decides when it exits. */
function job(exit?: Exit) {
  let finish!: (result: Exit) => void
  const completion = new Promise<Exit>((resolve) => {
    finish = resolve
  })
  if (exit) finish(exit)
  const terminate = vi.fn(() => finish({ code: null, signal: 'SIGKILL', cancelled: true }))
  return {
    pid: 7,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    completion,
    terminate,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.seal.mockImplementation((input: object) => Object.freeze({ ...input }))
  mocks.start.mockImplementation(async () => job({ code: 0, signal: null, cancelled: false }))
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agh-acl-dispatch-')))
  world = aclWorld(base)
  host = aclHost(world)
  execution = new WindowsAclExecution({
    authority: host.authority,
    rootIdentity: (path) => host.platform.rootIdentity(path),
    localProviderId: RELEASE_DEFAULTS.sandboxProvider,
  })
})
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose()
  rmSync(base, { recursive: true, force: true })
})

function provider(
  exec = createExec({ windowsNodeExecutable: 'C:\\node.exe', windowsPowerShell: POWERSHELL }),
) {
  return createLocalSandboxProvider(exec, 'win32', { windowsAcl: execution })
}

async function open(
  local: ReturnType<typeof provider>,
  config: Parameters<ReturnType<typeof provider>['create']>[0],
): Promise<SandboxProviderInstance> {
  const instance = await local.create(config)
  instances.push(instance)
  return instance
}

async function leased(
  mode: 'read-only' | 'workspace-write',
  local = provider(),
  session = `session-${mode}`,
) {
  const lease = await execution.acquire({
    sessionExecutionId: session,
    canonicalRoot: world.workspace,
    policyDigest: DIGEST,
    mode,
  })
  const instance = await open(local, { workspaceRoot: world.workspace, executionLease: lease })
  return { lease, instance, policy: windowsPartialPolicy(world.workspace, DIGEST, lease) }
}

const call = (policy: SandboxExecutionPolicy, extra: object = {}) => ({
  argv: ['node', '-e', '0'],
  cwd: world.workspace,
  policy,
  enforcement: WINDOWS_ACL_ENFORCEMENT,
  ...extra,
})

const sealed = (index = 0) => mocks.seal.mock.calls[index]?.[0]
const launched = (index = 0) => mocks.start.mock.calls[index]?.[1]

describe('one restricted entry for every ordinary execution', () => {
  it('runs exec, a background process and the PowerShell stdin shell under the lease permit', async () => {
    const { lease, instance, policy } = await leased('workspace-write')
    const result = await instance.exec(call(policy, { env: { TEMP: 'C:\\elsewhere', tmp: 'C:\\other' } }))
    expect(result.enforcement).toEqual(WINDOWS_ACL_ENFORCEMENT)
    expect(sealed()).toMatchObject({
      mode: 'workspace-write',
      root: world.workspace,
      tempRoot: lease.tempRoot,
    })
    expect(sealed().writeSids).toHaveLength(2)
    expect(launched().confinement).toEqual(sealed())
    // The request cannot move TEMP/TMP out of the lease's private temp.
    expect(launched().env).toMatchObject({ TEMP: lease.tempRoot, TMP: lease.tempRoot })

    mocks.start.mockImplementation(async () => job())
    const background = await instance.openProcess!(call(policy))
    expect(background.enforcement).toEqual(WINDOWS_ACL_ENFORCEMENT)
    expect(launched(1).confinement).toEqual(sealed(1))
    const shell = await instance.openProcess!(call(policy, { argv: [SHELL_STDIN_SENTINEL] }))
    expect(mocks.start.mock.calls[2]?.[0]?.[0]).toBe(POWERSHELL.path)
    expect(launched(2).confinement).toEqual(sealed(2))
    expect(mocks.start).toHaveBeenCalledTimes(3)
    expect(mocks.seal).toHaveBeenCalledTimes(3)
    await background.close()
    await shell.close()
  })

  it('keeps a handed-over background Job running after the call signal ends', async () => {
    const { instance, policy } = await leased('workspace-write')
    const running = job()
    mocks.start.mockResolvedValueOnce(running)
    const signal = new AbortController()
    const handle = await instance.openProcess!(call(policy, { signal: signal.signal }))
    signal.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(running.terminate).not.toHaveBeenCalled()
    await handle.close()
    expect(running.terminate).toHaveBeenCalledTimes(1)
  })
})

describe('same root, separate sessions', () => {
  it('keeps read-only, workspace-write and full-access sessions apart on one root', async () => {
    const local = provider()
    const readOnly = await leased('read-only', local)
    const write = await leased('workspace-write', local)
    const full = await open(local, { workspaceRoot: world.workspace })
    expect(readOnly.instance).not.toBe(write.instance)

    await write.instance.exec(call(write.policy))
    await readOnly.instance.exec(call(readOnly.policy))
    await full.exec({
      argv: ['node', '-e', '0'],
      cwd: world.workspace,
      policy: {
        ...write.policy,
        fsWrite: { allow: ['/'], deny: [] },
        requiredEnforcement: { level: 'none', scope: [] },
      },
      enforcement: { level: 'none', scope: [] },
    })
    expect(sealed(0)).toMatchObject({ mode: 'workspace-write' })
    expect(sealed(1)).toEqual({ mode: 'read-only', root: world.workspace, writeSids: [] })
    // A read-only target has no private temp; it keeps whatever temp the caller's environment had.
    expect(launched(1).env.TEMP).toBe(process.env.TEMP)
    // Full access is the existing unconfined Job launch; no permit, no confinement.
    expect(launched(2).confinement).toBeUndefined()
    expect(mocks.seal).toHaveBeenCalledTimes(2)
  })

  it('takes the mode from the lease and refuses a read-only call that asks for write roots', async () => {
    const readOnly = await leased('read-only')
    await expect(
      readOnly.instance.exec(call({ ...readOnly.policy, fsWrite: { allow: [world.workspace], deny: [] } })),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

describe('refusals start nothing', () => {
  it('refuses a forged ACL boundary instead of falling back', async () => {
    const { instance, policy } = await leased('workspace-write')
    const forged = { ...WINDOWS_ACL_ENFORCEMENT.boundary!, fileRead: 'acl-partial' }
    await expect(
      instance.exec(call(policy, { enforcement: { ...WINDOWS_ACL_ENFORCEMENT, boundary: forged } })),
    ).rejects.toThrow()
    await expect(
      instance.exec(
        call({ ...policy, requiredEnforcement: { ...WINDOWS_ACL_ENFORCEMENT, boundary: forged } } as never),
      ),
    ).rejects.toThrow()
    await expect(
      instance.openProcess!(call(policy, { enforcement: { level: 'none', scope: [] } })),
    ).rejects.toThrow()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('refuses an old policy digest, a missing lease and a lease this Host does not hold', async () => {
    const local = provider()
    const { lease, instance, policy } = await leased('workspace-write', local)
    await expect(instance.exec(call({ ...policy, digest: 'e'.repeat(64) }))).rejects.toThrow()
    const unleased = await open(local, { workspaceRoot: world.workspace })
    await expect(unleased.exec(call(policy))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    await expect(unleased.openProcess!(call(policy))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    const creating = (each: typeof local, executionLease: SandboxExecutionLease) =>
      Promise.resolve().then(() => each.create({ workspaceRoot: world.workspace, executionLease }))
    await expect(creating(local, { ...lease, id: 'not-a-lease' })).rejects.toThrow()
    await expect(
      creating(local, { ...lease, rootIdentity: { volumeId: '1', fileId: '2' } }),
    ).rejects.toThrow()
    const posix = createLocalSandboxProvider(createExec(), 'darwin', { windowsAcl: execution })
    await expect(creating(posix, lease)).rejects.toThrow()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('refuses read denies, a closed network and required full isolation before any permit', async () => {
    const { instance, policy } = await leased('workspace-write')
    const stronger: SandboxExecutionPolicy[] = [
      { ...policy, fsRead: { allow: ['/'], deny: [join(world.workspace, 'secret')] } },
      { ...policy, network: { mode: 'deny', hosts: [] } },
      { ...policy, network: { mode: 'allow', hosts: ['example.com'] } },
      { ...policy, requiredEnforcement: { level: 'full', scope: ['file', 'network', 'process'] } },
    ]
    for (const each of stronger) await expect(instance.exec(call(each))).rejects.toThrow()
    expect(mocks.start).not.toHaveBeenCalled()
    // No permit was left unsettled: the lease still closes.
    await instance.dispose()
    instances.splice(instances.indexOf(instance), 1)
  })

  it('re-reads the root identity per launch and refuses a replaced root', async () => {
    const { instance, policy } = await leased('workspace-write')
    world.ntfs.replace(world.workspace)
    await expect(instance.exec(call(policy))).rejects.toMatchObject({ code: 'E_ACL_IDENTITY_MISMATCH' })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('refuses a PTY and the programmatic bridge', async () => {
    const { instance, policy } = await leased('workspace-write')
    await expect(instance.openProcess!(call(policy, { pty: { columns: 80, rows: 24 } }))).rejects.toThrow()
    await expect(instance.exec(call(policy, { bridge: async () => null }))).rejects.toThrow()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

describe('workspace root invalidation', () => {
  it.each([
    ['replaced', (path: string) => world.ntfs.replace(path), 'E_ACL_IDENTITY_MISMATCH'],
    ['missing', (path: string) => world.ntfs.forget(path), 'ENOENT'],
  ])(
    'refuses the next launch and stops the Jobs this lease owns when the root is %s',
    async (_name, invalidate, code) => {
      const local = provider()
      const { instance, policy } = await leased('workspace-write', local)
      const other = await leased('workspace-write', local, 'session-other')
      const running = job()
      mocks.start.mockResolvedValueOnce(running)
      const background = await instance.openProcess!(call(policy))
      const otherJob = job()
      mocks.start.mockResolvedValueOnce(otherJob)
      await other.instance.openProcess!(call(other.policy))
      invalidate(world.workspace)
      await expect(instance.exec(call(policy))).rejects.toMatchObject({ code })
      expect(running.terminate).toHaveBeenCalledTimes(1)
      await expect(background.exited).resolves.toBeDefined()
      expect(mocks.start).toHaveBeenCalledTimes(2)
      // The check happens at this lease's own launch; another session's Jobs are its own to stop.
      expect(otherJob.terminate).not.toHaveBeenCalled()
    },
  )
})

describe('lease lifetime in the facade', () => {
  it('releases a lease once, and disposes every lease it still holds with the authority', async () => {
    const first = await leased('workspace-write')
    const second = await leased('read-only')
    await execution.release(first.lease)
    await execution.release(first.lease)
    expect(() => execution.lease(first.lease)).toThrow()
    expect(execution.lease(second.lease)).toBeDefined()
    await execution.dispose()
    expect(() => execution.lease(second.lease)).toThrow()
    await expect(
      execution.acquire({
        sessionExecutionId: 'later',
        canonicalRoot: world.workspace,
        policyDigest: DIGEST,
        mode: 'read-only',
      }),
    ).rejects.toMatchObject({ code: 'E_ACL_DISPOSED' })
    instances.splice(0)
  })

  it('reads the current root identity without a tree walk', async () => {
    const before = world.ntfs.calls.inspect
    await expect(execution.rootIdentity(world.workspace)).resolves.toEqual(
      world.ntfs.identity(world.workspace),
    )
    expect(world.ntfs.calls.inspect).toBe(before)
  })
})

describe('launch failure', () => {
  it('never calls a raw launch when the restricted launch fails, and settles the permit', async () => {
    const { instance, policy } = await leased('workspace-write')
    mocks.start.mockRejectedValue(Object.assign(new Error('token'), { code: 'E_WINDOWS_LOGON_SID' }))
    await expect(instance.exec(call(policy))).rejects.toMatchObject({ code: 'E_WINDOWS_LOGON_SID' })
    await expect(instance.openProcess!(call(policy))).rejects.toMatchObject({ code: 'E_WINDOWS_LOGON_SID' })
    expect(mocks.start).toHaveBeenCalledTimes(2)
    for (const [, options] of mocks.start.mock.calls) expect(options.confinement).toBeDefined()
    await instance.dispose()
    instances.splice(instances.indexOf(instance), 1)
  })

  it('refuses a permit on a runner that cannot apply it', async () => {
    const { instance, policy } = await leased('workspace-write', provider(createExec()))
    await expect(instance.exec(call(policy))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    await expect(instance.openProcess!(call(policy))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(mocks.start).not.toHaveBeenCalled()
    await instance.dispose()
    instances.splice(instances.indexOf(instance), 1)
  })
})

describe('policy gate for the windows-acl backend', () => {
  const offer = () =>
    Object.freeze({
      enforcementLocation: 'host-spawn' as const,
      boundary: WINDOWS_WRITE_BOUNDARY,
      owner: RELEASE_DEFAULTS.sandboxProvider,
      policyDigest: DIGEST,
    })
  const fsPolicy = (): FsPolicy =>
    Object.freeze({
      workspaceRoot: world.workspace,
      digest: DIGEST,
      networkAllow: [],
      rules: [
        { effect: 'allow' as const, path: world.workspace, source: 'workspace' as const, hard: false },
        {
          effect: 'deny' as const,
          path: join(world.workspace, '.git'),
          source: 'host-integrity' as const,
          hard: true,
        },
      ],
    })
  function gated(lease: () => Promise<SandboxExecutionLease>) {
    const run = vi.fn<ExecAdapter['run']>(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
    }))
    const windowsAcl: WindowsAclGate = { hostSpawn: offer(), lease: vi.fn(lease) }
    const state: ExecGateState = {
      backend: 'windows-acl',
      onUnavailable: 'deny',
      access: 'workspace-write',
      windowsAcl,
    }
    const exec = createPolicyExec(
      { run, killAll: async () => {} },
      { policy: fsPolicy, boundDigest: () => DIGEST, state: () => state, authorizeCwd: async (cwd) => cwd },
    )
    return { exec, run, windowsAcl }
  }
  const binding = (extra: object = {}) => ({
    policyDigest: DIGEST,
    backend: 'windows-acl' as const,
    hostSpawn: offer(),
    enforcement: WINDOWS_ACL_ENFORCEMENT,
    ...extra,
  })

  it('compiles the partial process policy from the Host lease, not from the request', async () => {
    const lease = await execution.acquire({
      sessionExecutionId: 'gate',
      canonicalRoot: world.workspace,
      policyDigest: DIGEST,
      mode: 'workspace-write',
    })
    const { exec, run } = gated(async () => lease)
    const forgedPermit = Object.freeze({ leaseId: lease.id })
    await exec(['node'], { cwd: world.workspace, sandbox: binding(), windowsAcl: forgedPermit as never })
    const options = run.mock.calls[0]![1]
    expect(options.windowsAcl).toBeUndefined()
    expect(options.sandbox?.lease).toEqual(lease)
    // The file tools keep their .git deny; the process policy states only what the ACL applies.
    expect(options.sandbox?.policy).toMatchObject({
      fsRead: { allow: ['/'], deny: [] },
      fsWrite: { allow: [world.workspace, lease.tempRoot], deny: [] },
      network: { mode: 'allow', hosts: [] },
      requiredEnforcement: WINDOWS_ACL_ENFORCEMENT,
    })
  })

  it('refuses a request without the exact offer, before any lease is acquired', async () => {
    const { exec, run, windowsAcl } = gated(async () => {
      throw new Error('no lease expected')
    })
    const wrong = [
      binding({ hostSpawn: undefined }),
      binding({ hostSpawn: { ...offer(), owner: 'other' } }),
      binding({ hostSpawn: { ...offer(), policyDigest: 'e'.repeat(64) } }),
      binding({ enforcement: { level: 'partial', scope: ['file'] } }),
      binding({ provider: 'remote-box' }),
      binding({ backend: 'none' }),
    ]
    for (const sandbox of wrong)
      await expect(exec(['node'], { cwd: world.workspace, sandbox: sandbox as never })).rejects.toThrow()
    expect(windowsAcl.lease).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses when the lease cannot be acquired, and starts nothing', async () => {
    const { exec, run } = gated(async () => {
      throw Object.assign(new Error('grant failed'), { code: 'E_ACL_NEEDS_ATTENTION' })
    })
    await expect(exec(['node'], { cwd: world.workspace, sandbox: binding() })).rejects.toMatchObject({
      code: 'E_ACL_NEEDS_ATTENTION',
    })
    expect(run).not.toHaveBeenCalled()
  })
})
