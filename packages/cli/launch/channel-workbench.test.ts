import type { Client } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { channelWorkbench } from './channel-workbench.js'

function fixture() {
  let approved = true
  let recovery = false
  let configuration = { instances: [] as Record<string, unknown>[] }
  let bindings: Record<string, unknown>[] = []
  const receipts = new Map<string, Record<string, unknown>>()
  const call = vi.fn(async (method: string, params: any) => {
    if (method === '_agnes/v1/channels.catalog')
      return { providers: [{ extension: 'plugin/chat', bindingAvailable: true, manifest: { id: 'chat' } }] }
    if (params.service === 'channel.configuration') return { output: structuredClone(configuration) }
    if (params.service === 'channel.check')
      return {
        output: {
          instances: configuration.instances.map((instance) => ({
            id: instance.id,
            version: 7,
            connection: recovery ? null : { channel: 'connected', daemon: 'connected' },
            recovery,
            bindings,
          })),
        },
      }
    if (params.service === 'channel.configure') {
      if (approved) configuration = structuredClone(params.input)
      const receipt = { state: approved ? 'completed' : 'approval-required', operationId: params.operationId }
      receipts.set(params.operationId, receipt)
      return receipt
    }
    throw new Error('unexpected call')
  })
  const client = {
    call,
    session: {
      list: vi.fn(async () => ({
        items: [
          { sessionId: 'owned', title: 'Owned session', cwd: 'D:/owned' },
          { sessionId: 'other', title: 'Other session', cwd: 'D:/other' },
        ],
      })),
      runtime: vi.fn(async () => ({ loop: { id: 'agnes.default' } })),
    },
    packages: { list: vi.fn(async () => ({ packages: [] })) },
    extensions: {
      readOperation: vi.fn(async ({ operationId }: { operationId: string }) => {
        const receipt = receipts.get(operationId)
        if (receipt) return receipt
        throw Object.assign(new Error('unknown operation'), { data: { code: 'CAPABILITY_DENIED' } })
      }),
    },
  } as unknown as Client
  return {
    setRecovery: (value: boolean) => {
      recovery = value
    },
    setApproved: (value: boolean) => {
      approved = value
    },
    api: channelWorkbench(client, 'local-dev'),
    client,
    call,
    setConfiguration: (value: typeof configuration) => {
      configuration = value
    },
    setBindings: (value: typeof bindings) => {
      bindings = value
    },
  }
}

it('derives connection identity from the owned session, merges connections and replays a completed receipt', async () => {
  const f = fixture()
  const context = await f.api.context('plugin/chat', 'owned')
  const overview = await f.api.overview()
  const params = {
    extension: 'plugin/chat',
    sessionId: 'owned',
    instanceId: context.instanceId,
    configurationRevision: overview.channels[0]!.configurationRevision,
    operationId: 'configure-1',
    credentialRefs: {},
  }
  expect(context).toMatchObject({ workspace: 'D:/owned', agent: 'default', title: 'Owned session' })
  expect(await f.api.configure(params)).toMatchObject({ receipt: { state: 'completed' } })
  const current = await f.api.overview()
  expect(current.channels[0]!.instances[0]).toMatchObject({
    id: context.instanceId,
    workspace: 'D:/owned',
    intendedSession: { sessionId: 'owned' },
  })
  expect(await f.api.configure(params)).toMatchObject({ receipt: { state: 'completed' } })
  expect(f.call.mock.calls.filter(([, p]) => p.service === 'channel.configure')).toHaveLength(1)
  const next = await f.api.context('plugin/chat', 'other')
  await f.api.configure({
    ...params,
    sessionId: 'other',
    instanceId: next.instanceId,
    replaceId: context.instanceId,
    operationId: 'configure-2',
    configurationRevision: current.channels[0]!.configurationRevision,
  })
  expect((await f.api.overview()).channels[0]!.instances).toMatchObject([
    { id: next.instanceId, workspace: 'D:/other', intendedSession: { sessionId: 'other' } },
  ])
  expect((await f.api.overview()).channels[0]!.instances).toHaveLength(1)
})

it('removes only the reviewed instance through native approval and reconciles its completed operation', async () => {
  const f = fixture()
  const keep = {
    id: 'keep',
    workspace: 'D:/other',
    agent: 'default',
    credentialRefs: { account: 'secret://generic/keep' },
    config: { enabled: true },
  }
  f.setConfiguration({ instances: [{ id: 'remove', workspace: 'D:/owned' }, keep] })
  f.setBindings([{ sessionId: 'owned', targetId: 'peer', label: 'Team', state: 'active' }])
  f.setRecovery(true)
  expect((await f.api.overview()).channels[0]!.instances[0]).toMatchObject({
    connection: null,
    recovery: true,
    unavailable: false,
    statusUnavailable: false,
  })
  const params = {
    extension: 'plugin/chat',
    instanceId: 'remove',
    operationId: 'remove-1',
    expectedVersion: 7,
    configurationRevision: (await f.api.overview()).channels[0]!.configurationRevision,
  }
  f.setApproved(false)
  expect(await f.api.remove(params)).toMatchObject({ receipt: { state: 'approval-required' } })
  expect((await f.api.overview()).channels[0]!.instances).toHaveLength(2)
  f.setApproved(true)
  expect(await f.api.remove(params)).toMatchObject({ receipt: { state: 'completed' } })
  expect(await f.api.remove(params)).toMatchObject({ receipt: { state: 'completed' } })
  expect((await f.api.overview()).channels[0]!.instances).toMatchObject([keep])
  expect(
    f.call.mock.calls
      .filter(([, p]) => p.service === 'channel.configure')
      .every(([, p]) => JSON.stringify(p.input) === JSON.stringify({ instances: [keep] })),
  ).toBe(true)
})

it.each(['configuration', 'binding', 'foreign-binding', 'missing', 'provider', 'health'])(
  'refuses deletion on a changed or inaccessible %s before configuring',
  async (failure) => {
    const f = fixture()
    f.setConfiguration({ instances: [{ id: 'remove', workspace: 'D:/owned' }] })
    const configurationRevision = (await f.api.overview()).channels[0]!.configurationRevision
    if (failure === 'foreign-binding') f.setBindings([{ sessionId: 'private' }])
    if (failure === 'health') {
      const original = f.call.getMockImplementation()!
      f.call.mockImplementation(async (method, params) =>
        params.service === 'channel.check' ? { output: { instances: [] } } : original(method, params),
      )
    }
    await expect(
      f.api.remove({
        extension: failure === 'provider' ? 'foreign' : 'plugin/chat',
        instanceId: failure === 'missing' ? 'missing' : 'remove',
        operationId: 'remove-failure',
        expectedVersion: failure === 'binding' ? 8 : 7,
        configurationRevision: failure === 'configuration' ? 'stale' : configurationRevision,
      }),
    ).rejects.toThrow()
    expect(f.call.mock.calls.some(([, p]) => p.service === 'channel.configure')).toBe(false)
  },
)

it('refuses foreign sessions, stale configuration and forged instance identities before mutation', async () => {
  const f = fixture()
  await expect(f.api.context('plugin/chat', 'foreign')).rejects.toThrow()
  const context = await f.api.context('plugin/chat', 'owned')
  const params = {
    extension: 'plugin/chat',
    sessionId: 'owned',
    instanceId: context.instanceId,
    operationId: 'operation',
    credentialRefs: {},
    configurationRevision: 'stale',
  }
  await expect(f.api.configure(params)).rejects.toThrow('changed')
  await expect(f.api.configure({ ...params, instanceId: 'channel-1' })).rejects.toThrow()
  expect(f.call.mock.calls.some(([, p]) => p.service === 'channel.configure')).toBe(false)
})

it('shows authorized session names and hides inaccessible binding identities while blocking replacement', async () => {
  const f = fixture()
  f.setConfiguration({
    instances: [{ id: 'old', workspace: 'D:/owned', agent: 'default', credentialRefs: {} }],
  })
  f.setBindings([
    { sessionId: 'owned', targetId: 'peer', label: 'Team', state: 'active' },
    { sessionId: 'private', targetId: 'secret-peer', label: 'Private team', state: 'active' },
  ])
  const overview = await f.api.overview()
  expect(overview.channels[0]!.instances[0]).toMatchObject({
    unavailable: true,
    bindings: [{ sessionId: 'owned', sessionTitle: 'Owned session', label: 'Team' }],
  })
  expect(JSON.stringify(overview)).not.toContain('Private team')
  const context = await f.api.context('plugin/chat', 'owned')
  await expect(
    f.api.configure({
      extension: 'plugin/chat',
      sessionId: 'owned',
      instanceId: context.instanceId,
      replaceId: 'old',
      operationId: 'operation',
      configurationRevision: overview.channels[0]!.configurationRevision,
      credentialRefs: {},
    }),
  ).rejects.toThrow()
})
