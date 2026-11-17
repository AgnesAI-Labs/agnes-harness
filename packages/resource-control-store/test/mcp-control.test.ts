import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createResourceControlService,
  createResourceControlStore,
  McpResourceStore,
  RESOURCE_ALL_PERMISSIONS,
  type ResourceAuthority,
} from '../src/index.js'

const profile = 'local-dev'
const scope = { allowedProfiles: [profile] }
const authority: ResourceAuthority = {
  audience: 'admin',
  principalId: 'owner',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const definition = {
  serverId: 'example',
  displayName: 'Example',
  transport: { kind: 'stdio' as const, executable: 'example-mcp', args: [] },
  secretBinding: { kind: 'none' as const },
}
const revision = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')
type TestResult = Readonly<{
  operationId: string
  state: string
  items: readonly Readonly<{ resourceId: string; revision: string }>[]
}>
type TestService = Omit<ReturnType<typeof createResourceControlService>, 'call'> & {
  call(...args: Parameters<ReturnType<typeof createResourceControlService>['call']>): Promise<TestResult>
}
const testService = (service: ReturnType<typeof createResourceControlService>): TestService =>
  service as TestService
let directory = ''
const ready = (serverId: string) => ({
  serverId,
  connectionState: 'ready' as const,
  observedRevision: revision(definition),
  catalogRevision: 'a'.repeat(64),
  toolCount: 1,
  observedAt: new Date().toISOString(),
})
// These tests own the lifecycle driver. Await its public completion rather than
// racing durable journal writes with a fixed count of 2 ms reads on a loaded runner.
const drivers = new WeakMap<TestService, (operationId: string) => Promise<void>>()
function drivenService(store: McpResourceStore): TestService {
  store.setDeferredDrive(true)
  const service = testService(createResourceControlService(store))
  const running = new Map<string, Promise<void>>()
  drivers.set(service, (operationId) => {
    let pending = running.get(operationId)
    if (!pending) {
      pending = store.driveOperation(profile, operationId)
      running.set(operationId, pending)
    }
    return pending
  })
  return service
}
function drive(service: TestService, operationId: string): Promise<void> {
  const start = drivers.get(service)
  if (!start) throw new Error('test service has no completion barrier')
  return start(operationId)
}
async function settled(service: TestService, operationId: string) {
  await drive(service, operationId)
  const op = await service.call('_agnes/v1/resources.operation.get', { profile, operationId }, authority)
  expect(['succeeded', 'failed', 'cancelled']).toContain(op.state)
  return op
}
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('MCP durable resource control', () => {
  it.each([false, true])('guards replay and enabled removal (safe: %s)', async (safe) => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
    const reason = {
      code: 'MCP_CONNECT_TIMEOUT',
      message: 'MCP connection did not become ready before the deadline',
    }
    const store = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled, definition: candidate }) => {
        if (candidate.displayName === 'Bad candidate') {
          if (!safe) throw new Error('candidate could not connect')
          return { status: { ...ready(serverId), connectionState: 'unavailable' as const }, error: reason }
        }
        return {
          status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
        }
      },
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = drivenService(store)
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-1' },
      authority,
    )
    expect(await settled(service, create.operationId)).toMatchObject({ state: 'succeeded' })
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.create',
        { profile, definition, clientId: 'client', commandId: 'create-1' },
        authority,
      ),
    ).resolves.toEqual(create)
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.create',
        {
          profile,
          definition: { ...definition, displayName: 'different' },
          clientId: 'client',
          commandId: 'create-1',
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'COMMAND_CONFLICT' } })
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-1',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-1',
      },
      authority,
    )
    await settled(service, enable.operationId)
    await expect(
      service.call(
        '_agnes/v1/mcp.servers.remove',
        {
          profile,
          serverId: definition.serverId,
          expectedRevision: revision(definition),
          clientId: 'client',
          commandId: 'remove-1',
        },
        authority,
      ),
    ).rejects.toMatchObject({ data: { code: 'RESOURCE_REMOVE_BLOCKED' } })
    const badDefinition = { ...definition, displayName: 'Bad candidate' }
    const update = await service.call(
      '_agnes/v1/mcp.servers.update',
      {
        profile,
        serverId: definition.serverId,
        definition: badDefinition,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'update-bad',
      },
      authority,
    )
    expect(await settled(service, update.operationId)).toMatchObject({
      state: 'failed',
      lastSafeError: safe ? reason : { code: 'MCP_RECONCILE_FAILED' },
    })
    // The failed candidate never destroys the last ready definition/status used by reconnect/tools.
    await expect(
      service.call('_agnes/v1/mcp.servers.get', { profile, serverId: definition.serverId }, authority),
    ).resolves.toMatchObject({ revision: revision(definition), actual: 'ready' })
  })

  it('keeps a running MCP test open when the worker reports the server ready, and records its result', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
    let finishTest: (() => void) | undefined
    const store = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: () =>
        new Promise((resolve) => {
          finishTest = () => resolve({ toolCount: 1, catalogRevision: 'a'.repeat(64) })
        }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = drivenService(store)
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-1' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-1',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const tested = await service.call(
      '_agnes/v1/mcp.servers.test',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'test-1',
      },
      authority,
    )
    const driving = drive(service, tested.operationId)
    await vi.waitFor(() => expect(finishTest).toBeDefined())
    // A worker observation of the same server arrives while the test is still running. It says
    // nothing about the test, so the operation must stay open until the test itself reports.
    await store.observeWorker(profile, [ready(definition.serverId)])
    await expect(
      service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: tested.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'running' })
    finishTest?.()
    await driving
    expect(await settled(service, tested.operationId)).toMatchObject({
      state: 'succeeded',
      result: { toolCount: 1, catalogRevision: 'a'.repeat(64) },
    })
  })

  it.each([
    { kind: 'stdio' as const, executable: 'updated-mcp', args: ['--new'] },
    { kind: 'http' as const, url: 'https://updated.example.com/mcp' },
    { kind: 'sse' as const, url: 'https://updated.example.com/sse' },
  ])(
    'saves edited $kind connections disabled for review while disclosure-only edits retain trust',
    async (transport) => {
      directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
      let trusted = false
      const store = new McpResourceStore(directory, scope, {
        stage: async (input) => {
          trusted = input.trust === 'trusted'
        },
        // A server that stops connecting once its mode is `always`, like one whose process moved away.
        reconcile: async ({ serverId, enabled, definition: current }) =>
          !enabled
            ? { status: { ...ready(serverId), connectionState: 'disabled' as const } }
            : !trusted
              ? {
                  status: { ...ready(serverId), connectionState: 'unavailable' as const },
                  error: { code: 'MCP_UNTRUSTED_REVISION', message: 'trust is untrusted' },
                }
              : current.toolDisclosure === 'always'
                ? {
                    status: { ...ready(serverId), connectionState: 'unavailable' as const },
                    error: { code: 'MCP_CONNECT_FAILED', message: 'fixture connection refused' },
                  }
                : {
                    status: enabled
                      ? ready(serverId)
                      : { ...ready(serverId), connectionState: 'disabled' as const },
                  },
        reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
      })
      const service = drivenService(store)
      const call = async (method: string, params: Record<string, unknown>, commandId: string) =>
        settled(
          service,
          (
            await service.call(
              method as Parameters<TestService['call']>[0],
              { profile, clientId: 'client', commandId, ...params },
              authority,
            )
          ).operationId,
        )
      const target = { serverId: definition.serverId }
      await call('_agnes/v1/mcp.servers.create', { definition }, 'create')
      await call(
        '_agnes/v1/mcp.servers.trust.set',
        { ...target, expectedRevision: revision(definition), trust: 'trusted' },
        'trust',
      )
      await call(
        '_agnes/v1/mcp.servers.enable',
        { ...target, expectedRevision: revision(definition) },
        'enable',
      )
      const lazy = { ...definition, toolDisclosure: 'on-demand' as const }
      await call(
        '_agnes/v1/mcp.servers.update',
        { ...target, definition: lazy, expectedRevision: revision(definition) },
        'lazy',
      )
      const get = () =>
        service.call('_agnes/v1/mcp.servers.get', { profile, ...target }, authority) as unknown as Promise<
          Record<string, unknown>
        >
      expect(await get()).toMatchObject({
        revision: revision(lazy),
        trust: 'trusted',
        desired: 'enabled',
        definition: { toolDisclosure: 'on-demand' },
      })
      // The mode is saved even when the server cannot connect; the failure shows in its status.
      const shown = { ...definition, toolDisclosure: 'always' as const }
      expect(
        await call(
          '_agnes/v1/mcp.servers.update',
          { ...target, definition: shown, expectedRevision: revision(lazy) },
          'shown',
        ),
      ).toMatchObject({ state: 'succeeded' })
      expect(await get()).toMatchObject({
        trust: 'trusted',
        actual: 'unavailable',
        definition: { toolDisclosure: 'always' },
      })
      const renamed = { ...definition, displayName: 'Renamed', transport }
      expect(
        await call(
          '_agnes/v1/mcp.servers.update',
          { ...target, definition: renamed, expectedRevision: revision(shown) },
          'rename',
        ),
      ).toMatchObject({ state: 'succeeded' })
      const saved = {
        revision: revision(renamed),
        definition: renamed,
        trust: 'untrusted',
        desired: 'disabled',
        actual: 'disabled',
      }
      expect(await get()).toMatchObject(saved)
      const reopened = drivenService(new McpResourceStore(directory, scope))
      expect(
        await reopened.call('_agnes/v1/mcp.servers.get', { profile, ...target }, authority),
      ).toMatchObject(saved)
      await call(
        '_agnes/v1/mcp.servers.trust.set',
        { ...target, expectedRevision: revision(renamed), trust: 'trusted' },
        'trust-edited',
      )
      await call(
        '_agnes/v1/mcp.servers.enable',
        { ...target, expectedRevision: revision(renamed) },
        'enable-edited',
      )
      expect(await get()).toMatchObject({
        revision: revision(renamed),
        definition: renamed,
        trust: 'trusted',
        desired: 'enabled',
      })
    },
  )

  it('keeps a running enable open when the worker reports the server disabled first', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
    let finishEnable: (() => void) | undefined
    const store = new McpResourceStore(directory, scope, {
      reconcile: ({ serverId, enabled }) =>
        enabled
          ? new Promise((resolve) => {
              finishEnable = () => resolve({ status: ready(serverId) })
            })
          : Promise.resolve({ status: { ...ready(serverId), connectionState: 'disabled' as const } }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = drivenService(store)
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-1' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-1',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-1',
      },
      authority,
    )
    const driving = drive(service, enable.operationId)
    await vi.waitFor(() => expect(finishEnable).toBeDefined())
    // An idle worker reports the server as disabled before the enable has started it.
    await store.observeWorker(profile, [{ ...ready(definition.serverId), connectionState: 'disabled' }])
    await expect(
      service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: enable.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'running' })
    finishEnable?.()
    await driving
    expect(await settled(service, enable.operationId)).toMatchObject({ state: 'succeeded' })
  })

  it.each(['test', 'enable', 'disable', 'reconnect'] as const)(
    'does not settle a deferred %s from a worker observation',
    async (kind) => {
      directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-control-'))
      const store = new McpResourceStore(directory, scope, {
        reconcile: async ({ serverId, enabled }) => ({
          status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
        }),
        reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
      })
      // The profile's prior driver is still finishing publication; this operation has not started.
      store.setDeferredDrive(true)
      const call = (method: Parameters<typeof store.call>[0], params: Record<string, unknown>) =>
        store.call(method, { profile, clientId: 'client', ...params }, authority) as Promise<{
          operationId: string
        }>
      await call('_agnes/v1/mcp.servers.create', { definition, commandId: 'create-1' })
      await call('_agnes/v1/mcp.servers.trust.set', {
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        commandId: 'trust-1',
      })
      const tested = await call(`_agnes/v1/mcp.servers.${kind}`, {
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        commandId: 'test-1',
      })
      for (const connectionState of ['disabled', 'ready'] as const) {
        await store.observeWorker(profile, [{ ...ready(definition.serverId), connectionState }])
        await expect(
          store.call(
            '_agnes/v1/resources.operation.get',
            { profile, operationId: tested.operationId },
            authority,
          ),
        ).resolves.toMatchObject({ state: 'received' })
      }
      await store.driveOperation(profile, tested.operationId)
      await expect(
        store.call(
          '_agnes/v1/resources.operation.get',
          { profile, operationId: tested.operationId },
          authority,
        ),
      ).resolves.toMatchObject({
        state: 'succeeded',
        ...(kind === 'test' ? { result: { toolCount: 1, catalogRevision: 'a'.repeat(64) } } : {}),
      })
    },
  )

  describe('OAuth sign-out', () => {
    const oauth = {
      serverId: 'docs',
      displayName: 'Docs',
      transport: { kind: 'http' as const, url: 'https://mcp.example.test/mcp' },
      secretBinding: { kind: 'oauth' as const },
    }
    const needsSignIn = {
      code: 'MCP_OAUTH_NEEDS_RECONNECT',
      message: 'MCP server "docs" needs sign-in',
    }
    const unavailable = (serverId: string) => ({
      ...ready(serverId),
      connectionState: 'unavailable' as const,
      observedRevision: null,
      catalogRevision: null,
      toolCount: 0,
      lastSafeError: needsSignIn,
    })

    /** An enabled, trusted, signed-in OAuth server whose adapter records which effects ran. */
    async function signedInServer(
      signOut?: (serverId: string) => Promise<{ status: ReturnType<typeof unavailable> }>,
    ) {
      directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-sign-out-'))
      const effects: string[] = []
      const store = new McpResourceStore(directory, scope, {
        reconcile: async ({ serverId, enabled }) => {
          effects.push('reconcile')
          return {
            status: enabled
              ? { ...ready(serverId), observedRevision: revision(oauth) }
              : { ...ready(serverId), connectionState: 'disabled' as const },
          }
        },
        // A candidate that cannot connect: the store keeps the previous generation.
        reconnect: async ({ serverId }) => {
          effects.push('reconnect')
          return { status: unavailable(serverId), error: needsSignIn }
        },
        ...(signOut
          ? {
              signOut: async ({ serverId }: { serverId: string }) => {
                effects.push('signOut')
                return signOut(serverId)
              },
            }
          : {}),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
      })
      const service = drivenService(store)
      const command = async (method: string, commandId: string, extra: Record<string, unknown> = {}) => {
        const receipt = await service.call(
          method as Parameters<TestService['call']>[0],
          {
            profile,
            serverId: oauth.serverId,
            expectedRevision: revision(oauth),
            clientId: 'client',
            commandId,
            ...extra,
          },
          authority,
        )
        return settled(service, receipt.operationId)
      }
      const create = await service.call(
        '_agnes/v1/mcp.servers.create',
        { profile, definition: oauth, clientId: 'client', commandId: 'create-oauth' },
        authority,
      )
      await settled(service, create.operationId)
      await command('_agnes/v1/mcp.servers.trust.set', 'trust-oauth', { trust: 'trusted' })
      await command('_agnes/v1/mcp.servers.enable', 'enable-oauth')
      const get = () =>
        service.call(
          '_agnes/v1/mcp.servers.get',
          { profile, serverId: oauth.serverId },
          authority,
        ) as Promise<unknown>
      expect(await get()).toMatchObject({ actual: 'ready', authorizationStatus: 'authorized' })
      effects.length = 0
      return { service, command, get, effects }
    }

    it('signOut drops the active generation without a candidate and sets pending', async () => {
      const { service, command, get, effects } = await signedInServer(async (serverId) => ({
        status: unavailable(serverId),
      }))
      // A reconnect starts a candidate; one that cannot connect leaves the old generation in place.
      expect(await command('_agnes/v1/mcp.servers.reconnect', 'reconnect-oauth')).toMatchObject({
        state: 'failed',
      })
      expect(await get()).toMatchObject({ actual: 'ready', authorizationStatus: 'authorized' })

      expect(await command('_agnes/v1/mcp.servers.oauth.signOut', 'sign-out-oauth')).toMatchObject({
        state: 'succeeded',
      })

      expect(effects).toEqual(['reconnect', 'signOut'])
      expect(await get()).toMatchObject({
        actual: 'unavailable',
        authorizationStatus: 'pending',
        lastSafeError: needsSignIn,
      })
      await expect(
        service.call('_agnes/v1/mcp.servers.tools.list', { profile, serverId: oauth.serverId }, authority),
      ).rejects.toMatchObject({ data: { code: 'MCP_CATALOG_UNAVAILABLE' } })
    })

    it('the sign-in reads pending even when the host cannot drop the connection', async () => {
      const { command, get, effects } = await signedInServer()
      expect(await command('_agnes/v1/mcp.servers.oauth.signOut', 'sign-out-oauth')).toMatchObject({
        state: 'failed',
      })
      expect(effects).toEqual([])
      expect(await get()).toMatchObject({ authorizationStatus: 'pending' })
    })

    it('refuses to sign out a server that does not sign in with OAuth', async () => {
      directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-sign-out-'))
      const store = new McpResourceStore(directory, scope, {
        reconcile: async ({ serverId }) => ({ status: ready(serverId) }),
        reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
      })
      const service = drivenService(store)
      const create = await service.call(
        '_agnes/v1/mcp.servers.create',
        { profile, definition, clientId: 'client', commandId: 'create-plain' },
        authority,
      )
      await settled(service, create.operationId)
      await expect(
        service.call(
          '_agnes/v1/mcp.servers.oauth.signOut',
          {
            profile,
            serverId: definition.serverId,
            expectedRevision: revision(definition),
            clientId: 'client',
            commandId: 'sign-out-plain',
          },
          authority,
        ),
      ).rejects.toMatchObject({ data: { code: 'MCP_OAUTH_NOT_CONFIGURED' } })
    })
  })

  it('does not delegate a catalog read after the definition has been removed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-remove-catalog-'))
    const tools = vi.fn(async ({ serverId }: { serverId: string }) => ({
      serverId,
      catalogRevision: 'a'.repeat(64),
      items: [],
    }))
    const store = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools,
      unstage: async () => undefined,
    })
    const service = drivenService(store)
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-catalog' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-catalog',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-catalog',
      },
      authority,
    )
    await settled(service, enable.operationId)
    await expect(
      service.call('_agnes/v1/mcp.servers.tools.list', { profile, serverId: definition.serverId }, authority),
    ).resolves.toEqual({ serverId: definition.serverId, catalogRevision: 'a'.repeat(64), items: [] })
    expect(tools).toHaveBeenCalledTimes(1)
    const disable = await service.call(
      '_agnes/v1/mcp.servers.disable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'disable-catalog',
      },
      authority,
    )
    await settled(service, disable.operationId)
    const remove = await service.call(
      '_agnes/v1/mcp.servers.remove',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'remove-catalog',
      },
      authority,
    )
    await settled(service, remove.operationId)
    await expect(
      service.call('_agnes/v1/mcp.servers.tools.list', { profile, serverId: definition.serverId }, authority),
    ).rejects.toMatchObject({ data: { code: 'MCP_NOT_FOUND' } })
    expect(tools).toHaveBeenCalledTimes(1)
  })

  it('re-drives received and interrupted MCP operations after restart without trusting a departed observation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-recover-'))
    const initial = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    initial.setDeferredDrive(true)
    const initialService = testService(createResourceControlService(initial))
    const received = await initialService.call(
      '_agnes/v1/mcp.servers.create',
      {
        profile,
        definition: { ...definition, serverId: 'received' },
        clientId: 'client',
        commandId: 'recover-received',
      },
      authority,
    )
    const created = await initialService.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'recover-running' },
      authority,
    )
    const journalPath = join(directory, `${profile}.mcp.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ operation: { operationId: string; state: string; progress?: number } }>
    }
    const interrupted = journal.operations.find(
      (entry) => entry.operation.operationId === created.operationId,
    )
    if (!interrupted) throw new Error('received operation was not persisted')
    interrupted.operation = { ...interrupted.operation, state: 'running', progress: 50 }
    await writeFile(journalPath, JSON.stringify(journal))

    const reconcile = vi.fn(async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => ({
      status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
    }))
    const restarted = new McpResourceStore(directory, scope, {
      reconcile,
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    await restarted.recover()
    const restoredService = testService(createResourceControlService(restarted))
    await expect(
      restoredService.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: received.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
    await expect(
      restoredService.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: created.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
    await expect(
      restoredService.call(
        '_agnes/v1/mcp.servers.get',
        { profile, serverId: definition.serverId },
        authority,
      ),
    ).resolves.toMatchObject({ actual: 'disabled' })
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ profile, serverId: definition.serverId, enabled: false }),
    )
  })

  it('rewrites the worker snapshot after removal and retains the terminal operation', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-remove-snapshot-'))
    const store = createResourceControlStore({
      directory,
      scope,
      skills: {
        refresh: async () => [],
        reconcile: async () => [],
      },
      mcp: {
        reconcile: async ({ serverId, enabled }) => ({
          status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
        }),
        reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
        test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
        tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
        unstage: async () => undefined,
      },
    })
    const service = testService(createResourceControlService(store))
    const barrier = () => {
      let resolve = () => {}
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }
    let completion = barrier()
    store.setSuccessfulSnapshotHandler(() => completion.resolve())
    drivers.set(service, async () => {
      await completion.promise
      completion = barrier()
    })
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'create-snapshot' },
      authority,
    )
    await settled(service, create.operationId)
    const trust = await service.call(
      '_agnes/v1/mcp.servers.trust.set',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        trust: 'trusted',
        clientId: 'client',
        commandId: 'trust-snapshot',
      },
      authority,
    )
    await settled(service, trust.operationId)
    const enable = await service.call(
      '_agnes/v1/mcp.servers.enable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'enable-snapshot',
      },
      authority,
    )
    await settled(service, enable.operationId)
    const disable = await service.call(
      '_agnes/v1/mcp.servers.disable',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'disable-snapshot',
      },
      authority,
    )
    await settled(service, disable.operationId)
    const remove = await service.call(
      '_agnes/v1/mcp.servers.remove',
      {
        profile,
        serverId: definition.serverId,
        expectedRevision: revision(definition),
        clientId: 'client',
        commandId: 'remove-snapshot',
      },
      authority,
    )
    expect(await settled(service, remove.operationId)).toMatchObject({ state: 'succeeded' })
    expect(JSON.parse(await readFile(store.snapshotPath(profile), 'utf8'))).toMatchObject({ mcp: [] })
    await expect(
      service.call(
        '_agnes/v1/resources.operation.get',
        { profile, operationId: remove.operationId },
        authority,
      ),
    ).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('imports a legacy preset once, preserves explicit empty authority, and rejects a managed-id collision', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-nonempty-'))
    const first = new McpResourceStore(directory, scope)
    await first.seedLegacyPreset(profile, [definition])
    await first.seedLegacyPreset(profile, [definition])
    const journal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(journal).toMatchObject({ legacyPresetImported: true })
    expect(Object.keys(journal.servers)).toEqual([definition.serverId])
    expect(journal.operations).toEqual([])

    const restarted = new McpResourceStore(directory, scope)
    await restarted.seedLegacyPreset(profile, [definition])
    await expect(
      testService(createResourceControlService(restarted)).call(
        '_agnes/v1/mcp.servers.list',
        { profile },
        authority,
      ),
    ).resolves.toEqual({ items: [expect.objectContaining({ serverId: definition.serverId })] })
    const restartedJournal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(restartedJournal).toMatchObject({ legacyPresetImported: true })
    expect(Object.keys(restartedJournal.servers)).toEqual([definition.serverId])

    await rm(directory, { recursive: true, force: true })
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-empty-'))
    const empty = new McpResourceStore(directory, scope)
    await empty.seedLegacyPreset(profile, [])
    await new McpResourceStore(directory, scope).seedLegacyPreset(profile, [definition])
    await expect(
      testService(createResourceControlService(empty)).call(
        '_agnes/v1/mcp.servers.list',
        { profile },
        authority,
      ),
    ).resolves.toEqual({ items: [] })

    await rm(directory, { recursive: true, force: true })
    directory = await mkdtemp(join(tmpdir(), 'agnes-mcp-legacy-collision-'))
    const managed = new McpResourceStore(directory, scope, {
      reconcile: async ({ serverId, enabled }) => ({
        status: enabled ? ready(serverId) : { ...ready(serverId), connectionState: 'disabled' as const },
      }),
      reconnect: async ({ serverId }) => ({ status: ready(serverId) }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    })
    const service = drivenService(managed)
    const create = await service.call(
      '_agnes/v1/mcp.servers.create',
      { profile, definition, clientId: 'client', commandId: 'managed-create' },
      authority,
    )
    await settled(service, create.operationId)
    await expect(
      managed.seedLegacyPreset(profile, [{ ...definition, displayName: 'legacy collision' }]),
    ).rejects.toMatchObject({
      data: { code: 'LEGACY_MCP_CONFLICT' },
    })
    expect(
      await service.call('_agnes/v1/mcp.servers.get', { profile, serverId: definition.serverId }, authority),
    ).toMatchObject({ displayName: definition.displayName })
    const collisionJournal = JSON.parse(await readFile(join(directory, `${profile}.mcp.json`), 'utf8'))
    expect(collisionJournal.legacyPresetImported).toBe(false)
  })
})
