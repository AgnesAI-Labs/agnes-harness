import { createPlatform, probeLinuxSandboxSupport, resolveConfiguredPowerShell } from '@agnes/host'
import { afterEach, expect, it, vi } from 'vitest'
import { doctorPlatform } from '../src/commands/doctor-profile.js'

vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createPlatform: vi.fn(),
  probeLinuxSandboxSupport: vi.fn(),
  resolveConfiguredPowerShell: vi.fn(),
}))
afterEach(() => vi.resetAllMocks())
const deps = {
  env: { AGNES_POWERSHELL: '5.1' },
  home: '/unused',
  cwd: '/unused',
  agnesVersion: '0',
  log: () => {},
}
function platform(os: 'win32' | 'linux') {
  vi.mocked(createPlatform).mockReturnValue({
    os,
    matches: () => true,
    probe: async () => {},
    capability: () => ({ level: 'unavailable', scope: [], reason: 'test sandbox unavailable' }),
    snapshot: () => ({ os, arch: 'x64', capabilities: { 'sandbox.l1': 'unavailable' } }),
  } as unknown as ReturnType<typeof createPlatform>)
}

it('reports the selected runtime shell without changing sandbox availability', async () => {
  platform('win32')
  vi.mocked(resolveConfiguredPowerShell).mockResolvedValue({
    path: 'C:\\Windows\\powershell.exe',
    version: '5.1.26100.9444',
    edition: 'Desktop',
    nativeArguments: 'Legacy',
  })
  const result = await doctorPlatform(deps)
  expect(resolveConfiguredPowerShell).toHaveBeenCalledWith(expect.objectContaining(deps.env))
  expect(result.status).toBe('warn')
  expect(result.detail).toEqual(
    expect.arrayContaining([
      'PowerShell 5.1.26100.9444 (Desktop)',
      'shell path C:\\Windows\\powershell.exe',
      'native arguments Legacy',
      'sandbox.l1=unavailable',
      'sandbox.l1.reason=test sandbox unavailable',
    ]),
  )
})
it('fails with a useful fixed hint without exposing probe output', async () => {
  platform('win32')
  vi.mocked(resolveConfiguredPowerShell).mockRejectedValue(new Error('private stderr token'))
  const result = await doctorPlatform(deps)
  expect(result.status).toBe('fail')
  expect(result.detail.join(' ')).toContain('AGNES_POWERSHELL')
  expect(JSON.stringify(result)).not.toContain('private stderr token')
})
it('keeps non-Windows diagnostics independent of PowerShell', async () => {
  platform('linux')
  vi.mocked(probeLinuxSandboxSupport).mockResolvedValue({ bubblewrap: 'installed', landlockAbi: 6 })
  const result = await doctorPlatform(deps)
  expect(result.status).toBe('warn')
  expect(result.detail).toEqual([
    'os linux x64',
    'bubblewrap=installed; install bubblewrap and enable user namespaces for L1. Presence alone does not verify the boundary.',
    'Landlock ABI=6; diagnostic only, AGH currently uses bubblewrap for Linux command isolation.',
    'Unavailable L1 refuses commands by default. Explicit full-access runs commands without OS confinement and keeps memory enabled; the shell can then change memory files directly.',
    'Computer Use is unsupported by the current pinned Linux driver admission; a graphical session alone cannot enable it.',
    'sandbox.l1=unavailable',
    'sandbox.l1.reason=test sandbox unavailable',
  ])
  expect(resolveConfiguredPowerShell).not.toHaveBeenCalled()
})
