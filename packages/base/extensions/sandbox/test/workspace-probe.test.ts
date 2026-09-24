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
    })
  })
})
