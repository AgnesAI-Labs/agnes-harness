import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@agnes/cordis'
import {
  type ExtensionManifest,
  type PluginContextFacets,
  type SchedulingService,
  type ServicePorts,
  schedulingKind,
  schedulingServiceCapabilities,
  type ToolDef,
} from '@agnes/extension-api'
import { buildExtensionAPI } from '@agnes/host-extensions/ext-host/api-proxy'
import { DisposerBag } from '@agnes/host-extensions/ext-host/disposers'
import { leaseFor } from '@agnes/host-extensions/ext-host/lease'
import type { KernelPorts } from '@agnes/host-extensions/ext-host/ports'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { createExtensionServiceHost, type ServiceAdmission } from '../src/runtime/services/author-port.js'
import { installSchedulingService } from '../src/runtime/services/scheduling.js'
import { createTestHost, runOnce } from '../testkit/index.js'

it('lets a declared third-party tool bind the fixed daemon service and closes it on revocation', async () => {
  const root = new Context()
  let active = true
  let saved: SchedulingService | undefined
  const admission = {
    token: {},
    owner: 'vendor/schedule',
    active: true,
    signal: new AbortController().signal,
    session: { key: 'session', lane: 'main', workspaceRoot: '/work', closingOrClosed: false },
  } as ServiceAdmission
  const host = createExtensionServiceHost({
    providers: () => root.providers,
    readAdmission: () => (active ? admission : undefined),
  })
  installSchedulingService(host, root, undefined, async (session, operation, input) => {
    expect(session).toEqual({ key: 'session', lane: 'main', workspaceRoot: '/work' })
    expect(operation).toBe('list')
    expect(input).toEqual({})
    return { schedules: [] }
  })
  const manifest: ExtensionManifest = {
    id: 'vendor/schedule',
    version: '1.0.0',
    apiRange: '^5.0.0',
    entry: './index.ts',
    lease: { budget: 100 },
    capabilities: {
      tools: { prefix: 'vendor_', names: ['vendor_list'] },
      services: schedulingServiceCapabilities,
    },
  }
  let tool: ToolDef | undefined
  const makeApi = (m: ExtensionManifest, granted = m) => {
    const lease = leaseFor(granted, { now: 1000, ttlMs: 1000, clock: () => 1000 })
    const api = buildExtensionAPI({
      manifest: m,
      packageIdentity: '@third-party/scheduler',
      packageVersion: '1.0.0',
      trust: 'trusted',
      lease,
      bag: new DisposerBag(),
      ports: {
        serviceProviders: host.ports,
        tools: {
          add(def: ToolDef) {
            tool = def
            return () => {}
          },
        },
      } as unknown as KernelPorts,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      info: { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' },
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
      signal: new AbortController().signal,
      isRegistering: () => true,
    })
    return { api, lease }
  }
  try {
    const raw = root.providers.resolve(schedulingKind, 'agnes/scheduling')
    expect(() =>
      raw.open({
        binding: { session: { key: 'forged', workspaceRoot: '/work' } },
      } as unknown as ServicePorts),
    ).toThrow('service binding is closed')
    const denied = makeApi({
      ...manifest,
      capabilities: { tools: { prefix: 'vendor_', names: ['vendor_list'] } },
    })
    expect(() => denied.api.providers.bindOwn(schedulingKind)).toThrow('service not declared or granted')
    const noLease = makeApi(manifest, {
      ...manifest,
      capabilities: { tools: { prefix: 'vendor_', names: ['vendor_list'] } },
    })
    expect(() => noLease.api.providers.bindOwn(schedulingKind)).toThrow('service not declared or granted')
    const mislabeled = makeApi({
      ...manifest,
      capabilities: {
        ...manifest.capabilities,
        services: schedulingServiceCapabilities.map((cap) => ({ ...cap, kind: 'query', scope: 'session' })),
      },
    })
    expect(() => mislabeled.api.providers.bindOwn(schedulingKind)).toThrow('service not declared or granted')
    const allowed = makeApi(manifest)
    allowed.api.registerTool({
      name: 'vendor_list',
      description: 'List schedules',
      parameters: Type.Object({}, { additionalProperties: false }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        costHint: {},
        deferLoading: 'auto',
        requiresApproval: 'never',
        replay: 'safe',
      },
      async execute() {
        saved = await allowed.api.providers.bindOwn(schedulingKind)
        return { content: [{ type: 'text', text: JSON.stringify(await saved.list()) }] }
      },
    })
    expect(await tool?.execute({}, {} as never)).toEqual({
      content: [{ type: 'text', text: '{"schedules":[]}' }],
    })
    expect(() =>
      allowed.api.providers.register(schedulingKind, {
        id: 'replacement',
        version: '1.0.0',
        open: () => ({}) as SchedulingService,
      }),
    ).toThrow()
    active = false
    await expect(Promise.resolve().then(() => saved?.list())).rejects.toMatchObject({
      code: 'E_PROVIDER_UNAVAILABLE',
    })
    active = true
    allowed.lease.revoke('test')
    await expect(Promise.resolve().then(() => saved?.list())).rejects.toMatchObject({
      code: 'E_PROVIDER_UNAVAILABLE',
    })
    expect(() => allowed.api.providers.bindOwn(schedulingKind)).toThrow()
  } finally {
    await root.fiber.dispose()
  }
})

it('refuses scheduling when the daemon bridge is unavailable', async () => {
  const root = new Context()
  const host = createExtensionServiceHost({ providers: () => root.providers })
  installSchedulingService(host, root, undefined, undefined)
  try {
    await expect(
      host.bindHost(schedulingKind, {
        owner: 'vendor/schedule',
        packageId: '@vendor/package',
        signal: new AbortController().signal,
        session: { key: 'session', lane: 'main', workspaceRoot: '/work' },
        live: () => ({ owner: 'vendor/schedule', active: true }),
      }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER_UNAVAILABLE' })
  } finally {
    await root.fiber.dispose()
  }
})

it.each([true, false])(
  'admits a real installed third-party tool only with its service declarations (%s)',
  async (granted) => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-scheduling-plugin-'))
    const pkg = join(dir, 'package')
    mkdirSync(pkg)
    const packageId = '@vendor/scheduler'
    const snapshotId = `sha256-${'9'.repeat(64)}`
    const rowId = 'ext:vendor/scheduler'
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: packageId,
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
        agnes: {
          plugins: [
            {
              id: rowId,
              export: 'main',
              apiRange: '^5.0.0',
              inject: ['tools', 'providers'],
              capabilities: {
                tools: { prefix: 'vendor_', names: ['vendor_list'] },
                ...(granted ? { services: schedulingServiceCapabilities } : {}),
              },
            },
          ],
        },
      }),
    )
    writeFileSync(join(pkg, 'index.mjs'), 'export const main = {}')
    const source: RuntimePluginSnapshot = {
      snapshot: {
        snapshotId,
        profile: 'local-dev',
        packageId,
        version: '1.0.0',
        integrity: snapshotId,
        treeIntegrity: hashDirectory(pkg, { exclude: [] }),
        capabilityHash: 'synthetic',
        directory: pkg,
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
    const received: string[] = []
    const results: string[] = []
    const bypasses: string[] = []
    const { host } = await createTestHost({
      dataDir: dir,
      script: [
        [
          {
            type: 'toolcall_end',
            call: { toolUseId: '', name: 'vendor_list', args: {}, ordinal: 0 },
            via: 'native',
          },
          { type: 'done', reason: 'toolUse' },
        ],
        [{ type: 'done', reason: 'stop' }],
      ],
      runtimePluginCatalogue: [source],
      scheduling: async (session, operation) => {
        received.push(`${session.key}:${operation}`)
        return { schedules: [] }
      },
      extensionLoader: {
        async import() {
          return {
            main: {
              inject: ['tools', 'providers'],
              apply(ctx: PluginContextFacets) {
                return ctx.tools.register({
                  name: 'vendor_list',
                  description: 'List schedules',
                  parameters: Type.Object({}, { additionalProperties: false }),
                  meta: {
                    isReadOnly: true,
                    isDestructive: false,
                    isConcurrencySafe: true,
                    isOpenWorld: false,
                    replay: 'safe',
                    requiresApproval: 'never',
                    deferLoading: false,
                    costHint: {},
                  },
                  async execute() {
                    try {
                      const raw = ctx.providers.resolve(schedulingKind, 'agnes/scheduling')
                      try {
                        await raw.open({
                          binding: { session: { key: 'forged', workspaceRoot: dir } },
                        } as unknown as ServicePorts)
                      } catch (error) {
                        bypasses.push((error as Error).message)
                      }
                      const service = await ctx.providers.bindOwn(schedulingKind)
                      results.push(JSON.stringify(await service.list()))
                    } catch (error) {
                      results.push((error as Error).message)
                    }
                    return { content: [{ type: 'text', text: results.at(-1) ?? '' }] }
                  },
                })
              },
            },
          }
        },
      },
    })
    try {
      await host.applyRuntimeTarget(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: rowId,
              plugin: `${packageId}@${snapshotId}/main`,
              snapshotDigest: snapshotId,
              exportName: 'main',
              entryRevision: snapshotId,
              extrasRevision: 'none',
              mountRevision: 'scheduling:v1',
              inject: ['tools', 'providers'],
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '0'.repeat(64),
        }),
      )
      const turn = await runOnce(host, { prompt: 'List schedules', cwd: dir })
      expect(turn.toolCalls).toContain('vendor_list')
      expect(bypasses).toEqual([expect.stringContaining('service binding is closed')])
      if (granted) {
        expect(received).toHaveLength(1)
        expect(received[0]).toMatch(/:list$/)
        expect(results).toEqual(['{"schedules":[]}'])
      } else {
        expect(received).toEqual([])
        expect(results[0]).toContain('service not declared or granted')
      }
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
