import type { SeamWorkspace } from '@agnes/core'
import { testFsPolicy } from '@agnes/core/testkit'
import { describe, expect, it, vi } from 'vitest'
import { createSandboxSeam } from '../src/sandbox-seam.js'

function workspace(overrides: Partial<SeamWorkspace> = {}) {
  const policy = testFsPolicy('/work/proj')
  let bound: string | null = policy.digest
  const confine = vi.fn(({ argv }: { argv: readonly string[]; cwd: string }) => ['sandbox', ...argv])
  const ready = vi.fn(async () => ({ confine }))
  const exec = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', truncated: false }))
  const value: SeamWorkspace = {
    root: '/work/proj',
    policy,
    readiness: { ready },
    shell: 'posix',
    execBackend: 'l1',
    enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
    exec,
    binding: () => ({ policyDigest: bound }),
    ...overrides,
  }
  return { value, ready, confine, exec, setBound: (digest: string | null) => (bound = digest) }
}

const executionPolicy = (value: SeamWorkspace) => ({
  workspaceRoot: value.root,
  digest: value.policy.digest,
  fsRead: { allow: ['/'], deny: ['/work/proj/.git', '/work/proj/.agh/secrets'] },
  fsWrite: {
    allow: ['/work/proj'],
    deny: ['/work/proj/.git', '/work/proj/.agh/secrets'],
  },
  network: { mode: 'deny', hosts: [] },
  requiredEnforcement: value.enforcement,
})

describe('Host-bound sandbox seam', () => {
  it('keeps the package seam inert until Host supplies a workspace', async () => {
    const factory = createSandboxSeam()
    await expect(factory.confine(['echo'])).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    expect(() => factory.fsPolicy()).toThrow('E_WORKSPACE_REQUIRED')
  })

  it('consumes only no-argument readiness and returns the exact Host policy', async () => {
    const factory = createSandboxSeam()
    const ws = workspace()
    const seam = await factory.forWorkspace(ws.value)
    expect(ws.ready).toHaveBeenCalledOnce()
    expect(ws.ready).toHaveBeenCalledWith(undefined)
    expect(seam.fsPolicy()).toBe(ws.value.policy)
    await expect(seam.confine(['/bin/true'])).resolves.toEqual(['sandbox', '/bin/true'])
    expect(ws.confine).toHaveBeenLastCalledWith({ argv: ['/bin/true'], cwd: '/work/proj' })
  })

  it('routes exec through the opaque backend and Host-bound exec without compiling policy', async () => {
    const factory = createSandboxSeam()
    const ws = workspace()
    const seam = await factory.forWorkspace(ws.value)
    await seam.exec(['$SHELL', 'printf hi'], { cwd: '/work/proj/subdir', stdin: 'input' })
    expect(ws.confine).toHaveBeenCalledWith({
      argv: ['sh', '-c', 'printf hi'],
      cwd: '/work/proj/subdir',
    })
    expect(ws.exec).toHaveBeenCalledWith(['sandbox', 'sh', '-c', 'printf hi'], {
      cwd: '/work/proj/subdir',
      stdin: 'input',
      sandbox: {
        policyDigest: ws.value.policy.digest,
        backend: 'l1',
        policy: executionPolicy(ws.value),
        enforcement: ws.value.enforcement,
      },
    })
  })

  it('carries inbound-only loopback authority and refuses unconfined or external bindings', async () => {
    const ws = workspace({ policy: { ...testFsPolicy('/work/proj'), loopbackServe: true } })
    const seam = await createSandboxSeam().forWorkspace(ws.value)
    await seam.exec(['/bin/true'], { cwd: ws.value.root })
    expect(ws.exec).toHaveBeenCalledWith(
      ['sandbox', '/bin/true'],
      expect.objectContaining({
        sandbox: expect.objectContaining({
          policy: expect.objectContaining({ network: { mode: 'loopback-serve', hosts: [] } }),
        }),
      }),
    )
    for (const overrides of [
      { execBackend: 'none' as const },
      { execBackend: 'remote' as const },
      { providerId: 'docker' },
    ]) {
      await expect(createSandboxSeam().forWorkspace({ ...ws.value, ...overrides })).rejects.toThrow(
        'loopback serving requires a local L1 backend',
      )
    }
  })

  it('reports enforcement only while Host confirms the same bound digest', async () => {
    const factory = createSandboxSeam()
    const ws = workspace()
    const seam = await factory.forWorkspace(ws.value)
    expect(seam.enforcement()).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    ws.setBound(null)
    expect(seam.enforcement()).toEqual({ level: 'none', scope: [] })
  })

  it('skips host confinement when a startup provider is selected', async () => {
    const factory = createSandboxSeam()
    const ws = workspace({ providerId: 'docker' })
    const seam = await factory.forWorkspace(ws.value)
    await seam.exec(['/bin/echo', 'hi'], { cwd: '/work/proj' })
    expect(ws.confine).not.toHaveBeenCalled()
    expect(ws.exec).toHaveBeenCalledWith(['/bin/echo', 'hi'], {
      cwd: '/work/proj',
      sandbox: {
        policyDigest: ws.value.policy.digest,
        backend: 'l1',
        provider: 'docker',
        policy: executionPolicy(ws.value),
      },
    })
    await expect(seam.confine(['/bin/echo'])).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(seam.enforcement()).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
  })

  it('rejects a Host workspace whose root and policy disagree before readiness', async () => {
    const factory = createSandboxSeam()
    const ws = workspace({ root: '/other' })
    await expect(factory.forWorkspace(ws.value)).rejects.toMatchObject({ code: 'E_SANDBOX_WORKSPACE' })
    expect(ws.ready).not.toHaveBeenCalled()
  })
})

describe('Host-bound sandbox seam over a remote workspace', () => {
  it('stamps the remote binding on exec and refuses to confine a local argv', async () => {
    const ws = workspace({ execBackend: 'remote', enforcement: { level: 'none', scope: [] } })
    const seam = await createSandboxSeam().forWorkspace(ws.value)
    await seam.exec(['sh', '-c', 'true'], { cwd: '/work/proj' })
    expect(ws.exec).toHaveBeenCalledWith(['sh', '-c', 'true'], {
      cwd: '/work/proj',
      sandbox: { policyDigest: ws.value.policy.digest, backend: 'remote' },
    })
    expect(ws.confine).not.toHaveBeenCalled()
    await expect(seam.confine(['/bin/true'])).rejects.toThrow(/remote sandbox/)
    expect(seam.fsPolicy()).toBe(ws.value.policy)
    expect(seam.enforcement()).toEqual({ level: 'none', scope: [] })
  })

  it('refuses a remote workspace whose policy the Host has not bound', async () => {
    const ws = workspace({ execBackend: 'remote' })
    ws.setBound(null)
    await expect(createSandboxSeam().forWorkspace(ws.value)).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
    })
  })
})
