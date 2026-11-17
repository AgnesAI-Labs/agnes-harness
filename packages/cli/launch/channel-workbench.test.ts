import { jcs, sha256Hex } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { ChannelRefusal } from './channel-dedicated.js'
import { channelWorkbench } from './channel-workbench.js'

function fixture() {
  let approved = true
  let recovery = false
  let configuration = { instances: [] as Record<string, unknown>[] }
  let bindings: Record<string, unknown>[] = []
  const receipts = new Map<string, Record<string, unknown>>()
  const expectations = new Map<string, string>()
  const hooks: { workspaces?: () => void } = {}
  const call = vi.fn(async (method: string, params: any) => {
    if (method === '_agnes/v1/channels.catalog')
      return {
        providers: [
          {
            extension: 'plugin/chat',
            bindingAvailable: true,
            manifest: { id: 'chat', credentials: { required: ['appId', 'appSecret'], optional: ['token'] } },
          },
        ],
      }
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
      // The Host compares a stated revision before review and again in the write transaction.
      const stale =
        params.expectedConfigurationRevision !== undefined &&
        sha256Hex(jcs(configuration)) !== params.expectedConfigurationRevision
      if (approved && !stale) configuration = structuredClone(params.input)
      const receipt = stale
        ? { state: 'refused', operationId: params.operationId, code: 'REVISION_CONFLICT' }
        : { state: approved ? 'completed' : 'approval-required', operationId: params.operationId }
      receipts.set(params.operationId, receipt)
      if (params.expectedConfigurationRevision)
        expectations.set(params.operationId, params.expectedConfigurationRevision)
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
    workspace: {
      list: vi.fn(async () => {
        hooks.workspaces?.()
        return {
          items: [
            { workspaceId: 'w-team', name: 'Team', path: '/work/team', available: true },
            { workspaceId: 'w-gone', name: 'Gone', path: '/work/gone', available: false },
            { name: 'Unregistered', path: '/work/legacy', available: true },
          ],
        }
      }),
    },
    extensions: {
      readOperation: vi.fn(async ({ operationId }: { operationId: string }) => {
        const expected = expectations.get(operationId)
        // The Host settles a pending configuration whose stored revision moved since review.
        if (
          receipts.get(operationId)?.state === 'approval-required' &&
          expected &&
          sha256Hex(jcs(configuration)) !== expected
        )
          receipts.set(operationId, { state: 'refused', operationId, code: 'REVISION_CONFLICT' })
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
    hooks,
    configuration: () => configuration,
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

const refs = { appId: 'secret://generic/app-id', appSecret: 'secret://generic/app-secret' }
const bound = {
  id: 's-123456abcdef-123456',
  workspace: 'D:/owned',
  agent: 'default',
  credentialRefs: { appId: 'secret://generic/old' },
  allowFrom: ['owner'],
  requireMention: true,
  config: { mode: 'stream' },
}
async function dedicated(f: ReturnType<typeof fixture>) {
  f.setConfiguration({ instances: [structuredClone(bound)] })
  const context = await f.api.dedicatedContext('plugin/chat')
  const configurationRevision = (await f.api.overview()).channels[0]!.configurationRevision!
  return {
    context,
    params: {
      extension: 'plugin/chat',
      workspaceId: 'w-team',
      instanceId: context.instanceId,
      credentialRefs: refs,
      operationId: 'dedicated-1',
      configurationRevision,
    },
  }
}
const configures = (f: ReturnType<typeof fixture>) =>
  f.call.mock.calls.filter(([, p]) => p.service === 'channel.configure')

it('creates a dedicated connection without a session and appends it only to the reviewed revision', async () => {
  const f = fixture()
  const { context, params } = await dedicated(f)
  expect(context).toEqual({
    instanceId: expect.stringMatching(/^d-[a-f0-9]{12}$/),
    agent: 'default',
    agentTitle: { en: 'Default assistant', 'zh-CN': '默认助手' },
    workspaces: [{ workspaceId: 'w-team', name: 'Team', path: '/work/team' }],
  })
  f.setApproved(false)
  expect(await f.api.configureDedicated(params)).toEqual({
    receipt: { state: 'approval-required', operationId: 'dedicated-1' },
    instanceId: context.instanceId,
  })
  expect(configures(f)[0]![1]).toMatchObject({
    expectedConfigurationRevision: params.configurationRevision,
    operationId: 'dedicated-1',
  })
  expect(f.configuration().instances).toEqual([bound])
  f.setApproved(true)
  expect(await f.api.configureDedicated(params)).toMatchObject({ receipt: { state: 'completed' } })
  expect(await f.api.configureDedicated(params)).toMatchObject({ receipt: { state: 'completed' } })
  expect(configures(f)).toHaveLength(2)
  expect(f.configuration().instances).toEqual([
    bound,
    {
      id: context.instanceId,
      workspace: '/work/team',
      agent: 'default',
      credentialRefs: refs,
      config: {},
      allowFrom: [],
      requireMention: true,
    },
  ])
  const [kept, created] = (await f.api.overview()).channels[0]!.instances
  expect(kept).toMatchObject({ id: bound.id, workspace: bound.workspace })
  expect(created).toMatchObject({ id: context.instanceId, bindings: [], unavailable: false })
  expect(created?.intendedSession).toBeUndefined()
  // No session is read, bound or entered: the flow ends once the connection exists.
  expect(
    f.call.mock.calls.some(
      ([method]) => method !== '_agnes/v1/channels.catalog' && !method.includes('callScoped'),
    ),
  ).toBe(false)
  expect(f.call.mock.calls.some(([, p]) => ['channel.bind', 'channel.session'].includes(p?.service))).toBe(
    false,
  )
  expect(f.client.session.runtime).not.toHaveBeenCalled()
})

it.each(['before-read', 'between-read-and-prepare', 'during-approval'] as const)(
  'refuses a dedicated connection when the configuration changed %s and keeps the other change',
  async (moment) => {
    const f = fixture()
    const { params } = await dedicated(f)
    const other = { ...structuredClone(bound), id: 'd-0123456789ab', workspace: '/work/other' }
    const change = () => f.setConfiguration({ instances: [structuredClone(bound), other] })
    if (moment === 'before-read') change()
    if (moment === 'between-read-and-prepare') f.hooks.workspaces = change
    if (moment === 'during-approval') {
      f.setApproved(false)
      expect(await f.api.configureDedicated(params)).toMatchObject({
        receipt: { state: 'approval-required' },
      })
      change()
      f.setApproved(true)
    }
    const conflict = { state: 'refused', operationId: 'dedicated-1', code: 'REVISION_CONFLICT' }
    expect(await f.api.configureDedicated(params)).toEqual({
      receipt: conflict,
      instanceId: params.instanceId,
    })
    expect(f.configuration().instances).toEqual([bound, other])
    // Every refusal is the Host's journaled receipt: a stale form is still sent, a pending one settled.
    expect(configures(f)).toHaveLength(1)
    expect(await f.client.extensions.readOperation(params as never)).toEqual(conflict)
  },
)

it.each([
  ['an existing connection', { instanceId: 'd-0123456789ab' }],
  ['a session connection identity', { instanceId: 's-abcdefabcdef-abcdef' }],
  ['a forged identity', { instanceId: 'channel-1' }],
  ['an unregistered workspace', { workspaceId: 'w-missing' }],
  ['an unavailable workspace', { workspaceId: 'w-gone' }],
  ['another provider', { extension: 'plugin/other' }],
  ['an undeclared credential', { credentialRefs: { ...refs, unknown: 'secret://generic/x' } }],
  ['a missing required credential', { credentialRefs: { appId: refs.appId } }],
])('refuses a dedicated request that targets %s before configuring', async (_name, change) => {
  const f = fixture()
  const { params } = await dedicated(f)
  f.setConfiguration({
    instances: [structuredClone(bound), { ...structuredClone(bound), id: 'd-0123456789ab' }],
  })
  const configurationRevision = (await f.api.overview()).channels[0]!.configurationRevision!
  await expect(
    f.api.configureDedicated({ ...params, configurationRevision, ...change }),
  ).rejects.toBeInstanceOf(ChannelRefusal)
  expect(configures(f)).toHaveLength(0)
})
