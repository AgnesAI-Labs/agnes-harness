import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginStream, StreamFrame } from '@agnes/extension-api'
import { createTestHost } from '@agnes/host/testkit'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import {
  createSkillCandidateRegistry,
  createSkillCordisService,
} from '@agnes/host-extensions/resources/skills'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, type PluginRow } from '@agnes/plugin-runtime/host'
import type { ClientModuleRosterRow } from '@agnes/protocol'
import { createPluginStreamsClient, type PluginStreamSocket } from '@agnes/sdk/browser'
import { profileStreamEndpoint } from '@agnes/worker-runtime'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { MARS_PACKAGE_ID } from '../src/access.js'
import { createMarsExampleAccess } from '../src/browser-transport.js'
import { MarsRuntime } from '../src/runtime.js'
import { DEVICE_IDS, PLACES } from '../src/world.js'

it.each([true, false])(
  'binds the current producer with reviewed parent grant=%s, reaches eleven ready, stops and disables',
  async (reviewed) => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'agh-mars-producer-')))
    const specs = [
      {
        id: 'ext:agnes.mhs',
        packageId: '@agnes/mhs',
        exportName: 'mhsPlugin',
        directory: '../../../../packages/mhs-plugin/',
        files: ['package.json', 'agnes.client.json', 'src'],
        inject: ['tools', 'hooks', 'services', 'profileRuntime'],
      },
      {
        id: 'ext:agnes-example.mars-rescue',
        packageId: MARS_PACKAGE_ID,
        exportName: 'marsRescue',
        directory: '../',
        files: ['package.json', 'index.mjs', 'client', 'skills'],
        inject: ['skills', 'profileRuntime'],
      },
    ]
    const sources: RuntimePluginSnapshot[] = [],
      rows: PluginRow[] = []
    for (const [index, spec] of specs.entries()) {
      const directory = join(dataDir, `snapshot-${index}`)
      await mkdir(directory)
      const original = fileURLToPath(new URL(spec.directory, import.meta.url))
      for (const file of spec.files)
        await cp(join(original, file), join(directory, file), { recursive: true })
      const manifestPath = join(directory, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (index === 1 && !reviewed) {
        manifest.agnes.plugins[0].capabilities.managedServices[0].requires = []
        await writeFile(manifestPath, JSON.stringify(manifest))
      }
      const integrity = `sha256-${String(index + 1).repeat(64)}`
      sources.push({
        snapshot: {
          snapshotId: integrity,
          profile: 'local-dev',
          packageId: spec.packageId,
          version: manifest.version,
          integrity,
          treeIntegrity: hashDirectory(directory, { exclude: [] }),
          capabilityHash: 'synthetic',
          directory,
          contributions: [],
        },
        generation: 1,
        trusted: true,
      })
      rows.push(
        createPluginRow({
          id: spec.id,
          plugin: `${spec.packageId}@${integrity}/${spec.exportName}`,
          snapshotDigest: integrity,
          exportName: spec.exportName,
          entryRevision: integrity,
          extrasRevision: 'none',
          mountRevision: 'host-ordinary-row:v1',
          runtime: 'in-process',
          inject: spec.inject,
        }),
      )
    }
    const parent = pluginRowSource(specs[0]!.id),
      child = pluginRowSource(specs[1]!.id)
    const target = (disabled: 'none' | 'child' | 'parent') =>
      buildRuntimeTarget({
        rows: rows.map((row, i) => ({
          ...row,
          disabled: (disabled === 'child' && i === 1) || (disabled === 'parent' && i === 0),
        })),
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      })
    const life = new AbortController()
    const { host } = await createTestHost({
      dataDir,
      runtimePluginCatalogue: sources,
      skillContribution: createSkillCordisService(
        createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } }),
      ),
      extensionLoader: {
        import: async (file) => {
          if (file.startsWith(`${sources[0]!.snapshot.directory}/`)) return await import('@agnes/mhs')
          if (file.startsWith(`${sources[1]!.snapshot.directory}/`))
            return await import(new URL('../index.mjs', import.meta.url).href)
          return await import(pathToFileURL(file).href)
        },
      },
      serviceAuthority: {
        async resolve() {
          return {
            source: 'client-web',
            subjectCredential: { kind: 'local' },
            grants: ['mhs.devices', 'mhs.stop', 'mhs.call', 'hub.status'].map((name) => ({
              extension: parent,
              name,
              range: '*',
            })),
          }
        },
      },
    })
    let step = 'enable'
    let runtime: MarsRuntime | undefined
    try {
      await host.applyRuntimeTarget(target('none')).catch((error) => {
        throw new Error(JSON.stringify(host.ordinaryConvergence()), { cause: error })
      })
      await host.profileServices?.managed?.settle()
      const origin = 'http://127.0.0.1:49998'
      const endpoint = await profileStreamEndpoint(host, origin)
      const revision = sources[1]!.snapshot.integrity
      const roster: ClientModuleRosterRow = {
        rowId: 'web:mars',
        moduleName: child,
        enabled: true,
        phase: 'ready',
        packageId: MARS_PACKAGE_ID,
        revision,
        contentDigest: `sha256-${'a'.repeat(64)}`,
        extIds: [child],
        streams: ['mars.devices', 'mars.media'],
        binding: {
          owner: 'web:mars',
          lifetime: 'profile',
          profileId: host.profile.name,
          activationId: 'ui-epoch',
          packageId: MARS_PACKAGE_ID,
          integrity: revision,
          availability: 'active',
        },
      }
      const headers = { host: new URL(origin).host, origin, 'x-agnes-stream-proof': endpoint.proof }
      const streams = createPluginStreamsClient({
        origin,
        owner: child,
        names: roster.streams ?? [],
        scope: { kind: 'profile', profileId: host.profile.name },
        signal: life.signal,
        client: { rowId: roster.rowId, revision, contentDigest: roster.contentDigest! },
        open: (input, signal) =>
          new Promise((resolve, reject) => {
            const req = request(
              {
                hostname: endpoint.host,
                port: endpoint.port,
                path: '/_agnes/plugin-stream/open',
                method: 'POST',
                signal,
                headers: {
                  ...headers,
                  'content-type': 'application/json',
                  'x-agnes-stream-open': '1',
                  'x-agnes-stream-row': Buffer.from(JSON.stringify(roster)).toString('base64url'),
                },
              },
              (res) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                res.on('end', () => {
                  if (res.statusCode !== 200) reject(new Error(`refused:${res.statusCode}`))
                  else resolve(JSON.parse(Buffer.concat(chunks).toString()))
                })
              },
            )
            req.on('error', reject)
            req.end(JSON.stringify(input))
          }),
        socket: () =>
          new WebSocket(`ws://${endpoint.host}:${endpoint.port}/_agnes/plugin-stream`, {
            headers,
          }) as unknown as PluginStreamSocket,
      })
      const access = createMarsExampleAccess(streams)
      runtime = new MarsRuntime({
        connect: (device, signal) => access.connect(MARS_PACKAGE_ID, device, signal),
      })
      const devices = async () => {
        const result = await host.profileServices!.call(
          { extension: parent, service: 'mhs.devices', input: {} },
          {},
        )
        if (!('output' in result)) throw new Error('devices-refused')
        return result.output
      }
      if (!reviewed) {
        await expect(runtime.start()).rejects.toThrow()
        expect(await devices()).toEqual([])
        return
      }
      step = 'start'
      await runtime.start()
      step = 'list'
      expect(runtime.snapshot().online).toEqual(DEVICE_IDS)
      expect(await devices()).toEqual(
        DEVICE_IDS.map((id) => expect.objectContaining({ id, available: true })),
      )
      // Registrations do not grant motion authority. Native AR1 is still required.
      step = 'motion'
      const motion = await host.profileServices!.call(
        {
          extension: parent,
          service: 'mhs.call',
          operationId: 'producer-native-motion',
          input: { device: 'rover-01', tool: 'drive_to', args: PLACES.sample },
        },
        {},
      )
      expect(motion).toMatchObject({ state: 'approval-required' })
      const decision = (await host.profileServices!.listDecisions({ kind: 'local' }))[0]
      if (!decision) throw new Error('native-decision-missing')
      await host.profileServices!.answerDecision(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: crypto.randomUUID(),
          response: { option: 'allowed-once', value: null },
        },
        { kind: 'local' },
      )
      expect(
        await host.profileServices!.call(
          {
            extension: parent,
            service: 'mhs.call',
            operationId: 'producer-native-motion',
            input: { device: 'rover-01', tool: 'drive_to', args: PLACES.sample },
          },
          {},
        ),
      ).toMatchObject({ state: 'completed' })
      await vi.waitFor(() => expect(runtime!.simulation.pose('rover-01')).not.toMatchObject(PLACES.dock))
      await vi.waitFor(async () =>
        expect(await devices()).toEqual(
          DEVICE_IDS.map((id) =>
            expect.objectContaining({ id, position: expect.objectContaining({ map: 'mars-base' }) }),
          ),
        ),
      )
      await expect(
        access.connect(
          '@unreviewed/example' as typeof MARS_PACKAGE_ID,
          runtime.simulation.device('rover-01'),
          life.signal,
        ),
      ).rejects.toThrow('unreviewed-example')
      step = 'stop'
      await runtime.stop()
      await vi.waitFor(async () =>
        expect(await devices()).toEqual(
          DEVICE_IDS.map((id) => expect.objectContaining({ id, available: false })),
        ),
      )
      step = 'start'
      await runtime.start()
      step = 'list'
      expect(runtime.snapshot().online).toHaveLength(11)
      const stopped = await host.profileServices!.call(
        { extension: parent, service: 'mhs.stop', operationId: 'producer-native-stop', input: {} },
        {},
      )
      expect(stopped).toMatchObject({ state: 'completed', output: { state: 'settled' } })
      step = 'disable-child'
      await host.applyRuntimeTarget(target('child'))
      step = 'settle-disabled-child'
      await host.profileServices?.managed?.settle()
      await vi.waitFor(() => expect(runtime!.snapshot().status).toBe('unavailable'))
      expect(host.profileServices?.managed?.statuses(MARS_PACKAGE_ID)).toEqual([])
      await expect(streams.open('mars.devices', { fleet: crypto.randomUUID() })).rejects.toThrow()
      step = 'disable-parent'
      await host.applyRuntimeTarget(target('parent'))
      await host.profileServices?.managed?.settle()
      expect(host.profileServices?.managed?.statuses('@agnes/mhs')).toEqual([])
    } catch (error) {
      throw new Error(
        `${step}: ${JSON.stringify({ error, parent: host.profileServices?.managed?.statuses('@agnes/mhs'), child: host.profileServices?.managed?.statuses(MARS_PACKAGE_ID) })}`,
        { cause: error },
      )
    } finally {
      life.abort()
      await runtime?.stop()
      await host.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  },
)

// Deliberately silent transport fixture: production Host/gateway coverage is above.
it('parks the fleet within two seconds when an authenticated producer stops answering', async () => {
  vi.useFakeTimers()
  const frames = new Set<(frame: StreamFrame) => void>()
  const disconnected = new Set<(info: { reason: string }) => void | Promise<void>>()
  let closed = false
  const stream: PluginStream = {
    send(frame) {
      if (closed) return 'closed'
      if (frame instanceof Uint8Array && frame[0] === 123) {
        const message = JSON.parse(new TextDecoder().decode(frame)) as { type: string; device: string }
        if (message.type === 'register')
          queueMicrotask(() => {
            for (const fn of frames) fn({ type: 'registered', device: message.device })
          })
      }
      return 'accepted'
    },
    onFrame(fn) {
      frames.add(fn)
      return () => {
        frames.delete(fn)
      }
    },
    onDisconnect(fn) {
      disconnected.add(fn)
      return () => {
        disconnected.delete(fn)
      }
    },
    onDrop: () => () => {},
    close() {
      if (closed) return
      closed = true
      for (const fn of disconnected) void fn({ reason: 'stalled' })
    },
  }
  const access = createMarsExampleAccess({ open: async () => stream })
  const runtime = new MarsRuntime({
    connect: (device, signal) => access.connect(MARS_PACKAGE_ID, device, signal),
  })
  try {
    await runtime.start()
    expect(runtime.snapshot().online).toHaveLength(11)
    await vi.advanceTimersByTimeAsync(2000)
    expect(runtime.snapshot()).toMatchObject({ status: 'unavailable', online: [] })
    expect(runtime.simulation.device('rover-01').call('offline', 'drive_to', PLACES.sample)).toMatchObject({
      accepted: false,
    })
  } finally {
    await runtime.stop()
    vi.useRealTimers()
  }
})
