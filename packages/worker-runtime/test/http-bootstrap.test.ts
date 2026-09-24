import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bootstrapWorkerResources } from '@agnes/resource-control-worker'
import { windowsEnsurePrivateDirectorySync, windowsWritePrivateFile } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSecretsFile } from '../../host/src/adapters/secrets.js'

const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')
const secret = ['synthetic', 'http', 'credential', 'marker'].join('-')
const cleanup: Array<() => Promise<unknown>> = []
const windows = process.platform === 'win32' // guards-allow-platform: private credentials for real Windows tests.
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'HTTP fixture cleanup failed')
})

async function fixture(rejectHandshake = false) {
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const calls: unknown[] = []
  const mcp = new Server({ name: 'worker-http-fixture', version: '1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo safe input',
        inputSchema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ],
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async (request: { params: { arguments?: unknown } }) => {
    calls.push(request.params.arguments)
    return { content: [{ type: 'text', text: 'worker-http-call-result' }] }
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await mcp.connect(transport)
  const server = createServer((req, res) => {
    headers.push({ ...req.headers })
    if (rejectHandshake) {
      res.writeHead(500).end(secret)
      return
    }
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
  return { url: `http://127.0.0.1:${address.port}/mcp`, headers, calls }
}

async function bootstrap(
  url: string,
  options: {
    kind?: 'http-bearer' | 'http-header'
    credential?: string
    missing?: boolean
    resolverFails?: boolean
    headerName?: string
    snapshot?: unknown
    rawSnapshot?: string
    definitionPatch?: Record<string, unknown>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'amch-'))
  await chmod(root, 0o700)
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'secrets')
  if (windows) windowsEnsurePrivateDirectorySync(join(dir, 'fixture'))
  else await mkdir(join(dir, 'fixture'), { recursive: true, mode: 0o700 })
  if (!options.missing) {
    const token = join(dir, 'fixture', 'token')
    if (windows) await windowsWritePrivateFile(token, Buffer.from(options.credential ?? secret))
    else await writeFile(token, options.credential ?? secret, { mode: 0o600 })
  }
  const snapshot = join(root, 'snapshot.json')
  await writeFile(
    snapshot,
    options.rawSnapshot ??
      JSON.stringify(
        options.snapshot ?? {
          version: 1,
          mcpAuthority: 'resource-control',
          skills: { control: { desired: [], trust: [] } },
          mcp: [
            {
              definition: {
                serverId: 'fixture',
                displayName: 'Fixture',
                transport: { kind: 'http', url },
                secretBinding:
                  options.kind === 'http-header'
                    ? {
                        kind: 'http-header',
                        headerName: options.headerName ?? 'x-api-key',
                        credentialRef: 'secret://fixture/token',
                      }
                    : { kind: 'http-bearer', credentialRef: 'secret://fixture/token' },
                toolPolicy: { allow: ['echo'] },
                ...options.definitionPatch,
              },
              revision: 'a'.repeat(64),
              desired: 'enabled',
              trust: 'trusted',
            },
          ],
        },
      ),
  )
  if (!options.snapshot && !options.rawSnapshot)
    expect(await readFile(snapshot, 'utf8')).not.toContain(secret)
  const state = await bootstrapWorkerResources({
    env: {
      HOME: root,
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
    profile: { name: 'local', dataDir: root, adapters: { secrets: { kind: 'file', path: dir } } },
    createBarrier: () => ({ quiesce: async (_operation, publish) => publish({} as never) }),
    createSecrets: () => {
      if (options.resolverFails) throw new Error(secret)
      return createSecretsFile({ dir })
    },
  })
  if (state) cleanup.push(() => state.runtime.mcp.close())
  return state
}

describe('worker official SDK HTTP and SecretRef bootstrap', () => {
  it.each(['http-bearer', 'http-header'] as const)(
    'resolves file %s and executes tools/call through the worker connection',
    async (kind) => {
      const server = await fixture()
      const state = await bootstrap(server.url, { kind })
      expect(state?.mcp[0]).toMatchObject({ connectionState: 'ready', toolCount: 1 })
      const result = await state?.runtime
        .mcpResources()
        .list()[0]
        ?.connection.callTool('echo', { marker: 'safe-call-input' }, { signal: new AbortController().signal })
      expect(result).toMatchObject({ content: [{ text: 'worker-http-call-result' }] })
      expect(server.calls).toEqual([{ marker: 'safe-call-input' }])
      expect(server.headers.length).toBeGreaterThanOrEqual(3)
      expect(
        server.headers.every((headers) =>
          kind === 'http-bearer'
            ? headers.authorization === `Bearer ${secret}`
            : headers['x-api-key'] === secret,
        ),
      ).toBe(true)
      expect(
        JSON.stringify({ statuses: state?.mcp, descriptors: state?.runtime.mcp.list(), result }),
      ).not.toContain(secret)
    },
  )

  it.each([
    { name: 'missing ref', options: { missing: true } },
    { name: 'resolver error', options: { resolverFails: true } },
    { name: 'CRLF credential', options: { credential: `${secret}\r\ninjected: value` } },
  ])('fails closed before network for $name', async ({ options }) => {
    const server = await fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const state = await bootstrap(server.url, options)
    expect(state?.mcp[0]).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_CONNECT_FAILED' },
    })
    expect(state?.runtime.mcpResources().list()).toEqual([])
    expect(server.headers).toEqual([])
    expect(
      JSON.stringify({
        statuses: state?.mcp,
        descriptors: state?.runtime.mcp.list(),
        logs: log.mock.calls,
      }),
    ).not.toContain(secret)
  })

  it('does not echo an HTTP handshake error body containing credentials', async () => {
    const server = await fixture(true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const state = await bootstrap(server.url)
    expect(state?.mcp[0]?.connectionState).toBe('unavailable')
    expect(state?.runtime.mcpResources().list()).toEqual([])
    expect(
      JSON.stringify({ statuses: state?.mcp, descriptors: state?.runtime.mcp.list(), logs: log.mock.calls }),
    ).not.toContain(secret)
  })

  // A redirect target is re-checked with the same deployment HTTP policy the original URL already
  // passed (see connect.ts's policedHttpFetch / mcp.ts's validateManagedHttpUrl). A loopback-to-
  // loopback redirect passes that same policy here (both bootstrap() calls opt into
  // allowLoopbackHttp/localDaemon), so it is followed -- refusing every redirect outright is exactly
  // the too-strict behavior this fix replaces. But `redirect` and `target` listen on different
  // ports, i.e. different origins, so the credential must NOT follow just because the host policy
  // accepted it: policedHttpFetch strips Authorization/the custom credential header on any hop that
  // crosses an origin boundary, regardless of what the general host/scheme policy allows.
  it.each(['http-bearer', 'http-header'] as const)(
    'follows a cross-origin loopback redirect that passes policy but withholds %s credentials from it',
    async (kind) => {
      const target = await fixture()
      const redirect = createServer((_request, response) => {
        response.writeHead(307, { location: target.url }).end()
      })
      await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
      const redirectAddress = redirect.address()
      if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('missing redirect address')
      cleanup.push(async () => {
        redirect.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          redirect.close((error) => (error ? reject(error) : resolve())),
        )
      })
      const state = await bootstrap(`http://127.0.0.1:${redirectAddress.port}/mcp`, { kind })
      // The redirect is followed (the whole point of the fix) and the connection still succeeds --
      // this fixture MCP server does not itself enforce the credential -- but the target must never
      // have received it.
      expect(state?.mcp[0]).toMatchObject({ connectionState: 'ready', toolCount: 1 })
      expect(target.headers.length).toBeGreaterThanOrEqual(1)
      expect(
        target.headers.every((headers) =>
          kind === 'http-bearer' ? headers.authorization === undefined : headers['x-api-key'] === undefined,
        ),
      ).toBe(true)
      expect(JSON.stringify({ statuses: state?.mcp, headers: target.headers })).not.toContain(secret)
    },
  )

  it('downgrades a POST to a bodyless GET when a redirect is followed via 303', async () => {
    // A plain capture server, not the `fixture()` MCP server: the retried request arrives as GET,
    // which a real StreamableHTTPServerTransport treats as "open the SSE listen stream" and never
    // answers without a prior session -- exactly the HTTP-level fact this test wants to observe, but
    // it would hang the test waiting for an `initialize` response that can never arrive that way.
    const receivedMethods: Array<string | undefined> = []
    const receivedHeaders: Array<Record<string, string | string[] | undefined>> = []
    const target = createServer((request, response) => {
      receivedMethods.push(request.method)
      receivedHeaders.push({ ...request.headers })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetAddress = target.address()
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('missing target address')
    const redirect = createServer((_request, response) => {
      response.writeHead(303, { location: `http://127.0.0.1:${targetAddress.port}/mcp` }).end()
    })
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    const redirectAddress = redirect.address()
    if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('missing redirect address')
    cleanup.push(async () => {
      redirect.closeAllConnections()
      target.closeAllConnections()
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          redirect.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve()))),
      ])
    })
    await bootstrap(`http://127.0.0.1:${redirectAddress.port}/mcp`, { kind: 'http-bearer' })
    // Per the Fetch spec, a 303 always replays as GET with no body -- the target must have received
    // the retried `initialize` call that way, not as the original POST with its JSON-RPC body.
    expect(receivedMethods.length).toBeGreaterThanOrEqual(1)
    expect(receivedMethods[0]).toBe('GET')
    expect(receivedHeaders[0]?.['content-length']).toBeUndefined()
    expect(receivedHeaders[0]?.['content-type']).toBeUndefined()
  })

  it('refuses a redirect to a target that fails the deployment HTTP policy', async () => {
    const redirect = createServer((_request, response) => {
      // Not loopback and not HTTPS: fails the same check the original URL was validated against.
      response.writeHead(307, { location: 'http://mcp.example.test/mcp' }).end()
    })
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    const redirectAddress = redirect.address()
    if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('missing redirect address')
    cleanup.push(async () => {
      redirect.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        redirect.close((error) => (error ? reject(error) : resolve())),
      )
    })
    const state = await bootstrap(`http://127.0.0.1:${redirectAddress.port}/mcp`)
    expect(state?.mcp[0]).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_CONNECT_FAILED' },
    })
    expect(state?.runtime.mcpResources().list()).toEqual([])
  })

  it.each(['ftp://example.test/mcp', 'http://example.test/mcp', 'http://127.0.0.1/mcp?token=redacted'])(
    'rejects prohibited URL %s',
    async (url) => {
      if (url.startsWith('ftp:') || url.includes('?token=')) {
        await expect(bootstrap(url)).rejects.toThrow('invalid worker resource snapshot')
        return
      }
      const state = await bootstrap(url)
      expect(state?.mcp[0]?.connectionState).toBe('unavailable')
      expect(state?.runtime.mcpResources().list()).toEqual([])
      expect(JSON.stringify(state?.mcp)).not.toContain(secret)
    },
  )

  it('rejects malformed snapshot without echoing source text', async () => {
    await expect(
      bootstrap('https://example.test', { snapshot: { version: 2, injected: secret } }),
    ).rejects.toThrow('invalid worker resource snapshot')
  })
  it('normalizes malformed JSON errors so raw source is never echoed', async () => {
    let failure: unknown
    try {
      await bootstrap('https://example.test', { rawSnapshot: `{"${secret}": invalid}` })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toBe('Error: invalid worker resource snapshot')
    expect(String(failure)).not.toContain(secret)
  })

  it.each([129, 1_048_577])(
    'rejects invalid or oversized definition before transport (%i bytes displayName)',
    async (length) => {
      const server = await fixture()
      await expect(
        bootstrap(server.url, { definitionPatch: { displayName: 'x'.repeat(length) } }),
      ).rejects.toThrow('invalid worker resource snapshot')
      expect(server.headers).toEqual([])
    },
  )

  it('rejects a malformed header definition before sending credentials', async () => {
    const server = await fixture()
    await expect(
      bootstrap(server.url, { kind: 'http-header', headerName: 'invalid\r\nheader' }),
    ).rejects.toThrow('invalid worker resource snapshot')
    expect(server.headers).toEqual([])
  })

  it('reports connection refusal safely and retains no runtime connection', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture address')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const state = await bootstrap(`http://127.0.0.1:${address.port}/mcp`)
    expect(state?.mcp[0]).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_CONNECT_FAILED' },
    })
    expect(state?.runtime.mcpResources().list()).toEqual([])
    expect(JSON.stringify({ statuses: state?.mcp, descriptors: state?.runtime.mcp.list() })).not.toContain(
      secret,
    )
  })
})
