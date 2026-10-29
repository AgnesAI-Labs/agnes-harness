import type { Logger } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { sandboxWorkspaceProbe } from '../src/workspace-probe.js'

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as Logger

const input = (overrides: Record<string, unknown> = {}) => ({
  level: 'L0' as const,
  required: false,
  onUnavailable: 'deny' as const,
  shell: 'posix' as const,
  options: {
    cwd: '/work/proj',
    allowPaths: ['/work/proj'],
    denyPaths: ['/work/proj/.git'],
    networkAllow: [],
  },
  probeExec: vi.fn(async () => ({ code: 127, stdout: '', stderr: '', truncated: false, timedOut: false })),
  log,
  ...overrides,
})

describe('sandboxWorkspaceProbe', () => {
  it('keeps default-unavailable workspaces closed', async () => {
    const backend = await sandboxWorkspaceProbe(input())
    expect(backend).toMatchObject({ name: 'none', execBackend: 'none', degraded: false })
    expect(() => backend.confine({ argv: ['/bin/true'], cwd: '/work/proj' })).toThrow('SANDBOX_UNAVAILABLE')
  })

  it('allows an explicit L0 degradation without claiming process isolation', async () => {
    const backend = await sandboxWorkspaceProbe(input({ onUnavailable: 'allow' }))
    expect(backend.enforcement).toEqual({ level: 'partial', scope: ['file'] })
    expect(backend.confine({ argv: ['/bin/true'], cwd: '/work/proj' })).toEqual(['/bin/true'])
  })

  it('returns the actually probed compiler while Host retains the probe callback', async () => {
    const probeExec = vi.fn(async (argv: string[]) => ({
      code: argv[0] === 'bwrap' ? 0 : 127,
      stdout: argv[0] === 'bwrap' ? 'agnes-sandbox-probe-v1' : '',
      stderr: '',
      truncated: false,
      timedOut: false,
    }))
    const backend = await sandboxWorkspaceProbe(input({ level: 'L1', probeExec }))
    expect(backend).toMatchObject({ name: 'bwrap', execBackend: 'l1', degraded: false })
    expect(probeExec).toHaveBeenCalledOnce()
    expect(backend.confine({ argv: ['/bin/true'], cwd: '/work/proj' })).toEqual(
      expect.arrayContaining(['bwrap', '--chdir', '/work/proj', '--', '/bin/true']),
    )
  })

  it('refuses a required workspace when no backend probe succeeds', async () => {
    await expect(sandboxWorkspaceProbe(input({ level: 'L1', required: true }))).rejects.toMatchObject({
      code: 'E_SANDBOX_WORKSPACE',
      message: expect.stringContaining('explicitly select full-access'),
    })
  })
  it('refuses unsupported loopback serving and never treats the flag as permission to degrade', async () => {
    for (const platform of ['linux', 'win32', 'unknown']) {
      await expect(
        sandboxWorkspaceProbe(
          input({ level: 'L1', platform, options: { ...input().options, loopbackServe: true } }),
        ),
      ).rejects.toThrow('loopback serving requires the macOS L1 Seatbelt backend')
    }
    await expect(
      sandboxWorkspaceProbe(
        input({
          level: 'L1',
          platform: 'darwin',
          onUnavailable: 'allow',
          options: { ...input().options, loopbackServe: true },
        }),
      ),
    ).rejects.toThrow('cannot fall back')
  })

  it.each(['win32', 'linux'])(
    'opens a closed-network L1 deny workspace on %s without loopback and refuses each command, never running it unconfined',
    async (platform) => {
      const shell = platform === 'win32' ? ('powershell' as const) : ('posix' as const)
      const backend = await sandboxWorkspaceProbe(input({ level: 'L1', platform, shell }))
      expect(backend).toMatchObject({ execBackend: 'none', degraded: false })
      expect(() => backend.confine({ argv: ['node', 'server.js'], cwd: '/work/proj' })).toThrow(
        'no sandbox backend is available',
      )
    },
  )

  it('runs the trusted Windows unimplemented policy without an OS probe', async () => {
    const request = input({
      level: 'L1',
      platform: 'win32',
      shell: 'powershell',
      onUnavailable: 'allow-if-unimplemented',
    })
    const backend = await sandboxWorkspaceProbe(request)
    expect(backend).toMatchObject({
      execBackend: 'none',
      degraded: true,
      implementation: 'unimplemented',
      probeState: 'unprobed',
    })
    expect(backend.confine({ argv: ['pwsh', '-Command', 'echo ok'], cwd: request.options.cwd })).toEqual([
      'pwsh',
      '-Command',
      'echo ok',
    ])
    expect(request.probeExec).not.toHaveBeenCalled()
  })

  it.each([
    ['darwin', false],
    ['darwin', true],
    ['linux', false],
    ['unknown', false],
    ['win32', true],
  ])(
    'refuses failed, unknown or unsupported serving on %s (loopback=%s)',
    async (platform, loopbackServe) => {
      await expect(
        sandboxWorkspaceProbe(
          input({
            level: 'L1',
            platform,
            onUnavailable: 'allow-if-unimplemented',
            options: { ...input().options, loopbackServe },
          }),
        ),
      ).rejects.toMatchObject({
        code: platform === 'win32' && loopbackServe ? 'E_SANDBOX_BACKEND_POLICY' : 'E_SANDBOX_WORKSPACE',
      })
    },
  )

  it.each([
    ['darwin', '/usr/bin/sandbox-exec', 'seatbelt', false],
    ['darwin', '/usr/bin/sandbox-exec', 'seatbelt', true],
    ['linux', 'bwrap', 'bwrap', false],
  ])(
    'keeps %s %s backend %s after a successful probe (loopback=%s)',
    async (platform, executable, backendName, loopbackServe) => {
      const probeExec = vi.fn(async (argv: string[]) => ({
        code: argv[0] === executable ? 0 : 127,
        stdout: argv[0] === executable ? 'agnes-sandbox-probe-v1' : '',
        stderr: '',
        truncated: false,
        timedOut: false,
      }))
      const backend = await sandboxWorkspaceProbe(
        input({
          level: 'L1',
          platform,
          onUnavailable: 'allow-if-unimplemented',
          probeExec,
          options: { ...input().options, loopbackServe },
        }),
      )
      expect(backend).toMatchObject({
        name: backendName,
        execBackend: 'l1',
        implementation: 'implemented',
        probeState: 'ready',
        degraded: false,
      })
      expect(backend.enforcement).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    },
  )

  it('keeps required isolation stronger than the unimplemented allowance', async () => {
    await expect(
      sandboxWorkspaceProbe(
        input({
          level: 'L1',
          platform: 'win32',
          shell: 'powershell',
          required: true,
          onUnavailable: 'allow-if-unimplemented',
        }),
      ),
    ).rejects.toMatchObject({ code: 'E_SANDBOX_WORKSPACE' })
  })
})
