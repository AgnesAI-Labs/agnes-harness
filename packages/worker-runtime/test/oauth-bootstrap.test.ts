import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bootstrapWorkerResources } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * End-to-end coverage for the oauth-bound MCP wiring added on top of http-bootstrap.test.ts's own
 * established pattern (same fixture MCP server shape, same `bootstrapWorkerResources()` entry
 * point): proves `createOAuthCredentialStore` (the new option mirroring `createSecrets`, per this
 * task's brief - "照 createSecrets 的模式") actually reaches `resolvedConfig()`'s oauth branch
 * through `packages/resource-control-worker/src/runtime-bootstrap.ts`'s wiring into
 * `createMcpResourceManager`, not just that the two pieces type-check independently in isolation.
 */

const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'oauth bootstrap fixture cleanup failed')
})

async function fixture() {
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const mcp = new Server({ name: 'worker-oauth-fixture', version: '1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await mcp.connect(transport)
  const server = createServer((req, res) => {
    headers.push({ ...req.headers })
    void transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture address')
  cleanup.push(async () => {
    await mcp.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return { url: `http://127.0.0.1:${address.port}/mcp`, headers }
}

/** Same ref format `oauth-http-handler.ts`'s (private, package-internal) `credentialRefFor`
 * produces - hardcoded here rather than imported, since worker-runtime has no dependency on
 * `@agnes/resource-control-runtime` (only on `@agnes/resource-control-worker`, which does). */
const oauthRef = (serverId: string) => `secret://mcp-oauth/${serverId}`

type StoredOAuthCredential = Readonly<{
  kind: string
  provider?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: readonly string[]
  grantId?: string
}>
type FakeStore = Readonly<{
  read(ref: string): Promise<StoredOAuthCredential | null>
  putOAuth(
    ref: string,
    value: Readonly<{
      provider: string
      accessToken: string
      refreshToken: string
      expiresAt: number
      scope: readonly string[]
      grantId: string
    }>,
  ): Promise<void>
}>

function fakeOAuthCredentialStore(
  initial: Record<string, StoredOAuthCredential>,
): FakeStore & { calls: string[] } {
  const store = new Map<string, StoredOAuthCredential>(Object.entries(initial))
  const calls: string[] = []
  return {
    calls,
    read: async (ref) => {
      calls.push(`read:${ref}`)
      return store.get(ref) ?? null
    },
    putOAuth: async (ref, value) => {
      calls.push(`putOAuth:${ref}`)
      store.set(ref, { kind: 'oauth', ...value })
    },
  }
}

async function bootstrapWithOAuth(url: string, createOAuthCredentialStore: (() => FakeStore) | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-oauth-bootstrap-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const snapshot = join(root, 'snapshot.json')
  await writeFile(
    snapshot,
    JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: { control: { desired: [], trust: [] } },
      mcp: [
        {
          definition: {
            serverId: 'fixture',
            displayName: 'Fixture',
            transport: { kind: 'http', url },
            secretBinding: { kind: 'oauth' },
            toolPolicy: { allow: [] },
          },
          revision: 'a'.repeat(64),
          desired: 'enabled',
          trust: 'trusted',
        },
      ],
    }),
  )
  const state = await bootstrapWorkerResources({
    env: {
      AGNES_RESOURCE_SNAPSHOT: snapshot,
      AGNES_RESOURCE_CONTROL: '1',
      AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
        allowedExecutables: [],
        allowLoopbackHttp: true,
        localDaemon: true,
      }),
    },
    cwd: root,
    agnesHomeDir: root,
    profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } } as never,
    createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
    createSecrets: () => {
      throw new Error('oauth-bound MCP must not use the string SecretRef resolver')
    },
    ...(createOAuthCredentialStore ? { createOAuthCredentialStore } : {}),
  })
  if (state) cleanup.push(() => state.runtime.mcp.close())
  return state
}

describe('worker resource-control-worker oauth credential wiring', () => {
  it('resolves a stored, non-expired oauth credential into a live connection with the right Authorization header', async () => {
    const server = await fixture()
    const state = await bootstrapWithOAuth(server.url, () =>
      fakeOAuthCredentialStore({
        [oauthRef('fixture')]: {
          kind: 'oauth',
          provider: 'mcp-oauth',
          accessToken: 'oauth-tok-1',
          refreshToken: 'oauth-refresh-1',
          expiresAt: Date.now() + 60_000,
          scope: [],
          grantId: 'fixture',
        },
      }),
    )
    expect(state?.mcp[0]).toMatchObject({ connectionState: 'ready' })
    expect(server.headers.length).toBeGreaterThanOrEqual(1)
    expect(server.headers.every((headers) => headers.authorization === 'Bearer oauth-tok-1')).toBe(true)
  })

  it('fails the connection (not a crash) when no createOAuthCredentialStore is configured', async () => {
    const server = await fixture()
    const state = await bootstrapWithOAuth(server.url, undefined)
    expect(state?.mcp[0]).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT' },
    })
    expect(server.headers).toEqual([])
  })

  it('never constructs the oauth credential store for a resource generation with no oauth-bound server', async () => {
    // Mirrors createSecrets's own "must not require a configured secret backend when unused"
    // contract (see stdio-bootstrap.test.ts) - the lazy-construction discipline extends to the
    // oauth store too.
    const httpBearerServer = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'agnes-oauth-bootstrap-unused-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const snapshot = join(root, 'snapshot.json')
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: { desired: [], trust: [] } },
        mcp: [
          {
            definition: {
              serverId: 'fixture',
              displayName: 'Fixture',
              transport: { kind: 'stdio', executable: process.execPath, args: ['-e', 'process.exit(0)'] },
              secretBinding: { kind: 'none' },
            },
            revision: 'a'.repeat(64),
            desired: 'disabled',
            trust: 'trusted',
          },
        ],
      }),
    )
    const state = await bootstrapWorkerResources({
      env: {
        AGNES_RESOURCE_SNAPSHOT: snapshot,
        AGNES_RESOURCE_CONTROL: '1',
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [process.execPath],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
      },
      cwd: root,
      agnesHomeDir: root,
      profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'env' } } } as never,
      createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
      createSecrets: () => {
        throw new Error('none-bound MCP must not create a secret resolver')
      },
      createOAuthCredentialStore: () => {
        throw new Error('a resource generation with no oauth-bound server must not build an oauth store')
      },
    })
    if (state) cleanup.push(() => state.runtime.mcp.close())
    // The point of this test: bootstrapWorkerResources() did not throw (the throwing
    // createOAuthCredentialStore factory above was never invoked, because the one managed server
    // in this snapshot is stdio/none-bound, not oauth-bound) and the unrelated fixture MCP server
    // never received a request either.
    expect(state?.mcp[0]?.serverId).toBe('fixture')
    expect(httpBearerServer.headers).toEqual([])
  })
})
