import { fileURLToPath } from 'node:url'
import type {
  HookContext,
  HookHandler,
  PluginContextFacets,
  ServiceContext,
  ServiceDef,
  ToolDef,
} from '@agnes/extension-api'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { createExtensionOrder } from '@agnes/host-extensions/ext-host/extension-status-book'
import type { KernelPorts } from '@agnes/host-extensions/ext-host/ports'
import { createRowExtensionHost } from '@agnes/host-extensions/ext-host/row-extension-host'
import type { PluginTestRegistration } from '@agnes/plugin-runtime/testkit'
import { expect, it } from 'vitest'

type KernelProjection = Parameters<KernelPorts['projections']['register']>[0]

it('mounts the installed context observer on the production registration bridge without native or model access', async () => {
  const url = new URL('../../package-manager/bundled-plugins/context-doctor/index.mjs', import.meta.url)
  const module: { main: { apply(ctx: PluginContextFacets): () => void } } = await import(url.href)
  const hooks = new Set<string>()
  let contextHook: HookHandler<'context'> | undefined
  let service: ServiceDef | undefined
  let projection: KernelProjection | undefined
  const events: Parameters<KernelProjection['apply']>[1][] = []
  const tools = new Map<string, ToolDef>()
  const unavailable = (): never => {
    throw new Error('No additional test authority')
  }
  const ports: KernelPorts = {
    tools: { add: unavailable },
    hooks: {
      on(event, handler) {
        hooks.add(event)
        if (event === 'context') contextHook = handler as unknown as HookHandler<'context'>
        return () => {
          hooks.delete(event)
        }
      },
    },
    services: {
      register: unavailable,
      registerRow(def) {
        service = def
        return () => {
          service = undefined
        }
      },
    },
    projections: {
      register(def) {
        projection = def as unknown as KernelProjection
        return () => {
          projection = undefined
        }
      },
      read: unavailable,
    },
    slots: { register: unavailable },
    resources: { register: unavailable },
    extEvents: {
      async append(type, data, meta) {
        const seq = events.length + 1
        events.push({
          type,
          data,
          seq,
          origin: `ext:${meta.source}`,
          ts: '2026-01-01T00:00:00.000Z',
        } as Parameters<KernelProjection['apply']>[1])
        return seq
      },
    },
    registrations: () => [],
  }
  const bridge = createRowExtensionHost({
    info: { agnesVersion: '0.0.0', apiVersion: '4.0.0', profileName: 'synthetic' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    order: createExtensionOrder(),
    describePackage: () => ({ version: '0.1.0' }),
  })
  bridge.activate({
    ports,
    platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
    shutdown: async () => {},
    reservedTool: () => false,
    governance: new Map(),
  })
  const registration: PluginTestRegistration = {
    tools,
    install: (root, origins) => bridge.installRoot(root, origins),
    assertLoaded() {
      const failure = bridge.statusEntries().find((row) => !row.status.loaded || row.status.error)
      if (failure) throw new Error(failure.status.error?.message ?? 'Plugin failed to mount')
    },
  }
  const host = await createPluginTestHost(module.main, {
    packageDir: fileURLToPath(
      new URL('../../package-manager/bundled-plugins/context-doctor', import.meta.url),
    ),
    registration,
  })
  const ctx = {
    session: { key: 'synthetic', lane: 'main', workspaceRoot: '/synthetic' },
    replayed: false,
    signal: new AbortController().signal,
  } as HookContext
  try {
    expect(tools.size).toBe(0)
    const observe = contextHook
    const folded = projection
    const query = service
    if (!observe || !folded || !query) throw new Error('Missing public plugin registration')
    expect(
      await observe(
        {
          sections: [{ id: 'agents-md', order: 1, content: 'private fixture 中文' }],
          surfaceDigest: { nodes: 0, tokensEstimate: 0 },
          getSurface: () => [],
        },
        ctx,
      ),
    ).toEqual({ refreshOnRequest: true })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toMatch(/^x\/plugin\/[a-f0-9]+\/snapshot$/)
    expect(JSON.stringify(events.map((event) => event.data))).not.toContain('private fixture')
    const event = events[0]
    if (!event) throw new Error('Missing committed metadata')
    expect(folded.apply(folded.init(), event)).toMatchObject({
      context: { groups: { rules: { characters: 18 } } },
    })
    expect(await query.handler({}, ctx as unknown as ServiceContext)).toMatchObject({
      version: 1,
      status: 'live',
    })
  } finally {
    await host.dispose()
  }
  expect(hooks.size).toBe(0)
  expect(service).toBeUndefined()
  expect(projection).toBeUndefined()
})
