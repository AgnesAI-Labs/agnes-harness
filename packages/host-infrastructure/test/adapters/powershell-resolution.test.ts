import { beforeEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  execute: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: probe.execute }),
}))
vi.mock('node:fs/promises', () => ({ realpath: probe.realpath, stat: probe.stat }))

const path = 'C:\\tools\\pwsh.exe'
let revision = 1n
let version = '7.5.0'
beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  revision = 1n
  version = '7.5.0'
  probe.realpath.mockImplementation(async (file: string) => file)
  probe.stat.mockImplementation(async () => ({
    isFile: () => true,
    dev: 1n,
    ino: 1n,
    size: 100n,
    mtimeNs: revision,
    ctimeNs: revision,
  }))
  probe.execute.mockImplementation(async (file: string) => ({
    stdout: JSON.stringify({
      path: file,
      version,
      edition: 'Core',
      nativeArguments: 'Windows',
      codePage: 65001,
    }),
  }))
})

it('reuses discovery for an unchanged shell, but re-probes changed files and explicit diagnostic requests', async () => {
  const { resolveConfiguredPowerShell, probePowerShell } = await import('../../src/adapters/powershell.js')
  const env = { AGNES_POWERSHELL: path }
  expect((await resolveConfiguredPowerShell(env)).version).toBe('7.5.0')
  expect((await resolveConfiguredPowerShell({ ...env })).version).toBe('7.5.0')
  expect(probe.execute).toHaveBeenCalledTimes(1)
  revision++
  version = '7.6.0'
  expect((await resolveConfiguredPowerShell(env)).version).toBe('7.6.0')
  expect(probe.execute).toHaveBeenCalledTimes(2)
  version = '7.6.1'
  expect((await probePowerShell(path)).version).toBe('7.6.1')
  probe.stat.mockRejectedValueOnce(new Error('alias metadata unavailable'))
  expect((await resolveConfiguredPowerShell(env)).version).toBe('7.6.1')
})

it('reselects candidates, expires discovery, and refuses missing files even after a successful probe', async () => {
  const { resolveConfiguredPowerShell } = await import('../../src/adapters/powershell.js')
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  await resolveConfiguredPowerShell({ PATH: 'C:\\tools' })
  const other = await resolveConfiguredPowerShell({ PATH: 'D:\\other' })
  expect(other.path).toBe('D:\\other\\pwsh.exe')
  now.mockReturnValue(32_000)
  version = '7.6.0'
  expect((await resolveConfiguredPowerShell({ PATH: 'C:\\tools' })).version).toBe('7.6.0')
  probe.realpath.mockRejectedValue(new Error('removed'))
  probe.execute.mockRejectedValueOnce(new Error('executable missing'))
  await expect(resolveConfiguredPowerShell({ AGNES_POWERSHELL: path })).rejects.toMatchObject({
    code: 'E_POWERSHELL_UNAVAILABLE',
  })
})

it('does not retain failed probes or reuse the old target after a link changes', async () => {
  const { resolveConfiguredPowerShell } = await import('../../src/adapters/powershell.js')
  const env = { AGNES_POWERSHELL: path }
  probe.execute.mockRejectedValueOnce(new Error('startup failed'))
  await expect(resolveConfiguredPowerShell(env)).rejects.toMatchObject({ code: 'E_POWERSHELL_UNAVAILABLE' })
  await expect(resolveConfiguredPowerShell(env)).resolves.toMatchObject({ version: '7.5.0' })
  probe.realpath.mockResolvedValue('D:\\replacement\\pwsh.exe')
  version = '7.6.0'
  await expect(resolveConfiguredPowerShell(env)).resolves.toMatchObject({ version: '7.6.0' })
})
