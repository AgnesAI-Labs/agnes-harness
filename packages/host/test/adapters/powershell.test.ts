import { win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type PowerShellCandidate,
  type PowerShellDescriptor,
  powerShellCandidates,
  probePowerShell,
  resolvePowerShell,
} from '../../src/adapters/powershell.js'

const legacy: PowerShellDescriptor = {
  path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  version: '5.1.26100.9444',
  edition: 'Desktop',
  nativeArguments: 'Legacy',
}
const modern: PowerShellDescriptor = {
  path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  version: '7.6.5',
  edition: 'Core',
  nativeArguments: 'Windows',
}
const candidates: PowerShellCandidate[] = [
  { path: legacy.path, family: '5.1' },
  { path: modern.path, family: '7' },
]

it('discovers absolute paths case-insensitively without searching the workspace', () => {
  const found = powerShellCandidates({
    Path: '.;relative;C:relative;\\root-relative;"C:\\Program Files\\PowerShell\\7";C:\\tools;C:\\TOOLS',
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows',
  })
  expect(found).toEqual([
    { path: modern.path, family: '7' },
    { path: 'C:\\tools\\pwsh.exe', family: '7' },
    { path: legacy.path, family: '5.1' },
    { path: 'C:\\Program Files\\PowerShell\\7\\powershell.exe', family: '5.1' },
    { path: 'C:\\tools\\powershell.exe', family: '5.1' },
  ])
})
it('auto prefers verified PS7 regardless of candidate order and freezes the result', async () => {
  const probe = vi.fn(async () => modern)
  const selected = await resolvePowerShell('auto', candidates, probe)
  expect(probe).toHaveBeenCalledExactlyOnceWith(modern.path)
  expect(selected).toEqual(modern)
  expect(Object.isFrozen(selected)).toBe(true)
})
it('auto falls back to verified PS5.1 when PS7 cannot be probed', async () => {
  const probe = vi.fn(async (path: string) => {
    if (path === modern.path) throw new Error('not installed')
    return legacy
  })
  expect(await resolvePowerShell('auto', candidates, probe)).toEqual(legacy)
  expect(probe.mock.calls.map(([path]) => path)).toEqual([modern.path, legacy.path])
})
it('an explicit version never falls back to the other family', async () => {
  const probe = vi.fn(async () => {
    throw new Error('sensitive diagnostic')
  })
  await expect(resolvePowerShell('7', candidates, probe)).rejects.toMatchObject({
    code: 'E_POWERSHELL_UNAVAILABLE',
    attempts: [{ path: modern.path, reason: 'probe-failed' }],
  })
  expect(probe).toHaveBeenCalledExactlyOnceWith(modern.path)
})
it('an explicit path is probed once and may return the actual executable path', async () => {
  const path = 'D:\\工具 space%\\chosen.exe'
  const probe = vi.fn(async () => legacy)
  expect(await resolvePowerShell({ path }, candidates, probe)).toEqual(legacy)
  expect(probe).toHaveBeenCalledExactlyOnceWith(path)
})
it.each(['pwsh.exe', 'C:pwsh.exe', '\\pwsh.exe', 'C:\\tool.ps1', 'C:\\bad\0.exe'])(
  'rejects an unusable explicit path before starting it: %s',
  async (path) => {
    const probe = vi.fn(async () => modern)
    await expect(resolvePowerShell({ path }, candidates, probe)).rejects.toMatchObject({
      code: 'E_POWERSHELL_UNAVAILABLE',
    })
    expect(probe).not.toHaveBeenCalled()
  },
)
it('refuses a renamed executable from the wrong version family', async () => {
  await expect(resolvePowerShell('7', candidates, async () => legacy)).rejects.toMatchObject({
    attempts: [{ path: modern.path, reason: 'version-mismatch' }],
  })
})
it.each([{ version: '6.2.7' }, { edition: 'Desktop' }, { nativeArguments: 'unknown' }, { path: 'pwsh.exe' }])(
  'rejects incomplete or inconsistent probe facts: %o',
  async (override) => {
    const probe = async () => ({ ...modern, ...override }) as PowerShellDescriptor
    await expect(resolvePowerShell('7', candidates, probe)).rejects.toMatchObject({
      code: 'E_POWERSHELL_UNAVAILABLE',
    })
  },
)

describe.runIf(process.platform === 'win32')('real Windows PowerShell probes', () => {
  it('reads PS5.1 metadata with the real system executable', async () => {
    const root = process.env.SystemRoot
    if (!root) throw new Error('Windows SystemRoot is missing')
    const path = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    expect(await probePowerShell(path)).toMatchObject({
      path,
      version: expect.stringMatching(/^5\.1\./),
      edition: 'Desktop',
      nativeArguments: 'Legacy',
    })
  })
  it.runIf(Boolean(process.env.AGNES_TEST_PWSH))('reads explicitly supplied PS7 metadata', async () => {
    const path = process.env.AGNES_TEST_PWSH
    if (!path) throw new Error('AGNES_TEST_PWSH is missing')
    expect(await probePowerShell(path)).toMatchObject({
      version: expect.stringMatching(/^7\./),
      edition: 'Core',
      nativeArguments: expect.stringMatching(/^(Legacy|Standard|Windows)$/),
    })
  })
})
