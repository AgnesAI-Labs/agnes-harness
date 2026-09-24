import type { SeamWorkspace } from '@agnes/core'
import { testFsPolicy } from '@agnes/core/testkit'
import { describe, expect, it, vi } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { sandboxSeam } from '../src/seam.js'

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

describe('Host-bound sandbox seam', () => {
  it('keeps the package seam inert until Host supplies a workspace', async () => {
    const factory = await sandboxSeam(fakeSeamInit())
    await expect(factory.confine(['echo'])).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    expect(() => factory.fsPolicy()).toThrow('E_WORKSPACE_REQUIRED')
  })

  it('consumes only no-argument readiness and returns the exact Host policy', async () => {
    const factory = await sandboxSeam(fakeSeamInit())
    const ws = workspace()
    const seam = await factory.forWorkspace(ws.value)
    expect(ws.ready).toHaveBeenCalledOnce()
    expect(ws.ready).toHaveBeenCalledWith(undefined)
    expect(seam.fsPolicy()).toBe(ws.value.policy)
    await expect(seam.confine(['/bin/true'])).resolves.toEqual(['sandbox', '/bin/true'])
    expect(ws.confine).toHaveBeenLastCalledWith({ argv: ['/bin/true'], cwd: '/work/proj' })
  })

  it('routes exec through the opaque backend and Host-bound exec without compiling policy', async () => {
    const factory = await sandboxSeam(fakeSeamInit())
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
      sandbox: { policyDigest: ws.value.policy.digest, backend: 'l1' },
    })
  })

  it('reports enforcement only while Host confirms the same bound digest', async () => {
    const factory = await sandboxSeam(fakeSeamInit())
    const ws = workspace()
    const seam = await factory.forWorkspace(ws.value)
    expect(seam.enforcement()).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    ws.setBound(null)
    expect(seam.enforcement()).toEqual({ level: 'none', scope: [] })
  })

  it('rejects a Host workspace whose root and policy disagree before readiness', async () => {
    const factory = await sandboxSeam(fakeSeamInit())
    const ws = workspace({ root: '/other' })
    await expect(factory.forWorkspace(ws.value)).rejects.toMatchObject({ code: 'E_SANDBOX_WORKSPACE' })
    expect(ws.ready).not.toHaveBeenCalled()
  })
})
