import { describe, expect, it, vi } from 'vitest'
import { createPackageAdminClient, type PackageAdminRpc } from '../src/package-admin.js'

describe('createPackageAdminClient pins', () => {
  it('inspect calls packages.pins.inspect with the given params', async () => {
    const call = vi.fn(async () => ({ orphans: [] }))
    const client = createPackageAdminClient({ call } as unknown as PackageAdminRpc)
    const result = await client.pins.inspect({ profile: 'local-dev' })
    expect(call).toHaveBeenCalledWith('_agnes/v1/packages.pins.inspect', { profile: 'local-dev' })
    expect(result).toEqual({ orphans: [] })
  })

  it('release calls packages.pins.release with the given params', async () => {
    const call = vi.fn(async () => ({ results: [{ pinId: 'p1', outcome: 'released' }] }))
    const client = createPackageAdminClient({ call } as unknown as PackageAdminRpc)
    const params = { profile: 'local-dev', clientId: 'c1', commandId: 'cmd1', pinIds: ['p1'] }
    const result = await client.pins.release(params)
    expect(call).toHaveBeenCalledWith('_agnes/v1/packages.pins.release', params)
    expect(result).toEqual({ results: [{ pinId: 'p1', outcome: 'released' }] })
  })
})

describe('createPackageAdminClient plugin tree', () => {
  it('forwards tree get/list/apply/rollback to plugins.tree methods', async () => {
    const call = vi.fn(async () => ({ desired: null }))
    const client = createPackageAdminClient({ call } as unknown as PackageAdminRpc)
    await client.tree.get({ profile: 'local-dev' })
    await client.tree.list({ profile: 'local-dev' })
    await client.tree.rollback({ profile: 'local-dev', clientId: 'c1', commandId: 'cmd1' })
    expect(call).toHaveBeenNthCalledWith(1, '_agnes/v1/plugins.tree.get', { profile: 'local-dev' })
    expect(call).toHaveBeenNthCalledWith(2, '_agnes/v1/plugins.tree.list', { profile: 'local-dev' })
    expect(call).toHaveBeenNthCalledWith(3, '_agnes/v1/plugins.tree.rollback', {
      profile: 'local-dev',
      clientId: 'c1',
      commandId: 'cmd1',
    })
  })
})

describe('createPackageAdminClient trustWorkspace', () => {
  it('trustWorkspace calls packages.trustWorkspace with the given params', async () => {
    const call = vi.fn(async () => ({ hash: 'sha256-abc' }))
    const client = createPackageAdminClient({ call } as unknown as PackageAdminRpc)
    const params = { profile: 'enterprise', clientId: 'c1', commandId: 'cmd1', deployDir: '/deploy/xinwei' }
    const result = await client.trustWorkspace(params)
    expect(call).toHaveBeenCalledWith('_agnes/v1/packages.trustWorkspace', params)
    expect(result).toEqual({ hash: 'sha256-abc' })
  })
})

describe('createPackageAdminClient untrust', () => {
  it('untrust calls packages.untrust with the given concurrency guards', async () => {
    const call = vi.fn(async () => ({ operationId: 'op-1', profile: 'local-dev' }))
    const client = createPackageAdminClient({ call } as unknown as PackageAdminRpc)
    const params = {
      profile: 'local-dev',
      clientId: 'c1',
      commandId: 'cmd1',
      id: 'example',
      expectedIntegrity: 'sha256-abc',
      capabilityHash: 'b'.repeat(64),
    }
    await client.untrust(params)
    expect(call).toHaveBeenCalledWith('_agnes/v1/packages.untrust', params)
  })
})
