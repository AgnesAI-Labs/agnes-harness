import type { PackageAdminService } from '@agnes/daemon-admin/packages/index'
import { expect, it } from 'vitest'
import { packageAdminHandoff } from '../src/supervisor/embedded-package-admin.js'

function fixture(label: string, released: string[]) {
  const listeners = new Set<Parameters<PackageAdminService['subscribe']>[0]>()
  const service: PackageAdminService = {
    call: async () => label,
    recover: async () => undefined,
    rebuildClientModules: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeClientModules: () => () => {},
    closeClientModules: () => {
      released.push(label)
    },
  }
  return {
    service,
    emit(operationId: string) {
      // The handoff forwards opaque operation events; their domain validation belongs to Service.
      for (const listener of listeners) listener({ operationId } as never)
    },
  }
}

it('keeps captured calls and subscribers on one entry across catalog-to-runtime handoff', async () => {
  const released: string[] = []
  const catalog = fixture('catalog', released)
  const runtime = fixture('runtime', released)
  const owner = packageAdminHandoff(catalog.service)
  const call = owner.service.call
  const seen: string[] = []
  owner.service.subscribe((event) => {
    seen.push(event.operationId)
  })
  expect(await call('_agnes/v1/packages.list', {}, undefined)).toBe('catalog')
  catalog.emit('catalog')
  owner.initialize(runtime.service)
  expect(await call('_agnes/v1/packages.list', {}, undefined)).toBe('runtime')
  catalog.emit('retired')
  runtime.emit('ready')
  expect(seen).toEqual(['catalog', 'ready'])
  expect(() => owner.initialize(runtime.service)).toThrow('E_PACKAGE_STATE')
  owner.service.closeClientModules()
  owner.close()
  owner.close()
  runtime.emit('closed')
  await expect(call('_agnes/v1/packages.list', {}, undefined)).rejects.toThrow('E_PACKAGE_STATE')
  expect(seen).toEqual(['catalog', 'ready'])
  expect(released).toEqual(['catalog', 'runtime'])
})

it('closes a catalog-only starter and refuses later initialization', () => {
  const released: string[] = []
  const catalog = fixture('catalog', released)
  const owner = packageAdminHandoff(catalog.service)
  owner.close()
  expect(() => owner.initialize(catalog.service)).toThrow('E_PACKAGE_STATE')
  expect(released).toEqual(['catalog'])
})
