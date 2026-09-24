import { describe, expect, it, vi } from 'vitest'
import lockValue from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import { inspectComputerUseDriverLock } from '../../src/computer-use/driver-lock.js'
import { verifyWindowsComputerUseDriver } from '../../src/computer-use/windows-driver-verifier.js'

const files = [
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'cua_driver_sdk.dll',
  'cua-cursor-theme.exe',
  'cua-driver-uia.exe',
  'cua-driver.exe',
]
const inspected = inspectComputerUseDriverLock(lockValue)
if (!inspected.ok) throw new Error('fixture lock is invalid')
const lock = inspected.lock
const evidence = lock.artifacts.find((artifact) => artifact.platform === 'win32')?.signatureEvidence
if (evidence?.status !== 'verified' || evidence.kind !== 'windows-authenticode')
  throw new Error('fixture lock lacks Windows evidence')
const windowsEvidence = evidence

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    // Fixed to the fixture's verified artifact so the suite does not depend on the architecture of
    // the machine running it; the verifier otherwise falls back to the real host architecture.
    architecture: 'x86_64',
    listFiles: vi.fn(async () => files),
    inspectExecutable: vi.fn((path: string) => ({
      executablePath: path,
      publisherSha256: 'f'.repeat(64),
      leafThumbprint: windowsEvidence.leafThumbprint,
      publisher: windowsEvidence.publisher,
    })),
    readVersion: vi.fn(async () => 'cua-driver 0.28.1'),
    ...overrides,
  }
}

describe('locked Windows Computer Use driver verification', () => {
  it('checks the exact file set, every loadable signer and locked version', async () => {
    const deps = dependencies()
    await expect(verifyWindowsComputerUseDriver('C:\\driver', lock, deps)).resolves.toMatchObject({
      version: '0.28.1',
      publisher: windowsEvidence.publisher,
      leafThumbprint: windowsEvidence.leafThumbprint,
    })
    expect(deps.inspectExecutable).toHaveBeenCalledTimes(5)
    expect(deps.readVersion).toHaveBeenCalledOnce()
  })

  it('returns the canonical install path when Windows reports an equivalent namespaced path', async () => {
    const deps = dependencies({
      inspectExecutable: vi.fn((path: string) => ({
        executablePath: `\\\\?\\${path}`,
        publisherSha256: 'f'.repeat(64),
        leafThumbprint: windowsEvidence.leafThumbprint,
        publisher: windowsEvidence.publisher,
      })),
    })
    await expect(verifyWindowsComputerUseDriver('C:\\driver', lock, deps)).resolves.toMatchObject({
      executablePath: 'C:\\driver\\cua-driver.exe',
    })
  })

  it('rejects an extra file before inspecting or launching anything', async () => {
    const deps = dependencies({ listFiles: vi.fn(async () => [...files, 'payload.dll']) })
    await expect(verifyWindowsComputerUseDriver('C:\\driver', lock, deps)).rejects.toThrow(
      'contents do not match',
    )
    expect(deps.inspectExecutable).not.toHaveBeenCalled()
    expect(deps.readVersion).not.toHaveBeenCalled()
  })

  it('rejects one mismatched companion signer and never launches the driver', async () => {
    const deps = dependencies({
      inspectExecutable: vi.fn((path: string) => ({
        executablePath: path,
        publisherSha256: 'e'.repeat(64),
        leafThumbprint: path.endsWith('cua_driver_sdk.dll') ? '0'.repeat(40) : windowsEvidence.leafThumbprint,
        publisher: windowsEvidence.publisher,
      })),
    })
    await expect(verifyWindowsComputerUseDriver('C:\\driver', lock, deps)).rejects.toThrow('signer mismatch')
    expect(deps.readVersion).not.toHaveBeenCalled()
  })

  it('rejects version drift after signature verification', async () => {
    const deps = dependencies({ readVersion: vi.fn(async () => 'cua-driver 0.29.0') })
    await expect(verifyWindowsComputerUseDriver('C:\\driver', lock, deps)).rejects.toThrow(
      'version does not match',
    )
  })
})
