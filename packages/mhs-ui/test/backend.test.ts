import { DatabaseSync } from 'node:sqlite'
import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { PersistenceMetadataNamespace, PersistenceMetadataPort } from '@agnes/extension-api'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import { createMhsNativeProfileAdapter } from '@agnes/mhs'
import { Device as DeviceSdk, type Json } from '@agnes/mhs-device'
import { type DeviceLink, Hub, North } from '@agnes/mhs-hub'
import { encodeMedia } from '@agnes/mhs-hub/media'
import { createOwnedStore } from '@agnes/sdk/owned-store'
import { expect, it } from 'vitest'
import { MhsClient } from '../src/client.js'
import { sampleFrom } from '../src/media.js'
import { profileServices } from '../src/profile-services.js'
import { fake } from './fixtures.js'

function metadata(): PersistenceMetadataPort {
  const spaces = new Map<string, Map<string, unknown>>()
  return {
    namespace(owner, name): PersistenceMetadataNamespace {
      const key = `${owner}/${name}`,
        rows = spaces.get(key) ?? new Map<string, unknown>()
      spaces.set(key, rows)
      return {
        get: (key) => structuredClone(rows.get(key)),
        set: (key, value) => {
          rows.set(key, structuredClone(value))
        },
        delete: (key) => {
          rows.delete(key)
        },
        entries: () => [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction(work) {
          const before = structuredClone(rows)
          try {
            return work()
          } catch (error) {
            rows.clear()
            for (const [key, value] of before) rows.set(key, value)
            throw error
          }
        },
      }
    },
  }
}

it('consumes native AR1 authority, bounded session-filtered activity, SDK/Hub outputs and binary media', async () => {
  const database = new DatabaseSync(':memory:')
  const store = createOwnedStore(database, 'mhs-ui-native')
  const meta = metadata(),
    owner = 'plugin/0123456789abcdef'
  const activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  activations.publish([{ owner, revision: 'reviewed' }])
  const adapter = createMhsNativeProfileAdapter(async () => {
    activations.require(owner, 'reviewed')
  })
  const sdk = new DeviceSdk({
    protocol: 'mhs/v1',
    device: { id: 'sensor-01', kind: 'sensor' },
    state: { lamp: { type: 'boolean', writable: true } },
    sources: [{ id: 'air', kind: 'values', description: 'Air', fields: { temperature: { type: 'number' } } }],
    maps: [{ id: 'site', bounds: [0, 0, 10, 10] }],
  })
  sdk.update({ lamp: false })
  const hub = new Hub({
    store,
    wakes: {
      async enqueue() {
        throw new Error('No original session target was bound')
      },
    },
    authority: adapter.authority,
  })
  await hub.recover()
  const link: DeviceLink = {
    registration: sdk.description,
    available: true,
    async request(method, params) {
      if (method === 'mhs/set') {
        const result = sdk.set(params.values as Record<string, Json>)
        hub.state('sensor-01', sdk.state())
        return result
      }
      if (method === 'mhs/configure') return sdk.configure(params.sources)
      if (method === 'mhs/stop') {
        await sdk.stop()
        return {}
      }
      throw new Error('not-used')
    },
    async call() {
      throw new Error('not-used')
    },
    manual() {},
    close() {
      hub.offline('sensor-01', link)
    },
  }
  hub.online(link)
  hub.state('sensor-01', sdk.state())
  const north = new North(hub),
    f = fake()
  const registry = new ServiceRegistry(),
    definitions = adapter.definitions(north)
  for (const definition of definitions)
    registry.registerRow(definition, {
      owner,
      packageId: '@agnes/mhs',
      integrity: 'reviewed',
      version: '0.0.0',
      signal: new AbortController().signal,
      assertAlive() {},
      assertRunning() {},
      consume() {},
    })
  const credential = { kind: 'local' }
  const runtime = createProfileServiceRuntime({
    profileId: 'default',
    registry,
    activations,
    metadata: meta,
    storage: new MemoryStorage(),
    authority: {
      async resolve() {
        return {
          source: 'client-web',
          subjectCredential: credential,
          sessionReads: ['owned-session'],
          grants: definitions.map((d) => ({ extension: owner, name: d.name, range: '*' })),
        }
      },
    },
    seams: fakeSeams(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: Date.now,
    signal: new AbortController().signal,
    networkAllow: [],
    audit() {},
  })
  f.ports.services = profileServices({
    async query(service, input, options) {
      const result = await runtime.call(
        {
          extension: owner,
          service,
          input: input as Record<string, Json>,
          ...(options?.sessionReads ? { sessionReads: [...options.sessionReads] } : {}),
        },
        credential,
      )
      if (!('output' in result)) throw new Error('Expected native query output')
      return result.output
    },
    effect: (service, input, { operationId }) =>
      runtime.call(
        { extension: owner, service, input: input as Record<string, Json>, operationId },
        credential,
      ),
    readOperation: (service, operationId) =>
      runtime.readOperation({ extension: owner, service, operationId }, credential),
  })
  const approve = async () => {
    const decision = (await runtime.listDecisions(credential))[0]
    if (!decision) throw new Error('Expected native approval')
    await runtime.answerDecision(
      {
        handle: decision.handle,
        revision: decision.revision,
        commandId: crypto.randomUUID(),
        response: { option: 'allowed-once', value: null },
      },
      credential,
    )
  }
  const client = new MhsClient(f.ports)
  let recovered: Hub | undefined
  try {
    expect((await client.devices())[0]).toMatchObject({ id: 'sensor-01', state: { lamp: false } })
    const settingInput = { device: 'sensor-01', values: { lamp: true } }
    const setting = await client.effect('set', settingInput)
    settingInput.values.lamp = false
    expect(setting).toMatchObject({ state: 'approval-required' })
    expect((await client.devices())[0]?.state.lamp).toBe(false)
    expect(await f.ports.services.readOperation(setting.operationId)).toMatchObject({
      state: 'approval-required',
    })
    await approve()
    expect(await f.ports.services.readOperation(setting.operationId)).toMatchObject({
      state: 'completed',
      output: { state: 'terminal', outcome: { status: 'done' } },
    })
    expect((await client.devices())[0]?.state.lamp).toBe(true)
    hub.observation('sensor-01', 'air', { temperature: 22 })
    expect((await client.devices())[0]?.sourceStates.air).toBe(true)
    const configuration = await client.effect('configure', {
      device: 'sensor-01',
      params: { sources: { air: { on: false } } },
    })
    expect(configuration).toMatchObject({ state: 'approval-required' })
    await approve()
    expect(await f.ports.services.readOperation(configuration.operationId)).toMatchObject({
      state: 'completed',
    })
    expect((await new MhsClient(f.ports).devices())[0]?.sourceStates.air).toBe(false)
    await hub.journal.accept('sensor-01', {}, { operationId: 'paused', context: null })
    await hub.journal.running('paused', 'sensor-01', { state: 'paused', fraction: 0.4 })
    expect(await north.query('operation', { operationId: 'paused' })).toMatchObject({
      state: 'running',
      phase: 'paused',
      startedAt: expect.any(Number),
      progress: { fraction: 0.4 },
    })
    expect((await client.devices())[0]?.jobs).toContainEqual(
      expect.objectContaining({ id: 'paused', phase: 'paused', state: 'running' }),
    )
    await hub.journal.finish('paused', { status: 'done' })
    await hub.journal.running('paused', 'sensor-01', { state: 'running' })
    expect(await north.query('operation', { operationId: 'paused' })).toMatchObject({
      state: 'terminal',
      endedAt: expect.any(Number),
    })
    recovered = new Hub({
      store,
      wakes: {
        async enqueue() {
          throw new Error('No original session target was bound')
        },
      },
      authority: adapter.authority,
    })
    await recovered.recover()
    recovered.online(link)
    const recoveredDevice = recovered.snapshot()[0]
    expect(recoveredDevice?.jobs).toContainEqual(
      expect.objectContaining({ id: 'paused', state: 'terminal', outcome: { status: 'done' } }),
    )
    expect(recoveredDevice?.jobs?.find((job) => job.id === 'paused')).not.toHaveProperty('sessionId')
    await hub.activity.append('owned-first', {}, 'sensor-01', 'owned-session')
    await hub.activity.append('foreign', {}, 'sensor-01', 'foreign-session')
    await hub.activity.append('owned-second', {}, 'sensor-01', 'owned-session')
    const first = await client.activity({ limit: 1, sessionId: 'owned-session' })
    expect(first.events.map((e) => e.type)).toEqual(['owned-first'])
    expect(first.nextCursor).toBeTypeOf('string')
    const second = await client.activity({ limit: 1, cursor: first.nextCursor!, sessionId: 'owned-session' })
    expect(second.events.map((e) => e.type)).toEqual(['owned-second'])
    await expect(client.activity({ limit: 1, sessionId: 'foreign-session' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(
      runtime.call(
        { extension: owner, service: 'mhs.activity', input: { sessionId: 'owned-session' } },
        credential,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    await expect(
      runtime.call(
        {
          extension: owner,
          service: 'mhs.activity',
          sessionReads: ['owned-session'],
          input: { sessionId: 'foreign-session' },
        },
        credential,
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    for (const input of [
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { cursor: '' },
      { cursor: 'x'.repeat(513) },
      { sessionId: '' },
      { sessionId: 'x'.repeat(513) },
      { limit: 1, approved: true },
    ])
      await expect(client.activity(input)).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    const decoded = sampleFrom(
      encodeMedia({ device: 'sensor-01', source: 'air', at: 123, data: { temperature: 22 } }),
    )
    expect(decoded).toMatchObject({ device: 'sensor-01', source: 'air', at: 123, data: { temperature: 22 } })
    const abandoned = new AbortController()
    const proposal = await f.ports.services.effect(
      'mhs.set',
      { device: 'sensor-01', values: { lamp: false } },
      { operationId: 'abandoned', signal: abandoned.signal },
    )
    expect(proposal).toMatchObject({ state: 'approval-required' })
    await approve()
    abandoned.abort(new Error('view closed'))
    await expect(f.ports.services.readOperation(proposal.operationId)).rejects.toThrow('view closed')
    expect((await client.devices())[0]?.state.lamp).toBe(true)
    expect(await client.effect('stop', {})).toMatchObject({
      state: 'completed',
      output: { state: 'settled' },
    })
  } finally {
    client.dispose()
    await recovered?.shutdown().catch(() => undefined)
    await hub.shutdown().catch(() => undefined)
    await runtime.close()
    database.close()
  }
})
