import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTestHost } from '@agnes/host/testkit'
import {
  activeRuntimePinId,
  BUNDLED_HELPERS,
  createPackageManager,
  emptyLock,
  writeLock,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { InferenceEvent, JsonValue } from '@agnes/protocol'
import { createResourceControlService, createResourceControlStore } from '@agnes/resource-control-store'
import { createWorkerMcpServerOpener } from '@agnes/resource-control-worker'
import { expect, it, vi } from 'vitest'
import { createMcpRowRuntime, type McpRowRuntime } from '../../worker-runtime/src/mcp-row-runtime.js'
import { rebuildDesiredFromInventory, withoutPackageRows } from '../src/composite-desired.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { initializeDefaultHelpers } from '../src/packages/default-helpers.js'
import { createMcpManageRequests } from '../src/supervisor/mcp-manage-requests.js'

const call = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const say: InferenceEvent[] = [
  { type: 'text_delta', delta: 'Done' },
  { type: 'done', reason: 'stop' },
]

it('a conversation approves registration and calls the real stdio server on its next turn', async () => {
  vi.stubEnv('AGNES_MCP_STDIO_ALLOWLIST', undefined)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-conversation-mcp-')))
  const require = createRequire(import.meta.url)
  const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
  const sdk = (file: string) => JSON.stringify(baseRequire.resolve(`@modelcontextprotocol/sdk/${file}`))
  const scriptPath = join(root, 'fixture.mjs')
  await writeFile(
    scriptPath,
    `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { Server } = require(${sdk('server/index.js')});
    const { StdioServerTransport } = require(${sdk('server/stdio.js')});
    const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk('types.js')});
    const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Read-only fixture echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'AGH_CONVERSATION_MCP_OK' }] }));
    await server.connect(new StdioServerTransport());
  `,
  )
  const definition = {
    serverId: 'fixture',
    displayName: 'Conversation fixture',
    transport: { kind: 'stdio', executable: process.execPath, args: [scriptPath] },
    secretBinding: { kind: 'none' },
  }
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'client' })
  ep.conn.capabilities.permission = true
  ep.conn.attached.set('conversation', {} as never)
  const permission = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  let release: () => void = () => {}
  const turnEnd = new Promise<void>((resolve) => {
    release = resolve
  })
  let rows: McpRowRuntime | undefined
  const store = createResourceControlStore({
    directory: join(root, 'resources'),
    scope: { allowedProfiles: ['local-dev'] },
    mcp: {
      reconcile: async ({ serverId }) => {
        await turnEnd
        if (!rows) throw new Error('rows unavailable')
        const result = await rows.apply(await store.mcp.workerManaged('local-dev'))
        const status = result.statuses.get(serverId)
        if (!status) throw new Error('status unavailable')
        return { status }
      },
      reconnect: async () => {
        throw new Error('unused')
      },
      test: async () => {
        throw new Error('must not open a second test connection')
      },
      tools: async () => {
        throw new Error('unused')
      },
    },
  })
  const service = createResourceControlService(store)
  const handler = createMcpManageRequests({
    directory: root,
    profile: 'local-dev',
    service,
    store,
    current: () => ep.conn,
    endpoint: () => ep,
    owner: () => ({ principalId: 'local', active: true }),
  })
  let proposalId = ''
  let seq = 0
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.0.0' })
  await initializeDefaultHelpers({
    profileDir,
    manager,
    initializePolicy: async () => {
      writeLock(profileDir, {
        ...emptyLock('local-dev', '0.0.0'),
        resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
        seams: Object.fromEntries(
          [
            'approval',
            'checkpoint',
            'ledger',
            'sandbox',
            'verifier',
            'repair',
            'artifacts',
            'principals',
            'platform',
            'harness',
          ].map((n) => [n, '@agnes/base']),
        ),
        policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
      })
    },
  })
  const inventory = await manager.inventory(profileDir)
  for (const pkg of inventory.packages)
    await manager.pinRuntimeSnapshot(profileDir, {
      pinId: activeRuntimePinId({ packageId: pkg.id, integrity: pkg.entry.integrity }),
      operationId: 'test-bootstrap',
      packageId: pkg.id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: pkg.entry.integrity,
        expectedTreeIntegrity: pkg.entry.treeIntegrity ?? 'missing',
      },
    })
  let target: ReturnType<typeof rebuildDesiredFromInventory>
  for (const helper of BUNDLED_HELPERS)
    target = rebuildDesiredFromInventory({
      previous: target,
      inventory,
      packageId: helper.id,
      operation: 'enable',
    })
  const h = await createTestHost({
    dataDir: root,
    packageDirs: {
      '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)),
      '@agnes/code': fileURLToPath(new URL('../../code', import.meta.url)),
    },
    runtimePluginCatalogue: await manager.runtimePluginSnapshots(profileDir),
    extensionLoader: {
      import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    },
    disableSessionTitle: true,
    mcpManage: async (input) => {
      const result = await handler(input.sessionKey, `r${++seq}`, 'mcp-manage', input)
      if (result && typeof result === 'object' && 'proposalId' in result)
        proposalId = String(result.proposalId)
      return result
    },
    script: [
      call('mcp_manage', { action: 'prepare', definition }),
      () => call('mcp_manage', { action: 'commit', proposalId }),
      say,
      (request) => {
        const tool = request.tools.find((t) => t.name.endsWith('_echo'))
        expect(tool).toBeDefined()
        return call(tool?.name ?? 'missing', {})
      },
      say,
    ],
  })
  if (!target) throw new Error('Missing default helper target')
  await h.host.applyRuntimeTarget(decodeRuntimeTargetArtifact(target))
  expect(h.host.kernel.tools.list().filter((t) => t.name === 'mcp_manage')).toHaveLength(1)
  expect(h.host.kernel.tools.list().some((t) => t.name === 'skill_helper_create')).toBe(true)
  rows = createMcpRowRuntime({
    host: h.host,
    opener: createWorkerMcpServerOpener({
      env: {
        AGNES_RESOURCE_SNAPSHOT: store.snapshotPath('local-dev'),
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          localStartApprovals: true,
          localDaemon: true,
        }),
      },
      profile: { ...h.profile, name: 'local-dev' },
      createSecrets: () => {
        throw new Error('no credentials used')
      },
    }),
  })
  try {
    const session = await h.host.createSession({ key: 'conversation', cwd: root })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'Connect this MCP to AGH' }],
    })
    await session.run({ until: 'turn-end', signal: AbortSignal.timeout(10_000) })
    expect(permission).toHaveBeenCalledTimes(1)
    expect((await store.mcp.workerManaged('local-dev'))[0]?.desired).toBe('enabled')
    release()
    await vi.waitFor(() => expect(rows?.status('fixture')?.connectionState).toBe('ready'), {
      timeout: 10_000,
    })
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'Call its echo tool' }],
    })
    await session.run({ until: 'turn-end', signal: AbortSignal.timeout(10_000) })
    const result = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(JSON.stringify(result)).toContain('AGH_CONVERSATION_MCP_OK')
    await vi.waitFor(async () => {
      const journal = JSON.parse(
        await readFile(join(root, 'resources', 'mcp', 'local-dev.mcp.json'), 'utf8'),
      ) as { operations: { operation: { state: string } }[] }
      expect(
        journal.operations.every(({ operation }) =>
          ['succeeded', 'failed', 'cancelled'].includes(operation.state),
        ),
      ).toBe(true)
    })
    await session.close()
    await h.host.applyRuntimeTarget(
      decodeRuntimeTargetArtifact(withoutPackageRows(target, '@agnes/mcp-helper')),
    )
    expect(h.host.kernel.tools.list().some((t) => t.name === 'mcp_manage')).toBe(false)
    expect((await store.mcp.workerManaged('local-dev'))[0]?.desired).toBe('enabled')
  } finally {
    release()
    await h.host.close()
    await ep.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
    vi.unstubAllEnvs()
  }
}, 30_000)
