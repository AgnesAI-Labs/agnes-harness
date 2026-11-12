import { expect, it } from 'vitest'
import { rowApiFixture } from './fixtures/row-api.js'

it('exposes sideCall to a granted in-process plugin that injects it', () => {
  const f = rowApiFixture({ sideCall: true }, { sideCallDeclared: true })
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }))
  expect(f.registrations[0]?.meta).toMatchObject({ sideCall: true, pluginRowId: 'ext:fixture/main' })
})
it('hides sideCall without the grant', () => {
  const f = rowApiFixture({}, { sideCallDeclared: true })
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }))
  expect(f.registrations[0]?.meta.sideCall).toBeUndefined()
})
it('hides sideCall when the plugin does not inject it', () => {
  const f = rowApiFixture({ sideCall: true })
  f.api.registerHook('turn_stopping', () => ({ action: 'stop' }))
  expect(f.registrations[0]?.meta.sideCall).toBeUndefined()
})

it.each(['preferred', 'required'] as const)('hides sideCall in isolated mode (%s)', async (mode) => {
  const { createBuiltinRowHost } = await import('../src/ext-host/builtin-row-host.js')
  const { ExtensionOwners } = await import('../src/ext-host/extension-owners.js')
  const { createExtensionOrder } = await import('../src/ext-host/extension-status-book.js')
  const f = rowApiFixture()
  const host = createBuiltinRowHost({
    owners: new ExtensionOwners(),
    order: createExtensionOrder(),
    ports: { ...f.ports, registrations: () => [] },
    platform: f.context.platform,
    shutdown: async () => {},
    loader: { import: async () => ({}) },
    ceiling: ['hooks'],
    info: f.api.ctx.info,
    log: f.context.log,
    audit() {},
  })
  const loaded = await host.load({
    rowId: 'ext:fixture/main',
    spec: {
      id: 'fixture/main',
      package: '@fixture/plugin',
      packageVersion: '1.0.0',
      dir: '/nowhere',
      trust: 'builtin',
      enabled: true,
      integrity: 'sha256-fixture',
      revision: 'one',
    },
    embedded: {
      id: 'fixture/main',
      version: '1.0.0',
      apiRange: '*',
      entry: './index.js',
      capabilities: { hooks: ['turn_stopping'] },
    },
    declaration: {
      id: 'ext:fixture/main',
      export: 'default',
      inject: ['hooks', 'sideCall'],
      runtime: 'in-process',
    },
    hostGrants: () => ({ sideCall: true }),
    factory: () => {
      host.setIsolation('fixture/main', { mode, backend: 'in-process', fallback: true })
      return (api) => {
        api.registerHook('turn_stopping', () => ({ action: 'stop' }))
      }
    },
  })
  try {
    expect(loaded.loaded).toBe(true)
    expect(f.registrations).toHaveLength(1)
    expect(f.registrations[0]?.meta.sideCall).toBeUndefined()
  } finally {
    await loaded.release()
  }
})
