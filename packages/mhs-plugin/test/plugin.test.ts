import { readFileSync } from 'node:fs'
import { checkToolDef, managedServiceCapabilities, type ToolContext } from '@agnes/extension-api'
import { Hub, North } from '@agnes/mhs-hub'
import { describe, expect, it, vi } from 'vitest'
import { attach, authority, invocation, MemoryStore } from '../../mhs-hub/test/fixtures.js'
import {
  createMhsNativeProfileAdapter,
  createMhsTools,
  MHS_HUB_CHECK_SCHEMA,
  MHS_HUB_CONFIG_SCHEMA,
  mhsServices,
  mhsStreams,
  registerMhsTools,
  startMhsHub,
} from '../src/index.js'

describe('MHS author adapters', () => {
  it('registers seven valid tools, keeps writes approved, and returns model stills through request-media', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    attach(hub)
    const north = new North(hub)
    const imageInput = vi.fn(async () => ({
      content: [
        {
          type: 'image' as const,
          ref: { sha256: 'a'.repeat(64), size: 2, mime: 'image/png' },
          mime: 'image/png',
        },
      ],
    }))
    const ctx = {
      signal: new AbortController().signal,
      session: {
        key: 's1',
        toolUseId: 'call',
        imageInput,
        imageInputPolicy: async () => ({
          supported: true,
          maxBytes: 100,
          maxPixels: 100,
          maxWidth: 10,
          maxHeight: 10,
        }),
      },
    } as unknown as ToolContext
    let next = 0
    const tools = createMhsTools({
      north,
      async invocation() {
        return invocation(`operation-${++next}`)
      },
      async bindWake() {
        return { bindingId: 'bound-s1-lane1' }
      },
    })
    expect(tools.map((t) => t.name)).toEqual([
      'list_devices',
      'read_device',
      'call_device',
      'set_device',
      'stop_device',
      'watch_device',
      'unwatch_device',
    ])
    for (const tool of tools) expect(checkToolDef(tool), tool.name).toEqual({ ok: true })
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const declared = createMhsNativeProfileAdapter(async () => {})
      .definitions(north)
      .map(({ handler: _handler, prepare: _prepare, ...capability }) => capability)
    expect(manifest.agnes.plugins[0].capabilities.services).toEqual([
      ...declared,
      ...managedServiceCapabilities('hub', MHS_HUB_CONFIG_SCHEMA, MHS_HUB_CHECK_SCHEMA),
    ])
    for (const name of ['call_device', 'set_device'])
      expect(tools.find((t) => t.name === name)?.meta).toMatchObject({
        requiresApproval: 'always',
        replay: 'never',
        isDestructive: true,
      })
    const run = async (name: string, args = {}) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error('missing-tool')
      return tool.execute(args, ctx)
    }
    expect((await run('list_devices')).isError).toBeUndefined()
    hub.observation('rover', 'front', { w: 1, h: 1 }, new Uint8Array([1, 2]), 'image/png')
    const result = await run('read_device', { device: 'rover', sources: ['front'] })
    expect(result.content[0]?.type).toBe('image')
    expect(imageInput).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.structured)).not.toContain('"bytes"')
    expect((await run('read_device', { device: 'rover', sources: ['video'] })).isError).toBe(true)
    expect((await run('set_device', { device: 'rover', values: { lamp: true } })).isError).toBeUndefined()
    expect(
      (await run('call_device', { device: 'rover', tool: 'move', args: { x: 1 } })).isError,
    ).toBeUndefined()
    const watch = await run('watch_device', { device: 'rover', until: { health: 'bad' } })
    const id = (watch.structured as { watch: string }).watch
    expect((await run('unwatch_device', { watch: id })).isError).toBeUndefined()
    expect((await run('stop_device')).isError).toBeUndefined()
    await hub.shutdown()
  })
  it('runs the registered context hook with maps first, positions/zones/tool parameters, within UTF-8 budgets', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    const { link } = attach(hub)
    hub.online({
      ...link,
      registration: {
        ...link.registration,
        localization: 'fixed',
        placement: { map: 'site', x: 1, y: 1, yaw: 0 },
        maps: [
          {
            id: 'site',
            places: [
              {
                id: 'yard',
                name: 'Yard',
                points: [
                  [0, 0],
                  [2, 0],
                  [2, 2],
                  [0, 2],
                ],
              },
              ...Array.from({ length: 80 }, (_, n) => ({
                id: `p${n}`,
                name: '位置'.repeat(40),
                at: [n, n] as [number, number],
              })),
            ],
          },
        ],
      },
    })
    await vi.waitFor(async () => expect((await hub.maps())[0]?.id).toBeDefined())
    let context: (() => Promise<{ additionalContext?: string }>) | undefined
    registerMhsTools(
      {
        tools: { register() {} },
        hooks: {
          register(event: string, fn: unknown) {
            if (event === 'context') context = fn as typeof context
          },
        },
      } as unknown as Parameters<typeof registerMhsTools>[0],
      {
        north: new North(hub),
        async invocation() {
          return invocation('context')
        },
        async bindWake() {
          return { bindingId: 's1' }
        },
      },
    )
    if (!context) throw new Error('context hook missing')
    for (let n = 0; n < 40; n++)
      hub.online({
        ...link,
        registration: { ...link.registration, device: { id: `context-${n}`, kind: 'sensor' } },
      })
    const result = (await context()).additionalContext ?? ''
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(6000)
    expect(result).not.toContain('context-39:')
    expect(result).toContain('Use list_devices for more.')
    const deviceStart = result.indexOf('rover:')
    expect(deviceStart).toBeGreaterThan(result.indexOf('Map site'))
    expect(Buffer.byteLength(result.slice(0, deviceStart))).toBeLessThanOrEqual(3000)
    expect(result).toContain('"zone":"yard"')
    expect(result).toContain('"position":{"map":"site","x":1,"y":1,"yaw":0}')
    expect(result).toContain('Tool move:')
    expect(result).toContain('"minimum":-2')
    await hub.shutdown()
  })
  it('rejects browser identity fields and uses only server-bound control leases', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    attach(hub)
    const services = mhsServices(new North(hub), async () => invocation('native'))
    await expect(
      services.effect('call', { device: 'rover', tool: 'move', approved: true }, {}),
    ).rejects.toThrow('untrusted-authority')
    const streams = mhsStreams(new North(hub))
    const revoked = new AbortController()
    revoked.abort()
    expect(() => streams.events(() => {}, revoked.signal)).toThrow()
    await expect(
      streams.control({ type: 'manual', axes: { vx: 1 } }, { device: 'rover', leaseId: 'invented' }),
    ).rejects.toThrow('lease-expired')
    await hub.shutdown()
  })
  it('reports ready only after initialization and settles the managed shutdown callback', async () => {
    let shutdown:
      | ((
          reason: 'disable' | 'upgrade' | 'exit',
          signal: AbortSignal,
        ) => Promise<{ state: 'settled' | 'unknown' }>)
      | undefined
    const ready = vi.fn(async () => {})
    const runtime = await startMhsHub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'wake', state: 'queued' }
        },
      },
      devicePort: 0,
      signal: new AbortController().signal,
      ready,
      onShutdown(fn) {
        shutdown = fn
      },
    })
    expect(ready).toHaveBeenCalledWith({ apiVersion: '1.0.0', listeners: ['device'] })
    if (!shutdown) throw new Error('missing-shutdown-handler')
    expect(await shutdown('disable', new AbortController().signal)).toEqual({ state: 'settled' })
    await expect(runtime.north.query('devices', {})).rejects.toThrow('disabled')
    expect(await runtime.stop()).toEqual({ state: 'settled' })
  })
})
