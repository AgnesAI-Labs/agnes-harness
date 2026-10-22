import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { privateArtifactDeleteAvailable } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectComputerUseArtifacts, mountComputerUse } from '../../src/runtime/computer-use/index.js'
import { computerUsePlatformAdmitted } from '../../src/runtime/computer-use/runtime.js'
import { Rollback } from '../../src/runtime/lifecycle/lifecycle.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-cu-host-'))
  dirs.push(dir)
  return dir
}
const platform = (os: string, arch = 'arm64') => ({ os, snapshot: () => ({ arch }) })
const profile = (enabled: boolean) =>
  ({
    hash: 'h',
    computerUse: {
      enabled,
      appAccess: 'any',
      appAllowlist: [],
      retention: { maxRecentPerSession: 1 },
      capture: { maxImageDimension: 1, maxBytesPerImage: 1, maxCapturesPerHour: 1 },
    },
  }) as unknown as Pick<ResolvedProfile, 'computerUse' | 'hash'>
const log = { debug() {}, info() {}, warn() {}, error() {} }
const inspect = (dir: string, enabled: boolean, os = process.platform) =>
  inspectComputerUseArtifacts({
    profile: profile(enabled),
    dataDir: dir,
    platform: platform(os),
    nativePlatform: process.platform,
    clock: () => 0,
    log,
  })

describe('Computer Use artifact retention', () => {
  it('keeps shared CAS writes private independently of screenshot capture', () => {
    const retention = inspect(dataDir(), false)
    expect(retention.required).toBe(false)
    expect(retention.metadataPresent).toBe(false)
    expect('privateArtifactStore' in retention.contextFor({ privateArtifactStore: true })).toBe(
      privateArtifactDeleteAvailable(),
    )
  })

  it('keeps the writer and collector once screenshot metadata exists, even when disabled', () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'artifacts', 'computer-use-meta'), { recursive: true })
    const retention = inspect(dir, false)
    expect(retention.required).toBe(true)
    expect(retention.metadataPresent).toBe(true)
  })

  it('hands the private artifact store only to the Host-granted artifacts seam', () => {
    const retention = inspect(dataDir(), true)
    expect(retention.contextFor({})).toEqual({})
    expect(retention.contextFor({ computerUse: true })).toEqual({})
  })

  it('never retains for a platform other than the one the process runs on', () => {
    const retention = inspect(dataDir(), true, process.platform === 'linux' ? 'darwin' : 'linux')
    expect(retention.contextFor({ privateArtifactStore: true })).toEqual({})
    expect(retention.startCollector()).toBeUndefined()
  })
})

describe('Computer Use mount', () => {
  const mount = (enabled: boolean, os: string, arch?: string) => {
    const dir = dataDir()
    const rollback = new Rollback()
    const host = mountComputerUse({
      profile: profile(enabled),
      dataDir: dir,
      platform: platform(os, arch),
      retention: inspect(dir, enabled),
      artifacts: { put: () => Promise.reject(new Error('unused')) } as never,
      rollback,
    })
    return { host, rollback }
  }

  it('offers no backend and no dispatch port when the profile disables it', async () => {
    const { host, rollback } = mount(false, process.platform)
    expect(host.backend).toBeUndefined()
    expect(host.hostToolDispatch).toBeUndefined()
    expect(host.extensionContext({ computerUse: true })).toEqual({})
    expect(host.status.status()).toEqual({ availability: expect.anything() })
    await rollback.unwind()
  })

  it('reports an unadmitted architecture as unsupported instead of failing the assembly', async () => {
    const { host, rollback } = mount(true, process.platform, 'ia32')
    expect(computerUsePlatformAdmitted(platform(process.platform, 'ia32'))).toBe(false)
    expect(host.backend).toBeDefined()
    expect(host.status.status()).toEqual({ availability: 'platform-unsupported' })
    await rollback.unwind()
  })

  it('registers the collector and runtime teardown with the rollback stack', async () => {
    const { rollback } = mount(false, process.platform)
    expect(await rollback.unwind()).toEqual([])
  })
})
