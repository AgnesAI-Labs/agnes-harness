import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import {
  bindPluginStreams,
  createPluginStreamBroker,
  createRosterStreamAuthorizer,
  type StreamPrincipal,
} from '@agnes/daemon-rpc/streams'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import type { ClientModuleRosterRow, StreamDeclaration } from '@agnes/protocol'
import { createManagedServiceRuntime } from '@agnes/sdk/managed-service'
import { expect, it, vi } from 'vitest'
import { attach } from '../../mhs-hub/test/fixtures.js'
import { createMhsNativeProfileAdapter, registerMhsStreams, startManagedMhsHub } from '../src/index.js'
import { metadata } from './profile-fixture.js'

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
    moduleName: 'plugin/0123456789abcdef',
    enabled: true,
    phase: 'ready',
    packageId: 'sample-mhs',
    revision: 'revision',
    contentDigest: `sha256-${'a'.repeat(64)}`,
    extIds: ['plugin/0123456789abcdef'],
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
  const meta = metadata(),
    activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  const owner = 'plugin/0123456789abcdef'
  activations.publish([{ owner, revision: 'revision' }])
  const adapter = createMhsNativeProfileAdapter(async () => {
    activations.require(owner, 'revision')
  })
  const activationId = activations.require(owner, 'revision')
  if (!row.binding) throw new Error('missing profile binding')
  row.binding = { ...row.binding, activationId }
  const registry = new ServiceRegistry()
  const credential = { kind: 'local' }
  const native = createProfileServiceRuntime({
    profileId: 'one',
    registry,
    activations,
    metadata: meta,
    storage: new MemoryStorage(),
    authority: {
      async resolve() {
        return {
          source: 'web',
          subjectCredential: credential,
          grants: [{ extension: owner, name: 'mhs.lease', range: '*' }],
        }
      },
    },
    seams: fakeSeams(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: Date.now,
    signal: lifetime.signal,
    networkAllow: [],
    audit() {},
  })
  const broker = createPluginStreamBroker({
    authorize: createRosterStreamAuthorizer({
      async resolve(authenticated, request) {
        const grant =
          request.name === 'mhs.control'
            ? await native.authorizeControl(
                {
                  extension: owner,
                  service: 'mhs.lease',
                  operationId: request.controlOperationId ?? 'missing',
                },
                credential,
              )
            : undefined
        if (grant && JSON.stringify(grant.actor) !== JSON.stringify(authenticated.actor))
          throw new Error('actor-mismatch')
        return {
          current: () => row,
          signal: lifetime.signal,
          assertScope() {
            activations.require(owner, 'revision', activationId)
            if (request.scope.kind !== 'profile' || authenticated.profileId !== 'one')
              throw new Error('profile-mismatch')
          },
          ...(grant ? { control: { grantId: grant.grantId, expiresAt: grant.expiresAt } } : {}),
        }
      },
    }),
  })
  try {
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers })).status).toBe(503)
    const hub = await startManagedMhsHub(runtime, {
      authority: adapter.authority,
      wakes: {
        async enqueue() {
          throw new Error('No original session target was bound')
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
    const definitions = adapter.definitions(hub.north)
    for (const definition of definitions)
      registry.registerRow(definition, {
        owner,
        packageId: 'sample-mhs',
        integrity: 'revision',
        version: '0.0.0',
        signal: lifetime.signal,
        assertAlive() {},
        assertRunning() {},
        consume() {},
      })
    const lease = {
      extension: owner,
      service: 'mhs.lease',
      operationId: 'manual-lease',
      input: { device: 'rover' },
    }
    expect(await native.call(lease, credential)).toMatchObject({ state: 'approval-required' })
    await expect(
      native.authorizeControl(
        { extension: owner, service: 'mhs.lease', operationId: 'manual-lease' },
        credential,
      ),
    ).rejects.toThrow()
    const pending = (await native.listDecisions(credential))[0]!
    await native.answerDecision(
      {
        handle: pending.handle,
        revision: pending.revision,
        commandId: 'review-lease',
        response: { option: 'allowed-once', value: null },
      },
      credential,
    )
    expect(await native.call(lease, credential)).toMatchObject({ state: 'completed' })
    const admitted = await native.authorizeControl(
      { extension: owner, service: 'mhs.lease', operationId: 'manual-lease' },
      credential,
    )
    Object.assign(principal, { actor: admitted.actor, source: admitted.source })
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
      owner: 'plugin/0123456789abcdef',
      profileId: 'one',
      activationId,
      signal: lifetime.signal,
      capabilities: {
        streams: declarations,
        services: [
          {
            name: 'mhs.lease',
            kind: 'effect',
            scope: 'profile',
            controlLeaseMs: 30000,
            effectPolicy: {
              isDestructive: true,
              isOpenWorld: true,
              replay: 'never',
              requiresApproval: 'always',
              approvalScopes: [],
            },
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: {},
            timeoutMs: 1000,
            maxResultBytes: 4096,
          },
        ],
      },
      assertCurrent() {
        activations.require(owner, 'revision', activationId)
      },
      compileInput: () => () => true,
    })
    const release = registerMhsStreams(hub.north, author, adapter.bindControl)
    async function open(name: string, input: Record<string, string>, pressure = 0) {
      const grant = await broker.open(principal, {
        owner: 'plugin/0123456789abcdef',
        name,
        scope: { kind: 'profile', profileId: 'one' },
        input,
        client: { rowId: row.rowId, revision: 'revision', contentDigest: `sha256-${'a'.repeat(64)}` },
        ...(name === 'mhs.control' ? { controlOperationId: 'manual-lease' } : {}),
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
      await new Promise<void>((resolve) => setImmediate(resolve))
      return { peer, sent, grant }
    }
    await expect(
      broker.open(principal, {
        owner: 'plugin/0123456789abcdef',
        name: 'mhs.control',
        scope: { kind: 'profile', profileId: 'one' },
        input: {},
        client: { rowId: row.rowId, revision: 'revision', contentDigest: `sha256-${'a'.repeat(64)}` },
      }),
    ).rejects.toThrow()
    await expect(
      broker.open(
        { ...principal, actor: { ...principal.actor, id: 'another-human' } },
        {
          owner,
          name: 'mhs.control',
          scope: { kind: 'profile', profileId: 'one' },
          input: {},
          client: { rowId: row.rowId, revision: row.revision, contentDigest: row.contentDigest },
          controlOperationId: 'manual-lease',
        },
      ),
    ).rejects.toThrow('actor-mismatch')
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
    activations.publish([])
    await expect(
      native.authorizeControl(
        { extension: owner, service: 'mhs.lease', operationId: 'manual-lease' },
        credential,
      ),
    ).rejects.toThrow()
    await expect(open('mhs.events', {})).rejects.toThrow()
  } finally {
    broker.close()
    await native.close()
    lifetime.abort()
    await stop?.()
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
