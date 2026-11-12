import type { ExtensionManifest, HookContext, ToolDef } from '@agnes/extension-api'
import type { HostCapabilityGrant } from '@agnes/package-manager'
import { leaseFor } from '../../src/ext-host/lease.js'
import type { KernelPorts, RegMeta } from '../../src/ext-host/ports.js'
import { buildRowExtensionAPI, type RowExtensionApiInput } from '../../src/ext-host/row-extension-api.js'

export function rowApiFixture(grant: HostCapabilityGrant = {}, extra: Partial<RowExtensionApiInput> = {}) {
  const registrations: {
    event: string
    handler: (payload: unknown, context: HookContext) => unknown
    meta: RegMeta
  }[] = []
  const tools: ToolDef[] = []
  const diagnostics: unknown[] = []
  const controller = new AbortController()
  const manifest: ExtensionManifest = {
    id: 'plugin/fixture',
    version: '1.0.0',
    apiRange: '*',
    entry: './index.js',
    capabilities: { tools: { prefix: '' }, events: true },
  }
  const lease = leaseFor(manifest, { now: 0, ttlMs: 100000, clock: () => 0 })
  const log = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => {
      diagnostics.push(args)
    },
    error() {},
  }
  const ports = {
    tools: {
      add: (def: ToolDef) => {
        tools.push(def)
        return () => {}
      },
    },
    hooks: {
      on: (event: string, handler: any, meta: RegMeta) => {
        registrations.push({ event, handler, meta })
        return () => {}
      },
    },
    projections: {
      async read(_key: string, _meta: RegMeta, before: () => void) {
        before()
        return { asOfSeq: 1, unit: { state: { count: 1 }, stateVersion: 1 } }
      },
    },
  } as unknown as KernelPorts
  const api = buildRowExtensionAPI({
    source: manifest.id,
    rowId: 'ext:fixture/main',
    version: '1.0.0',
    packageIdentity: 'fixture',
    packageVersion: '1.0.0',
    lease,
    signal: controller.signal,
    hostGrants: () => grant,
    attach: (_kind, _name, create) => create(ports),
    ports: () => ports,
    reservedTool: () => false,
    info: { agnesVersion: '0.1.0', apiVersion: '5.15.0', profileName: 'test' },
    platform: () => ({
      shell: 'posix',
      fs: { caseSensitive: true, pathSep: '/' },
      terminal: { color: false },
    }),
    log,
    ...extra,
  })
  const context: HookContext = {
    session: { key: 's', lane: 'main', workspaceRoot: '/work' },
    projections: {
      readOwn: async () => ({
        status: 'unavailable',
        name: 'x',
        error: { code: 'E_PROJECTION_STATE', safeMessage: 'unavailable' },
      }),
    },
    platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    lease: lease.view(),
    signal: new AbortController().signal,
    replayed: false,
    log,
  }
  return { api, registrations, tools, diagnostics, lease, controller, context, ports }
}
