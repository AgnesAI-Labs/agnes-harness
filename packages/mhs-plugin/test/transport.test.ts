import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindPluginStreams,
  createPluginStreamBroker,
  createRosterStreamAuthorizer,
  type StreamPrincipal,
} from '@agnes/daemon-rpc/streams'
import type { ClientModuleRosterRow, StreamDeclaration } from '@agnes/protocol'
import { createManagedServiceRuntime } from '@agnes/sdk/managed-service'
import { expect, it, vi } from 'vitest'
import { attach, authority, invocation } from '../../mhs-hub/test/fixtures.js'
import { registerMhsStreams, startManagedMhsHub } from '../src/index.js'

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
it('runs the real Hub on the generic owned store/readiness and streams, parking on disconnect under media pressure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-mhs-transport-'))
  const [port, devicePort] = await Promise.all([freePort(), freePort()])
  const runtime = await createManagedServiceRuntime({
    port,
    initialization: {
      instanceId: 'synthetic',
      incarnation: 'private-proof',
      scopeId: 'one',
      apiVersion: '1.0.0',
      storePath: join(directory, 'owned.db'),
      namespace: 'mhs',
      listeners: { device: { host: '127.0.0.1', port: devicePort } },
    },
  })
  const headers = { 'x-agnes-incarnation': 'private-proof', 'content-type': 'application/json' }
  let stop: (() => Promise<unknown>) | undefined
  const lifetime = new AbortController()
  const principal: StreamPrincipal = {
    subject: 'human',
    connectionId: 'connection',
    profileId: 'one',
    actor: { id: 'human', org: 'synthetic', deptPath: [], role: 'user', attrs: {} },
    source: 'web',
    signal: lifetime.signal,
  }
  const row: ClientModuleRosterRow = {
    rowId: 'web:sample-mhs',
    moduleName: 'sample/mhs',
    enabled: true,
    phase: 'ready',
    packageId: 'sample-mhs',
    revision: 'revision',
    contentDigest: `sha256-${'a'.repeat(64)}`,
    extIds: ['sample/mhs'],
    streams: ['mhs.media', 'mhs.events', 'mhs.control'],
    binding: {
      owner: 'web:sample-mhs',
      lifetime: 'profile',
      profileId: 'one',
      activationId: 'current',
      packageId: 'sample-mhs',
      integrity: 'revision',
      availability: 'active',
    },
  }
  const broker = createPluginStreamBroker({
    authorize: createRosterStreamAuthorizer({
      async resolve(_principal, request) {
        if (request.name === 'mhs.control' && request.controlOperationId !== 'admitted-operation')
          throw new Error('approval-required')
        return {
          current: () => row,
          signal: lifetime.signal,
          assertScope() {},
          ...(request.name === 'mhs.control'
            ? { control: { grantId: 'admitted-grant', expiresAt: Date.now() + 30000 } }
            : {}),
        }
      },
    }),
  })
  try {
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers })).status).toBe(503)
    const hub = await startManagedMhsHub(runtime, {
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'wake', state: 'queued' }
        },
      },
    })
    stop = hub.stop
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers })).status).toBe(200)
    expect((await runtime.store.scan({ prefix: 'format', limit: 1 })).rows[0]?.value).toBe(1)
    const axes: Record<string, number>[] = []
    let parked = false
    const device = attach(hub.north.hub, {
      onStop() {
        parked = true
      },
    }).device
    device.onManual = async (value) => {
      axes.push(value)
    }
    await hub.north.effect('lease', { device: 'rover' }, invocation('manual-lease'))
    const declarations: StreamDeclaration[] = (['media', 'events', 'control'] as const).map((lane) => ({
      name: `mhs.${lane}`,
      lane,
      scope: 'profile',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      directions: lane === 'control' ? ['inbound'] : ['outbound'],
      maxFrameBytes: lane === 'media' ? 1048576 : 4096,
      maxBufferedBytes: lane === 'media' ? 2097152 : 32768,
      maxBytesPerSecond: lane === 'media' ? 4194304 : 65536,
      ...(lane === 'control' ? { controlService: 'mhs.lease' } : {}),
    }))
    const author = bindPluginStreams(broker, {
      owner: 'sample/mhs',
      profileId: 'one',
      activationId: 'current',
      signal: lifetime.signal,
      capabilities: {
        streams: declarations,
        services: [
          {
            name: 'mhs.lease',
            kind: 'effect',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: {},
            timeoutMs: 1000,
            maxResultBytes: 4096,
          },
        ],
      },
      assertCurrent() {},
      compileInput: () => () => true,
    })
    const release = registerMhsStreams(hub.north, author, async (context) => ({
      grantId: context.control?.grantId ?? 'missing',
      device: 'rover',
      leaseId: 'manual-lease',
    }))
    async function open(name: string, input: Record<string, string>, pressure = 0) {
      const grant = await broker.open(principal, {
        owner: 'sample/mhs',
        name,
        scope: { kind: 'profile', profileId: 'one' },
        input,
        client: { rowId: row.rowId, revision: 'revision', contentDigest: `sha256-${'a'.repeat(64)}` },
        ...(name === 'mhs.control' ? { controlOperationId: 'admitted-operation' } : {}),
      })
      const sent: (string | Uint8Array)[] = []
      const peer = broker.connect(principal, {
        bufferedAmount: pressure,
        send(data, done) {
          sent.push(data)
          done()
        },
        close() {},
      })
      peer.receive(new TextEncoder().encode(JSON.stringify({ ticket: grant.ticket })), false)
      await Promise.resolve()
      await Promise.resolve()
      return { peer, sent, grant }
    }
    const media = await open('mhs.media', { device: 'rover', source: 'front' }, 2097152)
    const control = await open('mhs.control', { device: 'forged-browser-device' })
    hub.north.hub.observation('rover', 'front', { w: 1, h: 1 }, new Uint8Array([1, 2]), 'image/png')
    expect(media.sent).toHaveLength(1) // Ready only: saturated media was dropped.
    control.peer.receive(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          streamId: control.grant.streamId,
          sequence: 0,
          kind: 'json',
          data: { type: 'manual', axes: { vx: 0.5 } },
        }),
      ),
      false,
    )
    await vi.waitFor(() => expect(axes).toContainEqual({ vx: 0.5 }))
    control.peer.disconnect()
    control.peer.disconnect()
    await vi.waitFor(() => expect(parked).toBe(true))
    await expect(hub.north.hub.manual('rover', 'manual-lease', { vx: 1 })).rejects.toThrow('lease-expired')
    release()
    const result = await fetch(`http://127.0.0.1:${port}/_agnes/managed/shutdown`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'disable' }),
    })
    expect(await result.json()).toEqual({ incarnation: 'private-proof', state: 'settled' })
    await expect(hub.north.query('devices', {})).rejects.toThrow('disabled')
  } finally {
    broker.close()
    lifetime.abort()
    await stop?.()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
