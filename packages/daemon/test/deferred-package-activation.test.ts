import { describe, expect, it } from 'vitest'
import { deferPackageActivation } from '../src/deferred-package-activation.js'
import type { PackageActivationAdapter } from '../src/packages/index.js'

const input = {
  profile: 'default',
  packageId: 'pkg',
  operationId: 'op',
  operation: 'enable' as const,
  signal: new AbortController().signal,
}

describe('deferPackageActivation', () => {
  it('answers unavailable, and not stopped, until an adapter exists', async () => {
    const deferred = deferPackageActivation(() => undefined)
    expect(await deferred.actual('default', 'pkg')).toEqual({ actual: 'unavailable' })
    expect(await deferred.stopped?.('default', 'pkg')).toBe(false)
    expect((await deferred.reconcile(input)).error?.code).toBe('E_PACKAGE_STATE')
  })

  it('hands every question to the adapter it finds at call time, including whether a package is stopped', async () => {
    let adapter: PackageActivationAdapter | undefined
    const deferred = deferPackageActivation(() => adapter)
    adapter = {
      actual: async () => ({ actual: 'failed' }),
      stopped: async (_profile, packageId) => packageId === 'pkg',
      reconcile: async () => ({ actual: 'running' }),
    }
    expect(await deferred.actual('default', 'pkg')).toEqual({ actual: 'failed' })
    expect(await deferred.stopped?.('default', 'pkg')).toBe(true)
    expect(await deferred.stopped?.('default', 'other')).toBe(false)
    expect((await deferred.reconcile(input)).actual).toBe('running')
  })

  it('forwards removal preparation before PackageManager checks active pins', async () => {
    let adapter: PackageActivationAdapter | undefined
    const deferred = deferPackageActivation(() => adapter)
    const prepared: string[] = []
    adapter = {
      actual: async () => ({ actual: 'not-running' }),
      stopped: async () => true,
      prepareRemoval: async (profileName, packageId) => {
        prepared.push(`${profileName}/${packageId}`)
      },
      reconcile: async () => ({ actual: 'not-running' }),
    }
    await deferred.prepareRemoval?.('default', 'pkg')
    expect(prepared).toEqual(['default/pkg'])
  })
})
