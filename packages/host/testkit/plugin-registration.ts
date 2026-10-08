import type { ToolDef } from '@agnes/extension-api'
import { createExtensionOrder } from '@agnes/host-extensions/ext-host/extension-status-book'
import type { KernelPorts } from '@agnes/host-extensions/ext-host/ports'
import { createRowExtensionHost } from '@agnes/host-extensions/ext-host/row-extension-host'
import type { PluginTestRegistration } from '@agnes/plugin-runtime/testkit'

/** The production row-registration bridge with in-memory downstream ports and no native storage. */
export function createPluginTestRegistration(): PluginTestRegistration {
  const tools = new Map<string, ToolDef>()
  const registrations = new Map<string, Set<string>>()
  const record = (source: string, key: string, cleanup: () => void = () => {}) => {
    const owned = registrations.get(source) ?? new Set<string>()
    if (owned.has(key)) throw new Error(`Duplicate registration: ${key}`)
    registrations.set(source, owned)
    owned.add(key)
    return () => {
      owned.delete(key)
      cleanup()
    }
  }
  const unsupported = () => {
    throw new Error('This test host supports tools and hooks only')
  }
  const ports: KernelPorts = {
    tools: {
      add(def, meta) {
        if (tools.has(def.name)) throw new Error(`Duplicate tool: ${def.name}`)
        tools.set(def.name, def)
        return record(meta.source, `tool:${def.name}`, () => {
          tools.delete(def.name)
        })
      },
    },
    hooks: { on: (event, _handler, meta) => record(meta.source, `hook:${event}`) },
    services: { register: unsupported, registerRow: unsupported },
    projections: { register: unsupported, read: unsupported },
    slots: { register: unsupported },
    resources: { register: unsupported },
    extEvents: { append: unsupported },
    registrations: (source) => [...(registrations.get(source) ?? [])],
  }
  const host = createRowExtensionHost({
    info: { agnesVersion: '0.0.0', apiVersion: '1.4.0', profileName: 'author-test' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    order: createExtensionOrder(),
    describePackage: () => ({ version: '1.0.0' }),
  })
  host.activate({
    ports,
    platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    shutdown: async () => {},
    reservedTool: () => false,
    governance: new Map(),
  })
  return {
    tools,
    install: (root, origins) => host.installRoot(root, origins),
    assertLoaded() {
      const failed = host.statusEntries().find((entry) => !entry.status.loaded || entry.status.error)
      if (failed) throw new Error(failed.status.error?.message ?? 'Plugin did not load')
    },
  }
}
