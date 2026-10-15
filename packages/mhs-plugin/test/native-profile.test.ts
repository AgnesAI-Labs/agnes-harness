import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { PersistenceMetadataNamespace, PersistenceMetadataPort } from '@agnes/extension-api'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import { Hub, North } from '@agnes/mhs-hub'
import { expect, it } from 'vitest'
import { attach } from '../../mhs-hub/test/fixtures.js'
import { createMhsNativeProfileAdapter, mhsOwnedStore } from '../src/index.js'

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

it('runs real MHS profile services through native AR1 and the Host owner store without fake approval proof', async () => {
  const meta = metadata(),
    owner = 'plugin/0123456789abcdef'
  const activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  activations.publish([{ owner, revision: 'snapshot' }])
  const current = async () => {
    activations.require(owner, 'snapshot')
  }
  const adapter = createMhsNativeProfileAdapter(current)
  const store = mhsOwnedStore(
    ownedStore(
      meta.namespace(owner, 'state'),
      () => {
        activations.require(owner, 'snapshot')
      },
      true,
    ),
  )
  const hub = new Hub({
    store,
    authority: adapter.authority,
    wakes: {
      async enqueue() {
        throw new Error('No session target was bound')
      },
    },
  })
  attach(hub)
  const registry = new ServiceRegistry()
  const definitions = adapter.definitions(new North(hub))
  for (const definition of definitions)
    registry.registerRow(definition, {
      owner,
      packageId: '@agnes/mhs',
      integrity: 'snapshot',
      version: '0.0.0',
      signal: new AbortController().signal,
      assertAlive() {},
      assertRunning() {},
      consume() {},
    })
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
          subjectCredential: { kind: 'local' },
          grants: definitions.map((row) => ({ extension: owner, name: row.name, range: '*' })),
        }
      },
    },
    seams: fakeSeams(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clock: () => Date.now(),
    signal: new AbortController().signal,
    networkAllow: [],
    audit() {},
  })
  const credential = { kind: 'local' }
  const call = {
    extension: owner,
    service: 'mhs.call',
    operationId: 'native-motion',
    input: { device: 'rover', tool: 'move', args: { x: 1 } },
  }
  try {
    expect(
      await runtime.call({ extension: owner, service: 'mhs.devices', input: {} }, credential),
    ).toMatchObject({ output: [{ id: 'rover' }] })
    expect(
      await runtime.call(
        { extension: owner, service: 'mhs.operation', input: { operationId: 'missing' } },
        credential,
      ),
    ).toEqual({ output: null })
    expect(await runtime.call(call, credential)).toMatchObject({ state: 'approval-required' })
    const pending = (await runtime.listDecisions(credential))[0]!
    expect(pending.request.spec.subject).toMatchObject({
      presentation: { device: 'rover', action: 'call', input: { tool: 'move', args: { x: 1 } } },
    })
    await runtime.answerDecision(
      {
        handle: pending.handle,
        revision: pending.revision,
        commandId: 'native-approve',
        response: { option: 'allowed-once', value: null },
      },
      credential,
    )
    expect(await runtime.call(call, credential)).toMatchObject({
      state: 'completed',
      output: { id: 'native-motion' },
    })
    expect(await runtime.call(call, credential)).toMatchObject({ state: 'completed' })
    await expect(
      adapter.authority.admit(
        { operationId: 'forged', action: 'manual', device: 'rover', revision: 'fake', input: {} },
        { signal: new AbortController().signal, admission: { approval: true } },
      ),
    ).rejects.toThrow('stale-admission')
    const set = {
      extension: owner,
      service: 'mhs.set',
      operationId: 'stale-setting',
      input: { device: 'rover', values: { lamp: true } },
    }
    expect(await runtime.call(set, credential)).toMatchObject({ state: 'approval-required' })
    const setting = (await runtime.listDecisions(credential))[0]!
    await runtime.answerDecision(
      {
        handle: setting.handle,
        revision: setting.revision,
        commandId: 'setting-approve',
        response: { option: 'allowed-once', value: null },
      },
      credential,
    )
    // The real Hub description revision changes between review and dispatch.
    const view = hub.snapshot()[0]!
    const changed = attach(hub)
    const revised = { ...changed.link, registration: structuredClone(changed.link.registration) }
    revised.registration.device.kind = `${view.description.device.kind}-revised`
    hub.online(revised)
    await expect(runtime.call(set, credential)).rejects.toMatchObject({ data: { code: 'ID_CONFLICT' } })
    const row = await store.transaction((tx) => tx.get('example'))
    expect(row).toBeUndefined()
    await store.transaction((tx) => tx.put('example', { reviewed: true }, null))
    await expect(store.transaction((tx) => tx.put('example', false, null))).rejects.toThrow('CAS_CONFLICT')
    expect((await store.scan({ prefix: 'example', limit: 1 })).rows[0]?.value).toEqual({ reviewed: true })
    activations.publish([])
    await expect(runtime.call(call, credential)).rejects.toThrow()
  } finally {
    await runtime.close()
    // Shutdown can retain unknown when the reviewed owner has already been revoked.
    await hub.shutdown().catch(() => undefined)
  }
})
