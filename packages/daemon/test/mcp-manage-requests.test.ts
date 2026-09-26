import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import {
  createResourceControlService,
  createResourceControlStore,
  localResourceAuthority,
} from '@agnes/resource-control-store'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { createMcpManageRequests } from '../src/supervisor/mcp-manage-requests.js'

const roots: string[] = []
const endpoints: LocalEndpoint[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ep of endpoints.splice(0)) await ep.close()
  // Accepted MCP effects keep driving in the background and may still be writing a worker
  // snapshot while the directory is removed; retry the removal instead of failing on ENOTEMPTY.
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const definition = {
  serverId: 'fixture',
  displayName: 'Fixture',
  transport: { kind: 'stdio' as const, executable: process.execPath, args: [] },
  secretBinding: { kind: 'none' as const },
}
const revision = createHash('sha256').update(jcs(definition)).digest('hex')
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agh-mcp-onboard-'))
  roots.push(root)
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoints.push(ep)
  Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'client' })
  ep.conn.capabilities.permission = true
  ep.conn.attached.set('session', {} as never)
  const ask = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  const connected = vi.fn(async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => ({
    status: {
      serverId,
      connectionState: enabled ? ('ready' as const) : ('disabled' as const),
      observedRevision: revision,
      catalogRevision: 'a'.repeat(64),
      toolCount: enabled ? 1 : 0,
      observedAt: new Date().toISOString(),
    },
  }))
  const store = createResourceControlStore({
    directory: root,
    scope: { allowedProfiles: ['local-dev'] },
    mcp: {
      reconcile: connected,
      reconnect: (input) => connected({ ...input, enabled: true }),
      test: async () => ({ toolCount: 1, catalogRevision: 'a'.repeat(64) }),
      tools: async ({ serverId }) => ({ serverId, catalogRevision: 'a'.repeat(64), items: [] }),
    },
  })
  const service = createResourceControlService(store)
  const options = {
    directory: root,
    profile: 'local-dev',
    service,
    store,
    current: () => ep.conn,
    endpoint: () => ep,
    owner: () => ({ principalId: 'local', active: true }),
  }
  let handler = createMcpManageRequests(options)
  let seq = 0
  const request = (input: unknown, overrides = {}) =>
    handler('session', `r${++seq}`, 'mcp-manage', {
      packageId: '@agnes/mcp-helper',
      snapshotId: 'snapshot',
      rowId: 'ext:mcp-helper/main',
      sessionKey: 'session',
      toolUseId: 'tool',
      leaseId: 'lease',
      input,
      ...overrides,
    }) as Promise<{ proposalId: string; state: string; items: unknown[] }>
  return {
    root,
    ep,
    ask,
    store,
    service,
    request,
    connected,
    restart: () => {
      handler = createMcpManageRequests(options)
    },
  }
}

it('registers in the real AGH resource list, saves a revision grant and recovers the receipt', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  const p = await s.request({ action: 'prepare', definition })
  expect((await s.request({ action: 'list' })).items).toEqual([])
  expect(s.ask).not.toHaveBeenCalled()
  const receipt = await s.request({ action: 'commit', proposalId: p.proposalId })
  expect(['submitted', 'ready']).toContain(receipt.state)
  await vi.waitFor(async () =>
    expect(await s.request({ action: 'status', proposalId: p.proposalId })).toMatchObject({ state: 'ready' }),
  )
  expect((await s.request({ action: 'list' })).items).toEqual([
    expect.objectContaining({ serverId: 'fixture', enabled: true, state: 'ready' }),
  ])
  const snapshot = JSON.parse(await readFile(s.store.snapshotPath('local-dev'), 'utf8'))
  expect(snapshot.mcp[0].localStartApproval).toBe(revision)
  s.restart()
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({ state: 'ready' })
  expect(s.ask).toHaveBeenCalledTimes(1)
  const authority = localResourceAuthority()({ conn: s.ep.conn })
  await s.service.call(
    '_agnes/v1/mcp.servers.trust.set',
    {
      profile: 'local-dev',
      serverId: 'fixture',
      expectedRevision: revision,
      trust: 'rejected',
      clientId: 'client',
      commandId: 'revoke-1',
    },
    authority,
  )
  expect((await s.store.mcp.workerManaged('local-dev'))[0]?.localStartApproval).toBeUndefined()
})

it('denial and malformed identity never register or authorize a server', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  const p = await s.request({ action: 'prepare', definition })
  s.ask.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'reject_once' } })
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
    state: 'cancelled',
  })
  expect((await s.request({ action: 'list' })).items).toEqual([])
  await expect(s.request({ action: 'prepare', definition }, { sessionKey: 'other' })).rejects.toMatchObject({
    message: 'INVALID_PARAMS',
  })
  s.ep.conn.authKind = 'jwt'
  await expect(s.request({ action: 'prepare', definition })).rejects.toMatchObject({
    message: 'CAPABILITY_DENIED',
  })
})

it('an explicitly empty deployment ceiling cannot be overridden by a conversation', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', '')
  const s = await setup()
  await expect(s.request({ action: 'prepare', definition })).rejects.toMatchObject({
    data: { code: 'MCP_DEPLOYMENT_POLICY_DENIED' },
  })
  expect(s.ask).not.toHaveBeenCalled()
})

it('does not wait for an active-turn connection barrier before returning the submission', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const s = await setup()
  let release: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = s.connected.getMockImplementation()
  s.connected.mockImplementation(async (input) => {
    await barrier
    if (!original) throw new Error('fixture')
    return original(input)
  })
  const p = await s.request({ action: 'prepare', definition })
  try {
    expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
      state: 'submitted',
    })
  } finally {
    release()
  }
  await vi.waitFor(async () =>
    expect(await s.request({ action: 'status', proposalId: p.proposalId })).toMatchObject({ state: 'ready' }),
  )
})
