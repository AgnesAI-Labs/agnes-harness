import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@agnes/cordis'
import { createTestHost } from '@agnes/host/testkit'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { connectDevice, Device } from '@agnes/mhs-device'
import { createMhsModule, MhsClient, type MhsModuleContext, MhsStore, profileServices } from '@agnes/mhs-ui'
import {
  clientModuleRowIdForContribution,
  hashDirectory,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import type { ClientModuleRosterRow, JsonValue } from '@agnes/protocol'
import { createPluginStreamsClient, type PluginStreamSocket } from '@agnes/sdk/browser'
import { homeEntries, LocaleService, SessionService, SlotRegistry } from '@agnes/web-client'
import { profileStreamEndpoint } from '@agnes/worker-runtime'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

it('enables the installed MHS plugin, connects a real SDK device, admits manual control and stops on disable', async () => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'agh-mhs-wiring-')))
  const original = fileURLToPath(new URL('..', import.meta.url)),
    directory = join(dataDir, 'snapshot')
  await mkdir(directory)
  for (const path of ['package.json', 'agnes.client.json', 'src'])
    await cp(join(original, path), join(directory, path), { recursive: true })
  const integrity = `sha256-${'7'.repeat(64)}`,
    rowId = 'ext:agnes.mhs',
    owner = pluginRowSource(rowId)
  const source: RuntimePluginSnapshot = {
    snapshot: {
      snapshotId: integrity,
      profile: 'local-dev',
      packageId: '@agnes/mhs',
      version: '0.0.0',
      integrity,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'synthetic',
      directory,
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const row = createPluginRow({
    id: rowId,
    plugin: `@agnes/mhs@${integrity}/mhsPlugin`,
    snapshotDigest: integrity,
    exportName: 'mhsPlugin',
    entryRevision: integrity,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    runtime: 'in-process',
    inject: ['tools', 'hooks', 'services', 'profileRuntime'],
  })
  const target = (disabled: boolean) =>
    buildRuntimeTarget({
      rows: [{ ...row, disabled }],
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    })
  const lifetime = new AbortController(),
    deviceLife = new AbortController()
  let connected: Promise<void> | undefined
  let disposeStore: (() => void) | undefined
  let disposeModule: (() => void) | undefined
  let closeHost: (() => Promise<void>) | undefined
  try {
    const { host } = await createTestHost({
      dataDir,
      runtimePluginCatalogue: [source],
      extensionLoader: {
        // Evaluate the real workspace modules; the verified snapshot contains their identical source.
        import: async (file) =>
          file.startsWith(`${directory}/`)
            ? await import('../src/index.js')
            : ((await import(pathToFileURL(file).href)) as Record<string, unknown>),
      },
      serviceAuthority: {
        async resolve(credential) {
          const value = credential as { grants?: { extension: string; name: string; range: string }[] }
          return {
            source: 'client-web',
            subjectCredential: { kind: 'local' },
            grants:
              value.grants ??
              [
                'mhs.devices',
                'mhs.maps',
                'mhs.world',
                'mhs.lease',
                'mhs.stop',
                'hub.status',
                'hub.check',
                'hub.configuration',
                'hub.configure',
              ].map((name) => ({ extension: owner, name, range: '*' })),
          }
        },
      },
    })
    closeHost = () => host.close()
    await host.applyRuntimeTarget(target(false))
    const runtime = host.profileServices
    if (!runtime?.streams || !runtime.managed) throw new Error('profile-runtime-missing')
    await runtime.managed.settle()
    await vi.waitFor(async () => {
      expect(await runtime.call({ extension: owner, service: 'hub.status', input: {} }, {})).toMatchObject({
        output: { state: 'ready' },
      })
    })
    const hubStatus = await runtime.call({ extension: owner, service: 'hub.status', input: {} }, {})
    const status = ('output' in hubStatus ? hubStatus.output : null) as {
      endpoints: { device: { port: number } }
    }
    const port = status.endpoints.device.port
    const axes: Record<string, number>[] = [],
      stopped: string[] = []
    const device = new Device(
      {
        protocol: 'mhs/v1',
        device: { id: 'wire-rover', kind: 'robot' },
        manual: { axes: [{ id: 'vx', min: -1, max: 1 }], deadman_s: 0.2 },
        state: { battery: { type: 'number' } },
      },
      {
        arm() {},
        async stop(reason) {
          stopped.push(reason)
        },
      },
    )
    device.update({ battery: 80 })
    device.onManual = async (value) => {
      axes.push(value)
    }
    connected = connectDevice(device, `ws://127.0.0.1:${port}`, deviceLife.signal)
    void connected.catch(() => undefined)
    expect(runtime.streams.describe(owner, 'mhs.events').activationId).toBeTruthy()
    const origin = 'http://127.0.0.1:49999'
    const endpoint = await profileStreamEndpoint(host, origin)
    const clientRowId = clientModuleRowIdForContribution('@agnes/mhs', owner, 1, owner)
    const roster: ClientModuleRosterRow = {
      rowId: clientRowId,
      moduleName: owner,
      enabled: true,
      phase: 'ready',
      packageId: '@agnes/mhs',
      revision: integrity,
      contentDigest: `sha256-${'a'.repeat(64)}`,
      extIds: [owner],
      streams: ['mhs.events', 'mhs.control'],
      binding: {
        owner: clientRowId,
        lifetime: 'profile',
        profileId: host.profile.name,
        activationId: 'ui-contribution-epoch',
        packageId: '@agnes/mhs',
        integrity,
        availability: 'active',
      },
    }
    const headers = { host: new URL(origin).host, origin, 'x-agnes-stream-proof': endpoint.proof }
    const post = (headers: Record<string, string>, body: unknown, signal?: AbortSignal) =>
      new Promise<{ status: number; ok: boolean; json(): unknown }>((resolve, reject) => {
        const req = request(
          {
            hostname: endpoint.host,
            port: endpoint.port,
            path: '/_agnes/plugin-stream/open',
            method: 'POST',
            headers,
            signal,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                ok: res.statusCode === 200,
                json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
              }),
            )
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.end(JSON.stringify(body))
      })
    const openHeaders = {
      ...headers,
      'content-type': 'application/json',
      'x-agnes-stream-open': '1',
    }
    const { 'x-agnes-stream-proof': _proof, ...withoutProof } = openHeaders
    expect((await post(withoutProof, {})).status).toBe(401)
    expect((await post({ ...openHeaders, origin: 'http://untrusted.invalid' }, {})).status).toBe(403)
    const streams = createPluginStreamsClient({
      origin,
      owner,
      names: roster.streams ?? [],
      scope: { kind: 'profile', profileId: host.profile.name },
      signal: lifetime.signal,
      client: { rowId: clientRowId, revision: integrity, contentDigest: `sha256-${'a'.repeat(64)}` },
      async open(input, signal) {
        const response = await post(
          {
            ...openHeaders,
            'x-agnes-stream-row': Buffer.from(JSON.stringify(roster)).toString('base64url'),
          },
          input,
          signal,
        )
        if (!response.ok)
          throw new Error(`stream-refused:${response.status}:${JSON.stringify(response.json())}`)
        return response.json()
      },
      socket: () =>
        new WebSocket(`ws://${endpoint.host}:${endpoint.port}/_agnes/plugin-stream`, {
          headers,
        }) as unknown as PluginStreamSocket,
    })
    const services = profileServices({
      async query(name, input) {
        const result = await runtime.call(
          { extension: owner, service: name, input: input as Record<string, JsonValue> },
          {},
        )
        if (!('output' in result)) throw new Error('query-failed')
        return result.output
      },
      effect: (name, input, options) =>
        runtime.call(
          {
            extension: owner,
            service: name,
            input: input as Record<string, JsonValue>,
            operationId: options.operationId,
          },
          {},
        ),
      readOperation: (service, operationId) =>
        runtime.readOperation({ extension: owner, service, operationId }, {}),
    })
    const client = new MhsClient({
      services,
      streams,
      session: new SessionService(new Context()),
    })
    const store = new MhsStore(client)
    disposeStore = store.start()
    const ui = new Context(),
      observers = new Set<() => void>()
    let visible = true
    const slots = new SlotRegistry(ui)
    slots.declare('tool.call.toolview', { kind: 'keyed', scope: 'session' }, 'synthetic-shell')
    const moduleContext = {
      effect: ui.effect.bind(ui),
      locale: new LocaleService(ui, 'en'),
      slots,
      homeEntries: { register: homeEntries.register.bind(homeEntries) },
      availability: {
        getSnapshot: () => ({ availability: visible ? 'active' : 'disabled' }),
        subscribe: (listener: () => void) => {
          observers.add(listener)
          return () => {
            observers.delete(listener)
          }
        },
      },
    } as unknown as MhsModuleContext
    disposeModule = createMhsModule(client.ports).apply(moduleContext)
    expect(homeEntries.get('mhs')?.placement).toBe('primary')
    const frames: JsonValue[] = []
    const events = await client.stream('events', {}, (frame) => {
      if (!(frame instanceof Uint8Array)) frames.push(frame)
    })
    await vi.waitFor(async () =>
      expect(await client.devices()).toEqual([
        expect.objectContaining({ id: 'wire-rover', available: true }),
      ]),
    )
    await vi.waitFor(() =>
      expect(store.read()).toMatchObject({
        status: 'ready',
        devices: [expect.objectContaining({ id: 'wire-rover', available: true })],
      }),
    )
    await vi.waitFor(() => expect(homeEntries.get('mhs')?.badge?.getSnapshot()).toBe(1))
    device.update({ battery: 70 })
    await vi.waitFor(() => expect(store.read().devices[0]?.state.battery).toBe(70))
    await vi.waitFor(() =>
      expect(frames.some((frame) => JSON.stringify(frame).includes('wire-rover'))).toBe(true),
    )
    let disconnected = false
    events.stream.onDisconnect(() => {
      disconnected = true
    })
    expect(runtime.managed.statuses('@agnes/mhs')).toHaveLength(1)
    await host.createSession({ cwd: dataDir, key: 'one' })
    await host.createSession({ cwd: dataDir, key: 'two' })
    expect(runtime.managed.statuses('@agnes/mhs')).toHaveLength(1)
    const proposal = await client.effect('lease', { device: 'wire-rover' })
    expect(proposal.state).toBe('approval-required')
    await expect(
      client.stream('control', {}, () => {}, lifetime.signal, proposal.operationId),
    ).rejects.toThrow()
    expect(axes.some((axes) => axes.vx === 0.5)).toBe(false)
    const approve = async (commandId: string) => {
      const decision = (await runtime.listDecisions({ kind: 'local' }))[0]
      if (!decision) throw new Error('native-decision-missing')
      await runtime.answerDecision(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId,
          response: { option: 'allowed-once', value: null },
        },
        { kind: 'local' },
      )
    }
    await approve('approve-manual')
    expect((await services.readOperation(proposal.operationId)).state).toBe('completed')
    const control = await client.stream('control', {}, () => {}, lifetime.signal, proposal.operationId)
    control.stream.send({ type: 'manual', axes: { vx: 0.5 } })
    await vi.waitFor(() => expect(axes).toContainEqual({ vx: 0.5 }))
    expect(await client.effect('stop', { device: 'wire-rover' })).toMatchObject({
      state: 'completed',
      output: { state: 'settled' },
    })
    expect(stopped.length).toBeGreaterThan(0)
    const reconfigure = await services.effect(
      'hub.configure',
      { listenerPorts: { device: port } },
      {
        operationId: crypto.randomUUID(),
      },
    )
    expect(reconfigure.state).toBe('approval-required')
    await approve('approve-configure')
    expect((await services.readOperation(reconfigure.operationId)).state).toBe('completed')
    await vi.waitFor(() => expect(disconnected).toBe(true))
    await vi.waitFor(async () => expect((await client.devices())[0]?.available).toBe(true), { timeout: 5000 })
    device.update({ battery: 60 })
    await vi.waitFor(() => expect(store.read().devices[0]?.state.battery).toBe(60), { timeout: 5000 })
    await host.applyRuntimeTarget(target(true))
    await host.profileServices?.managed?.settle()
    expect(host.profileServices?.managed?.statuses('@agnes/mhs')).toEqual([])
    visible = false
    for (const listener of observers) listener()
    expect(homeEntries.get('mhs')).toBeUndefined()
    await expect(client.devices()).rejects.toThrow()
    await expect(client.stream('events', {}, () => {})).rejects.toThrow()
    disposeStore()
    expect(store.read()).toMatchObject({ status: 'disabled', devices: [] })
    deviceLife.abort()
    await connected
  } finally {
    disposeModule?.()
    disposeStore?.()
    lifetime.abort()
    deviceLife.abort()
    await connected?.catch(() => undefined)
    await closeHost?.()
    await rm(dataDir, { recursive: true, force: true })
  }
})
