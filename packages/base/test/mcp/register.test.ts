import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { checkToolDef, type ExtensionAPI, type ResourceEntry, type ToolDef } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALL_OUTPUT_LIMIT_BYTES } from '../../extensions/tools-core/src/guards/output.js'
import { connectMcp, MAX_MCP_REDIRECTS, type McpSdkDeps } from '../../src/mcp/connect.js'
import { mcpLocalToolPrefix } from '../../src/mcp/naming.js'
import {
  inspectRemoteCatalog,
  MAX_MCP_REMOTE_CONTENT_BLOCKS,
  MAX_MCP_TEXT_BLOCKS,
  type McpConnection,
  type McpMediaLimits,
  registerRemoteToolsStrict,
} from '../../src/mcp/register.js'
import { fakeToolContext } from '../../testkit/tool-context.js'

// Loaded via createRequire (untyped) rather than a static import: the SDK's server-side
// StreamableHTTPServerTransport/SSEServerTransport options are not exactOptionalPropertyTypes-clean,
// matching the same workaround worker-runtime's http-bootstrap fixture already uses for this exact
// SDK surface.
const require = createRequire(import.meta.url)
const { Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js')
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const modelVisibleTextBytes = (content: readonly { type: string; text?: string }[]) =>
  content.reduce(
    (total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text ?? '', 'utf8') : 0),
    0,
  )

const TEST_MEDIA_LIMITS: McpMediaLimits = Object.freeze({
  maxBytesPerImage: 2 * 1024 * 1024,
  maxPixelsPerImage: 3_000_000,
  maxAggregateBytes: 8 * 1024 * 1024,
  maxAggregatePixels: 12_000_000,
  maxImages: 4,
  maxBlocks: 8,
})

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value >>> 0)
  return bytes
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.from(data)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  return Buffer.concat([u32(payload.length), typed, u32(crc32(typed))])
}

function png(
  width: number,
  height: number,
  options: Readonly<{ ancillaryBytes?: number; inflatedExtra?: number }> = {},
): Buffer {
  const header = Buffer.concat([u32(width), u32(height), Buffer.from([1, 0, 0, 0, 0])])
  const rowBytes = Math.ceil(width / 8) + 1
  const raw = Buffer.alloc(height * rowBytes + (options.inflatedExtra ?? 0))
  const chunks = [PNG_MAGIC, pngChunk('IHDR', header)]
  if (options.ancillaryBytes) chunks.push(pngChunk('tEXt', Buffer.alloc(options.ancillaryBytes, 0x61)))
  chunks.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array()))
  return Buffer.concat(chunks)
}

const SMALL_PNG = png(1, 1)
const imageBlock = (bytes: Uint8Array, mimeType = 'image/png') => ({
  type: 'image' as const,
  data: Buffer.from(bytes).toString('base64'),
  mimeType,
})

function fakeApi() {
  const tools: ToolDef[] = []
  const resources: ResourceEntry[] = []
  const disposed: string[] = []
  const warn = vi.fn()
  return {
    api: {
      registerTool: (tool: ToolDef) => {
        tools.push(tool)
        return () => disposed.push(`tool:${tool.name}`)
      },
      registerResource: (resource: ResourceEntry) => {
        resources.push(resource)
        return () => disposed.push(`resource:${resource.id}`)
      },
      ctx: { log: { debug() {}, info() {}, warn, error() {} } },
    } as unknown as ExtensionAPI,
    disposed,
    resources,
    tools,
    warn,
  }
}

function hostileMessageError() {
  const exposedArguments: unknown[] = []
  const message = {
    replaceAll(...args: unknown[]) {
      exposedArguments.push(...args)
      return 'credential-test-marker'
    },
    toString() {
      return 'hostile message'
    },
  }
  const error = new Error('placeholder')
  Object.defineProperty(error, 'message', { value: message })
  return { error, exposedArguments }
}

const stdio = { id: 'gh', transport: 'stdio' as const, cmd: ['gh-mcp'], defer: true }
// The prefix is `mcp_gh_<hash8('gh')>_`, not the old plain `mcp_gh_` -- computed via the shared
// function rather than hardcoded, so this file does not itself become a second place a collision
// fix could silently miss (design 2026-09-23-mcp-tool-name-collision-design.md §0.4).
const GH_PREFIX = mcpLocalToolPrefix('gh')

describe('registerRemoteToolsStrict', () => {
  const connection = (): McpConnection => ({
    id: 'gh',
    async listTools() {
      return [
        {
          name: 'list_prs',
          description: 'list pull requests',
          inputSchema: {
            type: 'object',
            properties: { repo: { type: 'string' } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        { name: 'merge', description: 'merge a pull request', inputSchema: { type: 'object' } },
      ]
    },
    async callTool(name) {
      if (name === 'merge') throw new Error('boom')
      return { content: [{ type: 'text', text: `ok ${name}` }] }
    },
    async close() {},
  })

  it('gives two servers whose ids sanitize to the same string distinct tool names (the reported collision)', async () => {
    // "a.b" and "a_b" both collapsed to "a_b" under the old plain sanitizer, so both produced
    // "mcp_a_b_read" -- the second row to register would hit E_REGISTRY_DUPLICATE against the Host's
    // shared tool registry and fail entirely, non-deterministically depending on connect timing
    // (design 2026-09-23-mcp-tool-name-collision-design.md §0.2). Each row gets its own fakeApi()
    // here, matching how each MCP server is its own independent Cordis row/ExtensionAPI in production.
    const oneToolConn = (id: string): McpConnection => ({
      ...connection(),
      id,
      async listTools() {
        return [{ name: 'read', description: 'read something', inputSchema: { type: 'object' } }]
      },
    })
    const dotServer = fakeApi()
    const underscoreServer = fakeApi()
    await registerRemoteToolsStrict(dotServer.api, oneToolConn('a.b'), { ...stdio, id: 'a.b' })
    await registerRemoteToolsStrict(underscoreServer.api, oneToolConn('a_b'), { ...stdio, id: 'a_b' })

    expect(dotServer.tools).toHaveLength(1)
    expect(underscoreServer.tools).toHaveLength(1)
    expect(dotServer.tools[0]?.name).not.toBe(underscoreServer.tools[0]?.name)
  })

  it('does not reject a long server id that used to leave no room for any remote tool name', async () => {
    // The old sanitizer had no length cap of its own (unlike slugOf's 40-character cap, reused here
    // via mcpLocalToolPrefix): a long enough serverId made `prefix.length >= 64` true for every one of
    // that server's tools, so the whole server would fail to register no matter what its remote tools
    // were named.
    const longId = `server-${'x'.repeat(80)}`
    const { api, tools } = fakeApi()
    await registerRemoteToolsStrict(api, { ...connection(), id: longId }, { ...stdio, id: longId })
    expect(tools.map((tool) => tool.name)).toEqual([
      `${mcpLocalToolPrefix(longId)}list_prs`,
      `${mcpLocalToolPrefix(longId)}merge`,
    ])
  })

  it('registers prefixed tools, hint-derived metadata, and one server resource', async () => {
    const { api, resources, tools } = fakeApi()
    await registerRemoteToolsStrict(api, connection(), stdio)

    expect(tools.map((tool) => tool.name)).toEqual([`${GH_PREFIX}list_prs`, `${GH_PREFIX}merge`])
    expect(tools.every((tool) => checkToolDef(tool, { prefix: 'mcp_' }).ok)).toBe(true)
    expect(tools[0]?.meta).toMatchObject({
      deferLoading: true,
      isDestructive: false,
      isOpenWorld: true,
      isReadOnly: true,
      replay: 'safe',
    })
    expect(tools[1]?.meta).toMatchObject({
      isDestructive: true,
      isReadOnly: false,
      replay: 'never',
      requiresApproval: undefined,
    })
    expect(resources).toEqual([{ id: 'gh', kind: 'mcp', name: 'gh', description: 'MCP server gh (2 tools)' }])
  })

  it('forwards calls and converts images into artifact-backed author content', async () => {
    const conn = connection()
    conn.callTool = async (_name, args, opts) => {
      expect(args).toEqual({ repo: 'a/b' })
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      return {
        content: [{ type: 'text', text: 'ok' }, imageBlock(SMALL_PNG)],
      }
    }
    const { api, tools } = fakeApi()
    await registerRemoteToolsStrict(api, conn, stdio, { mediaLimits: TEST_MEDIA_LIMITS })
    const ctx = fakeToolContext()
    const result = await (tools[0] as ToolDef).execute({ repo: 'a/b' }, ctx)

    expect(result).toEqual({
      content: [
        { type: 'text', text: 'ok' },
        {
          type: 'image',
          ref: { sha256: expect.any(String), size: SMALL_PNG.length, mime: 'image/png' },
          mime: 'image/png',
        },
      ],
    })
    expect(ctx.calls.artifacts).toEqual([
      { bytes: new Uint8Array(SMALL_PNG), mime: 'image/png', name: undefined },
    ])
  })

  it('guards oversized remote text and rejects MIME values that cannot enter the ledger', async () => {
    const textConn = connection()
    textConn.callTool = async () => ({ content: [{ type: 'text', text: 'x'.repeat(9000) }] })
    const textState = fakeApi()
    await registerRemoteToolsStrict(textState.api, textConn, stdio)
    const ctx = fakeToolContext()
    const guarded = await (textState.tools[0] as ToolDef).execute({}, ctx)
    expect(guarded.content).toEqual([
      { type: 'text', text: expect.stringContaining('[truncated:') },
      { type: 'ref', ref: expect.any(Object), mime: 'text/plain' },
    ])
    expect(ctx.calls.artifacts).toHaveLength(1)

    const imageConn = connection()
    imageConn.callTool = async () => ({
      content: [{ type: 'image', data: 'cGl4ZWw=', mimeType: 'x'.repeat(129) }],
    })
    const imageState = fakeApi()
    await registerRemoteToolsStrict(imageState.api, imageConn, stdio, {
      mediaLimits: TEST_MEDIA_LIMITS,
    })
    await expect((imageState.tools[0] as ToolDef).execute({}, fakeToolContext())).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('invalid content') }],
    })
  })

  it('bounds a call total across many small blocks, the shape a database- or KB-backed server returns', async () => {
    // Every block here sits comfortably under the single-block limit on its own -- this is the
    // enterprise MCP shape (many database rows, many knowledge-base hits), not a crafted edge case --
    // so a per-block-only guard would let the whole 700KB response through uncut.
    const manyRowsConn = connection()
    manyRowsConn.callTool = async () => ({
      content: Array.from({ length: 100 }, (_, i) => ({
        type: 'text' as const,
        text: `row ${i} ${'x'.repeat(7000)}`,
      })),
    })
    const manyRowsState = fakeApi()
    await registerRemoteToolsStrict(manyRowsState.api, manyRowsConn, stdio)
    const ctx = fakeToolContext()
    const guarded = await (manyRowsState.tools[0] as ToolDef).execute({}, ctx)
    const total = modelVisibleTextBytes(guarded.content)
    expect(total).toBeLessThanOrEqual(CALL_OUTPUT_LIMIT_BYTES)
    // The full hundred rows are still reachable through the artifact store, not just dropped.
    expect(guarded.content.some((b) => b.type === 'ref')).toBe(true)
  })

  it.each([
    ['empty text blocks', MAX_MCP_TEXT_BLOCKS + 1, '', 'text block count exceeds remote result limit'],
    [
      'small content blocks',
      MAX_MCP_REMOTE_CONTENT_BLOCKS + 1,
      'x',
      'content block count exceeds remote result limit',
    ],
  ] as const)('rejects unbounded %s before any artifact work', async (_kind, count, text, message) => {
    const conn = connection()
    conn.callTool = async () => ({
      content: Array.from({ length: count }, () => ({ type: 'text' as const, text })),
    })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio)
    const ctx = fakeToolContext()

    await expect((state.tools[0] as ToolDef).execute({}, ctx)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining(message) }],
    })
    expect(ctx.calls.artifacts).toHaveLength(0)
  })

  it('keeps a guard-written artifact reachable when aggregate omission storage later fails', async () => {
    const conn = connection()
    conn.callTool = async () => ({
      content: [
        ...Array.from({ length: 4 }, () => ({ type: 'text' as const, text: 'x'.repeat(7000) })),
        { type: 'text' as const, text: 'y'.repeat(9000) },
      ],
    })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio)
    const ctx = fakeToolContext()
    const put = ctx.artifacts.put.bind(ctx.artifacts)
    let attempts = 0
    ctx.artifacts.put = async (bytes, meta) => {
      attempts++
      if (attempts === 2) throw new Error('omission manifest unavailable')
      return put(bytes, meta)
    }

    const result = await (state.tools[0] as ToolDef).execute({}, ctx)
    expect(attempts).toBe(2)
    expect(ctx.calls.artifacts).toHaveLength(1)
    expect(result.content.filter((block) => block.type === 'ref')).toEqual([
      {
        type: 'ref',
        ref: { sha256: expect.any(String), size: 9000, mime: 'text/plain' },
        mime: 'text/plain',
      },
    ])
  })

  it('keeps a 1456px PNG above 32 KiB even after the independent text budget is exhausted', async () => {
    const screenshot = png(1456, 909, { ancillaryBytes: CALL_OUTPUT_LIMIT_BYTES + 1024 })
    expect(screenshot.length).toBeGreaterThan(CALL_OUTPUT_LIMIT_BYTES)
    const conn = connection()
    conn.callTool = async () => ({
      content: [
        ...Array.from({ length: 100 }, (_, index) => ({
          type: 'text' as const,
          text: `row ${index} ${'x'.repeat(7000)}`,
        })),
        imageBlock(screenshot),
      ],
    })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio, { mediaLimits: TEST_MEDIA_LIMITS })
    const ctx = fakeToolContext()
    const result = await (state.tools[0] as ToolDef).execute({}, ctx)

    expect(result.isError).not.toBe(true)
    expect(modelVisibleTextBytes(result.content)).toBeLessThanOrEqual(CALL_OUTPUT_LIMIT_BYTES)
    expect(result.content).toContainEqual({
      type: 'image',
      ref: { sha256: expect.any(String), size: screenshot.length, mime: 'image/png' },
      mime: 'image/png',
    })
    expect(ctx.calls.artifacts).toContainEqual({
      bytes: new Uint8Array(screenshot),
      mime: 'image/png',
      name: undefined,
    })
  })

  it('validates every image before writing any artifact and rejects MIME, CRC, and PNG bombs', async () => {
    const cases = [
      imageBlock(SMALL_PNG, 'image/jpeg'),
      imageBlock(Buffer.from(SMALL_PNG.map((byte, index) => (index === 20 ? byte ^ 1 : byte)))),
      imageBlock(png(0, 10)),
      imageBlock(png(10, 10, { inflatedExtra: 1 })),
    ]
    for (const invalid of cases) {
      const conn = connection()
      conn.callTool = async () => ({ content: [imageBlock(SMALL_PNG), invalid] })
      const state = fakeApi()
      await registerRemoteToolsStrict(state.api, conn, stdio, { mediaLimits: TEST_MEDIA_LIMITS })
      const ctx = fakeToolContext()
      await expect((state.tools[0] as ToolDef).execute({}, ctx)).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('invalid content') }],
      })
      expect(ctx.calls.artifacts).toHaveLength(0)
    }
  })

  it.each([
    ['image count', { maxImages: 1 }, [imageBlock(SMALL_PNG), imageBlock(SMALL_PNG)]],
    ['media block count', { maxBlocks: 3 }, [imageBlock(SMALL_PNG), imageBlock(SMALL_PNG)]],
    ['per-image decoded bytes', { maxBytesPerImage: SMALL_PNG.length - 1 }, [imageBlock(SMALL_PNG)]],
    ['per-image pixels', { maxPixelsPerImage: 99 }, [imageBlock(png(10, 10))]],
    [
      'aggregate decoded bytes',
      { maxAggregateBytes: SMALL_PNG.length * 2 - 1 },
      [imageBlock(SMALL_PNG), imageBlock(SMALL_PNG)],
    ],
    ['aggregate pixels', { maxAggregatePixels: 199 }, [imageBlock(png(10, 10)), imageBlock(png(10, 10))]],
  ] as const)(
    'fails closed when the independent %s limit is exceeded',
    async (_name, mediaLimits, images) => {
      const conn = connection()
      conn.callTool = async () => ({ content: [...images] })
      const state = fakeApi()
      await registerRemoteToolsStrict(state.api, conn, stdio, {
        mediaLimits: { ...TEST_MEDIA_LIMITS, ...mediaLimits } as McpMediaLimits,
      })
      const ctx = fakeToolContext()
      await expect((state.tools[0] as ToolDef).execute({}, ctx)).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('invalid content') }],
      })
      expect(ctx.calls.artifacts).toHaveLength(0)
    },
  )

  it.each([
    'maxBytesPerImage',
    'maxPixelsPerImage',
    'maxAggregateBytes',
    'maxAggregatePixels',
    'maxImages',
    'maxBlocks',
  ] as const)('rejects a missing or invalid %s limit before registering tools', async (name) => {
    const state = fakeApi()
    await expect(
      registerRemoteToolsStrict(state.api, connection(), stdio, {
        mediaLimits: { ...TEST_MEDIA_LIMITS, [name]: 0 },
      }),
    ).rejects.toThrow(`${name} must be a positive safe integer`)
    expect(state.tools).toHaveLength(0)
  })

  it('rejects an incomplete media policy before registering tools', async () => {
    const state = fakeApi()
    const { maxBlocks: _missing, ...incomplete } = TEST_MEDIA_LIMITS
    await expect(
      registerRemoteToolsStrict(state.api, connection(), stdio, {
        mediaLimits: incomplete as McpMediaLimits,
      }),
    ).rejects.toThrow('maxBlocks must be a positive safe integer')
    expect(state.tools).toHaveLength(0)
  })

  it('safely disables images when no P0-frozen media policy is injected', async () => {
    const conn = connection()
    conn.callTool = async () => ({ content: [imageBlock(SMALL_PNG)] })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio)
    const ctx = fakeToolContext()
    await expect((state.tools[0] as ToolDef).execute({}, ctx)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('explicit media limits') }],
    })
    expect(ctx.calls.artifacts).toHaveLength(0)
  })

  it('counts each image as its actual label-plus-image provider projection', async () => {
    const conn = connection()
    conn.callTool = async () => ({ content: [imageBlock(SMALL_PNG)] })

    const rejected = fakeApi()
    await registerRemoteToolsStrict(rejected.api, conn, stdio, {
      mediaLimits: { ...TEST_MEDIA_LIMITS, maxBlocks: 1 },
    })
    await expect((rejected.tools[0] as ToolDef).execute({}, fakeToolContext())).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('label and data blocks') }],
    })

    const accepted = fakeApi()
    await registerRemoteToolsStrict(accepted.api, conn, stdio, {
      mediaLimits: { ...TEST_MEDIA_LIMITS, maxBlocks: 2 },
    })
    await expect((accepted.tools[0] as ToolDef).execute({}, fakeToolContext())).resolves.toMatchObject({
      content: [{ type: 'image' }],
    })
  })

  it('turns a call-time outage into an error result without leaking an exception', async () => {
    const { api, tools } = fakeApi()
    await registerRemoteToolsStrict(api, connection(), stdio)
    const result = await (tools[1] as ToolDef).execute({}, fakeToolContext())
    expect(result).toEqual({
      content: [{ type: 'text', text: 'mcp server gh unavailable: boom' }],
      isError: true,
    })
  })

  it('rejects a server that fails discovery and closes it before registration', async () => {
    const { api, resources, tools } = fakeApi()
    const close = vi.fn(async () => undefined)
    const conn = { ...connection(), listTools: async () => Promise.reject(new Error('down')), close }
    await expect(registerRemoteToolsStrict(api, conn, stdio)).rejects.toThrow('down')
    expect(tools).toHaveLength(0)
    expect(resources).toHaveLength(0)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('redacts resolved stdio credentials from call-time failures and content', async () => {
    const cfg = { ...stdio, env: { TOKEN: 'credential-test-marker' } }
    const active = fakeApi()
    const conn = connection()
    conn.callTool = async () => {
      throw new Error('remote echoed credential-test-marker')
    }
    await registerRemoteToolsStrict(active.api, conn, cfg)
    const result = await (active.tools[0] as ToolDef).execute({}, fakeToolContext())
    expect(JSON.stringify(result)).not.toContain('credential-test-marker')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('[REDACTED]') })

    const echoed = fakeApi()
    const echoConn = connection()
    echoConn.callTool = async () => ({
      content: [{ type: 'text', text: 'value=credential-test-marker' }],
    })
    await registerRemoteToolsStrict(echoed.api, echoConn, cfg)
    expect(JSON.stringify(await (echoed.tools[0] as ToolDef).execute({}, fakeToolContext()))).not.toContain(
      'credential-test-marker',
    )

    const artifactFailure = fakeApi()
    const artifactConn = connection()
    artifactConn.callTool = async () => ({
      content: [{ type: 'text', text: 'x'.repeat(9000) }],
    })
    await registerRemoteToolsStrict(artifactFailure.api, artifactConn, cfg)
    const guarded = await (artifactFailure.tools[0] as ToolDef).execute(
      {},
      fakeToolContext({ artifactsFail: 'backend echoed credential-test-marker' }),
    )
    expect(JSON.stringify(guarded)).not.toContain('credential-test-marker')
    expect(JSON.stringify(guarded)).toContain('[REDACTED]')

    const imageFailure = fakeApi()
    const imageConn = connection()
    imageConn.callTool = async () => ({ content: [imageBlock(SMALL_PNG)] })
    await registerRemoteToolsStrict(imageFailure.api, imageConn, cfg, {
      mediaLimits: TEST_MEDIA_LIMITS,
    })
    const imageResult = await (imageFailure.tools[0] as ToolDef).execute(
      {},
      fakeToolContext({ artifactsFail: 'backend echoed credential-test-marker' }),
    )
    expect(JSON.stringify(imageResult)).not.toContain('credential-test-marker')
  })

  it('redacts a long configured secret before guardOutput truncates an artifact error', async () => {
    const secret = `secret-start-${'q'.repeat(260)}-secret-end`
    const cfg = { ...stdio, env: { TOKEN: secret } }
    const conn = connection()
    conn.callTool = async () => ({ content: [{ type: 'text', text: 'x'.repeat(9000) }] })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, cfg)

    const result = await (state.tools[0] as ToolDef).execute(
      {},
      fakeToolContext({ artifactsFail: `backend exposed ${secret}` }),
    )
    expect(JSON.stringify(result)).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain('secret-start-')
  })

  it('keeps error reporting total when an untrusted rejection cannot be coerced', async () => {
    const conn = connection()
    conn.callTool = async () =>
      Promise.reject({
        toString() {
          throw new Error('conversion exploded')
        },
      })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio)
    await expect((state.tools[0] as ToolDef).execute({}, fakeToolContext())).resolves.toEqual({
      content: [{ type: 'text', text: 'mcp server gh unavailable: unknown failure' }],
      isError: true,
    })
  })

  it('never passes configured secrets to hostile Error.message objects', async () => {
    const cfg = { ...stdio, env: { TOKEN: 'credential-test-marker' } }

    const callFailure = hostileMessageError()
    const callConn = connection()
    callConn.callTool = async () => Promise.reject(callFailure.error)
    const callState = fakeApi()
    await registerRemoteToolsStrict(callState.api, callConn, cfg)
    const callResult = await (callState.tools[0] as ToolDef).execute({}, fakeToolContext())
    expect(callFailure.exposedArguments).toEqual([])
    expect(JSON.stringify(callResult)).not.toContain('credential-test-marker')

    const artifactFailure = hostileMessageError()
    const artifactConn = connection()
    artifactConn.callTool = async () => ({ content: [imageBlock(SMALL_PNG)] })
    const artifactState = fakeApi()
    await registerRemoteToolsStrict(artifactState.api, artifactConn, cfg, {
      mediaLimits: TEST_MEDIA_LIMITS,
    })
    const artifactCtx = fakeToolContext()
    artifactCtx.artifacts.put = async () => Promise.reject(artifactFailure.error)
    const artifactResult = await (artifactState.tools[0] as ToolDef).execute({}, artifactCtx)
    expect(artifactFailure.exposedArguments).toEqual([])
    expect(JSON.stringify(artifactResult)).not.toContain('credential-test-marker')

    const closeFailure = hostileMessageError()
    const closeState = fakeApi()
    const closeConn = connection()
    closeConn.close = async () => Promise.reject(closeFailure.error)
    const dispose = await registerRemoteToolsStrict(closeState.api, closeConn, cfg)
    dispose()
    await vi.waitFor(() => expect(closeState.warn).toHaveBeenCalledTimes(1))
    expect(closeFailure.exposedArguments).toEqual([])
    expect(JSON.stringify(closeState.warn.mock.calls)).not.toContain('credential-test-marker')
  })

  it('redacts a raw bearer token if a server error omits the Authorization prefix', async () => {
    const { api, tools } = fakeApi()
    const conn = connection()
    conn.callTool = async () => {
      throw new Error('remote echoed bearer-marker')
    }
    await registerRemoteToolsStrict(api, conn, {
      id: 'gh',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { authorization: 'Bearer bearer-marker' },
      defer: false,
    })
    const result = await (tools[0] as ToolDef).execute({}, fakeToolContext())
    expect(JSON.stringify(result)).not.toContain('bearer-marker')
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('[REDACTED]') }] })
  })

  it('rejects a malformed or colliding remote catalog before partial registration', async () => {
    const { api, resources, tools } = fakeApi()
    const conn = connection()
    conn.listTools = async () => [
      { name: 'a-b', description: '', inputSchema: { type: 'object' } },
      { name: 'a_b', description: '', inputSchema: { type: 'object' } },
    ]
    await expect(registerRemoteToolsStrict(api, conn, stdio)).rejects.toThrow('collision')
    expect(tools).toHaveLength(0)
    expect(resources).toHaveLength(0)
  })

  it('does not close a Host-owned connection when managed registration fails', async () => {
    const { api } = fakeApi()
    const close = vi.fn(async () => undefined)
    const conn = { ...connection(), close }
    const claimedNames = new Set([`${GH_PREFIX}list_prs`])
    await expect(
      registerRemoteToolsStrict(api, conn, stdio, { claimedNames, ownsConnection: false }),
    ).rejects.toThrow('duplicate MCP tool name')
    expect(close).not.toHaveBeenCalled()
  })

  it('fails closed on invalid image bytes and artifact-store failure', async () => {
    const conn = connection()
    conn.callTool = async () => ({
      content: [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }],
    })
    const first = fakeApi()
    await registerRemoteToolsStrict(first.api, conn, stdio, { mediaLimits: TEST_MEDIA_LIMITS })
    await expect((first.tools[0] as ToolDef).execute({}, fakeToolContext())).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('invalid content') }],
    })

    const second = fakeApi()
    const imageConn = connection()
    imageConn.callTool = async () => ({
      content: [imageBlock(SMALL_PNG)],
    })
    await registerRemoteToolsStrict(second.api, imageConn, stdio, {
      mediaLimits: TEST_MEDIA_LIMITS,
    })
    await expect(
      (second.tools[0] as ToolDef).execute({}, fakeToolContext({ artifactsFail: 'store down' })),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('store down') }],
    })

    const oversized = fakeApi()
    const oversizedConn = connection()
    oversizedConn.callTool = async () => ({
      content: [
        {
          type: 'image',
          data: 'A'.repeat(Math.ceil(TEST_MEDIA_LIMITS.maxBytesPerImage / 3) * 4 + 4),
          mimeType: 'image/png',
        },
      ],
    })
    await registerRemoteToolsStrict(oversized.api, oversizedConn, stdio, {
      mediaLimits: TEST_MEDIA_LIMITS,
    })
    const oversizedCtx = fakeToolContext()
    await expect((oversized.tools[0] as ToolDef).execute({}, oversizedCtx)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('byte limit') }],
    })
    expect(oversizedCtx.calls.artifacts).toHaveLength(0)
  })

  it('keeps every successful artifact write reachable when a later image write fails', async () => {
    const conn = connection()
    conn.callTool = async () => ({ content: [imageBlock(SMALL_PNG), imageBlock(SMALL_PNG)] })
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, stdio, { mediaLimits: TEST_MEDIA_LIMITS })
    const ctx = fakeToolContext()
    const put = ctx.artifacts.put.bind(ctx.artifacts)
    let writes = 0
    ctx.artifacts.put = async (bytes, meta) => {
      writes++
      if (writes === 2) throw new Error('second write failed')
      return put(bytes, meta)
    }

    const result = await (state.tools[0] as ToolDef).execute({}, ctx)
    expect(result).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: expect.stringContaining('second write failed') },
        {
          type: 'ref',
          ref: { sha256: expect.any(String), size: SMALL_PNG.length, mime: 'image/png' },
          mime: 'image/png',
        },
      ],
    })
    expect(ctx.calls.artifacts).toHaveLength(1)
  })

  it('disposes all registrations in reverse order and closes the connection once', async () => {
    const { api, disposed } = fakeApi()
    const conn = connection()
    const close = vi.fn(async () => undefined)
    conn.close = close
    const dispose = await registerRemoteToolsStrict(api, conn, stdio)
    dispose()
    dispose()
    await Promise.resolve()
    expect(disposed).toEqual([`tool:${GH_PREFIX}merge`, `tool:${GH_PREFIX}list_prs`, 'resource:gh'])
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('enforces an allow policy before registration and strict catalog health checks', async () => {
    const conn = connection()
    const cfg = { ...stdio, allowedTools: ['list_prs'] }
    expect((await inspectRemoteCatalog(conn, cfg)).tools).toHaveLength(1)
    const state = fakeApi()
    await registerRemoteToolsStrict(state.api, conn, cfg)
    expect(state.tools.map((tool) => tool.name)).toEqual([`${GH_PREFIX}list_prs`])
  })
})

describe('connectMcp', () => {
  function fakeSdk(overrides: Partial<ReturnType<typeof client>> = {}) {
    const transports: unknown[] = []
    const stdioParams: unknown[] = []
    const httpUrls: URL[] = []
    const httpInits: Array<{ headers?: Record<string, string>; fetch?: unknown } | undefined> = []
    const sseUrls: URL[] = []
    const sseInits: Array<{ requestInit?: RequestInit; fetch?: unknown } | undefined> = []
    const sdkClient = Object.assign(client(), overrides)
    const deps: McpSdkDeps = {
      createClient: () => sdkClient,
      createStdioTransport: (params) => {
        stdioParams.push(params)
        const transport = { kind: 'stdio' }
        transports.push(transport)
        return transport as never
      },
      createHttpTransport: (url, init) => {
        httpUrls.push(url)
        httpInits.push(init)
        const transport = { kind: 'http' }
        transports.push(transport)
        return transport as never
      },
      createSseTransport: (url, init) => {
        sseUrls.push(url)
        sseInits.push(init)
        const transport = { kind: 'sse' }
        transports.push(transport)
        return transport as never
      },
      defaultEnvironment: () => ({ PATH: '/safe/bin', HOME: '/safe/home' }),
    }
    return { deps, httpInits, httpUrls, sdkClient, sseInits, sseUrls, stdioParams, transports }
  }

  function client() {
    return {
      setElicitationHandler: vi.fn(),
      setToolListChangedHandler: vi.fn(),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async (_params?: { cursor?: string }) => ({
        tools: [
          {
            name: 'echo',
            description: 'echo text',
            inputSchema: { type: 'object' as const },
            annotations: { readOnlyHint: true },
          },
        ],
      })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
      close: vi.fn(async () => undefined),
    }
  }

  it('builds an unsandboxed stdio transport with safe inherited and configured environment', async () => {
    const { deps, sdkClient, stdioParams, transports } = fakeSdk()
    const conn = await connectMcp({ ...stdio, cmd: ['gh-mcp', '--stdio'], env: { TOKEN: 'resolved' } }, deps)
    expect(stdioParams).toEqual([
      {
        command: 'gh-mcp',
        args: ['--stdio'],
        env: { HOME: '/safe/home', PATH: '/safe/bin', TOKEN: 'resolved' },
      },
    ])
    expect(sdkClient.connect).toHaveBeenCalledWith(transports[0])
    expect(sdkClient.setElicitationHandler).toHaveBeenCalledOnce()
    expect(sdkClient.setElicitationHandler.mock.calls[0]?.[0]()).toEqual({ action: 'decline' })
    expect(conn.id).toBe('gh')
  })

  it('forwards the SDK tools/list_changed notification to onToolsChanged listeners, and stops after close', async () => {
    const { deps, sdkClient } = fakeSdk()
    const conn = await connectMcp({ ...stdio, cmd: ['gh-mcp', '--stdio'] }, deps)
    expect(sdkClient.setToolListChangedHandler).toHaveBeenCalledOnce()
    const fireNotification = sdkClient.setToolListChangedHandler.mock.calls[0]?.[0] as () => void

    const heard: number[] = []
    const stop = conn.onToolsChanged?.(() => heard.push(1))
    fireNotification()
    expect(heard).toEqual([1])

    // Disposing the subscription stops that listener without affecting the connection.
    stop?.()
    fireNotification()
    expect(heard).toEqual([1])

    // A notification arriving after the connection itself closed reaches no one.
    const heardAfterClose: number[] = []
    conn.onToolsChanged?.(() => heardAfterClose.push(1))
    await conn.close()
    fireNotification()
    expect(heardAfterClose).toEqual([])
  })

  it('builds the HTTP transport, follows tool-list pagination, and forwards call cancellation', async () => {
    const first = {
      tools: [{ name: 'first', inputSchema: { type: 'object' as const } }],
      nextCursor: 'next',
    }
    const second = {
      tools: [{ name: 'second', description: 'two', inputSchema: { type: 'object' as const } }],
    }
    const baseClient = client()
    baseClient.listTools = vi.fn(async (params?: { cursor?: string }) =>
      params?.cursor === 'next' ? second : first,
    ) as never
    const { deps, httpInits, httpUrls, sdkClient } = fakeSdk(baseClient)
    const conn = await connectMcp(
      { id: 'web', transport: 'http', url: 'https://example.test/mcp', defer: false },
      deps,
    )

    expect(httpUrls.map(String)).toEqual(['https://example.test/mcp'])
    expect(httpInits).toEqual([{ fetch: expect.any(Function) }])
    expect(await conn.listTools()).toEqual([
      { name: 'first', description: '', inputSchema: { type: 'object' } },
      { name: 'second', description: 'two', inputSchema: { type: 'object' } },
    ])
    expect(sdkClient.listTools).toHaveBeenNthCalledWith(1, undefined)
    expect(sdkClient.listTools).toHaveBeenNthCalledWith(2, { cursor: 'next' })

    const signal = new AbortController().signal
    expect(await conn.callTool('first', { x: 1 }, { signal })).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(sdkClient.callTool).toHaveBeenCalledWith({ name: 'first', arguments: { x: 1 } }, undefined, {
      signal,
    })
  })

  it('passes resolved HTTP credentials only to the transport request init', async () => {
    const { deps, httpInits } = fakeSdk()
    await connectMcp(
      {
        id: 'web',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: { authorization: 'Bearer marker' },
        defer: false,
      },
      deps,
    )
    expect(httpInits).toEqual([{ headers: { authorization: 'Bearer marker' }, fetch: expect.any(Function) }])
  })

  it('builds the SSE transport, passing resolved credentials into requestInit', async () => {
    const { deps, sseInits, sseUrls } = fakeSdk()
    await connectMcp(
      {
        id: 'sse-web',
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: { authorization: 'Bearer sse-marker' },
        defer: false,
      },
      deps,
    )
    expect(sseUrls.map(String)).toEqual(['https://example.test/sse'])
    expect(sseInits).toEqual([
      { requestInit: { headers: { authorization: 'Bearer sse-marker' } }, fetch: expect.any(Function) },
    ])
  })

  it('closes a partially connected client and rejects missing transport operands', async () => {
    const { deps, sdkClient } = fakeSdk({ connect: vi.fn(async () => Promise.reject(new Error('no'))) })
    await expect(connectMcp(stdio, deps)).rejects.toThrow('no')
    expect(sdkClient.close).toHaveBeenCalledTimes(1)

    const untouched = fakeSdk()
    await expect(
      connectMcp({ id: 'bad', transport: 'stdio', defer: true } as never, untouched.deps),
    ).rejects.toThrow(/cmd/)
    expect(untouched.deps.createClient).toBeTypeOf('function')
    expect(untouched.sdkClient.connect).not.toHaveBeenCalled()
  })

  it('rejects an unrecognized transport kind instead of silently connecting over Streamable HTTP', async () => {
    // connectMcp() dispatches on cfg.transport with an exhaustive switch + `never` default (mirroring
    // validateManagedTransport()'s pattern in resource-control-runtime/src/mcp.ts). A bogus 4th
    // transport value -- unreachable through the real McpServerConfig type, forced here via `as
    // never` the same way the "missing transport operands" test above does -- must be rejected, not
    // silently routed through httpTransport() the way a catch-all ternary would.
    const { deps, httpUrls, sseUrls, stdioParams } = fakeSdk()
    await expect(
      connectMcp(
        {
          id: 'unknown-transport',
          transport: 'websocket',
          url: 'https://example.test/mcp',
          defer: false,
        } as never,
        deps,
      ),
    ).rejects.toThrow(/unsupported MCP transport kind/)
    expect(httpUrls).toEqual([])
    expect(sseUrls).toEqual([])
    expect(stdioParams).toEqual([])
  })

  it('rejects unsupported MCP content instead of casting it into the author result surface', async () => {
    const { deps } = fakeSdk({
      callTool: vi.fn(async () => ({ content: [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }] })),
    } as never)
    const conn = await connectMcp(stdio, deps)
    await expect(conn.callTool('audio', {}, { signal: new AbortController().signal })).rejects.toThrow(
      /unsupported content/,
    )
  })
})

describe('connectMcp HTTP redirect handling', () => {
  const cleanup: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  function listen(server: HttpServer): Promise<string> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('missing fixture address')
        resolve(`http://127.0.0.1:${address.port}/mcp`)
      })
    })
  }
  function closeHttpServer(server: HttpServer): Promise<void> {
    server.closeAllConnections()
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }

  type CapturedRequest = {
    method?: string | undefined
    headers: Record<string, string | string[] | undefined>
  }

  /**
   * A real MCP server over Streamable HTTP: enough for `connectMcp` to complete its handshake.
   * `requests` records every request that actually reached this server, so a test can assert on
   * what a redirect hop carried (or stripped) without disturbing the body stream the SDK's own
   * server transport still needs to read.
   */
  async function startMcpServer(): Promise<{ url: string; requests: CapturedRequest[] }> {
    const mcp = new McpServer({ name: 'redirect-fixture', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await mcp.connect(transport)
    const requests: CapturedRequest[] = []
    const server = createServer((req, res) => {
      requests.push({ method: req.method, headers: { ...req.headers } })
      void transport.handleRequest(req, res)
    })
    const url = await listen(server)
    cleanup.push(async () => {
      await mcp.close()
      await closeHttpServer(server)
    })
    return { url, requests }
  }

  /** Captures every request it receives and answers a fixed, non-MCP 200 -- for tests that only
   * care what an HTTP hop carried, not about completing a real MCP handshake. */
  function startCaptureServer(): { url: Promise<string>; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = []
    const server = createServer((req, res) => {
      requests.push({ method: req.method, headers: { ...req.headers } })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    cleanup.push(() => closeHttpServer(server))
    return { url: listen(server), requests }
  }

  /** Always answers with a redirect to `location`, so every hop in a chain can be counted. */
  function startRedirectServer(location: string, status = 307): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(status, { location }).end()
    })
    cleanup.push(() => closeHttpServer(server))
    return listen(server)
  }

  /** Mirrors validateManagedTransport's HTTP branch: HTTPS anywhere, plain HTTP only on loopback. */
  const loopbackOrHttpsPolicy = (url: URL): void => {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return
    throw new Error(`redirect target ${url.href} fails the managed HTTP transport policy`)
  }

  it('follows a redirect to a target that passes the managed transport policy', async () => {
    const target = await startMcpServer()
    const redirectUrl = await startRedirectServer(target.url)
    const conn = await connectMcp(
      { id: 'redirect-ok', transport: 'http', url: redirectUrl, defer: false },
      undefined,
      { validateRedirectUrl: loopbackOrHttpsPolicy },
    )
    expect(conn.id).toBe('redirect-ok')
    expect(await conn.listTools()).toEqual([])
    await conn.close()
  })

  it('follows a cross-origin redirect but strips the credential headers before the new hop', async () => {
    // `startRedirectServer` and `startMcpServer` each listen on their own port, so this redirect
    // crosses an origin boundary even though `validateRedirectUrl` (a general host/scheme policy)
    // accepts the target -- the credential must not follow just because the host is acceptable.
    const target = await startMcpServer()
    const redirectUrl = await startRedirectServer(target.url)
    const conn = await connectMcp(
      {
        id: 'redirect-cross-origin',
        transport: 'http',
        url: redirectUrl,
        headers: { authorization: 'Bearer top-secret-token', 'x-api-key': 'top-secret-key' },
        defer: false,
      },
      undefined,
      { validateRedirectUrl: loopbackOrHttpsPolicy },
    )
    expect(conn.id).toBe('redirect-cross-origin')
    await conn.close()
    expect(target.requests.length).toBeGreaterThan(0)
    for (const request of target.requests) {
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['x-api-key']).toBeUndefined()
    }
  })

  it('strips the SDK-assigned mcp-session-id header on a cross-origin redirect too', async () => {
    // mcp-session-id never comes from `cfg.headers` -- the SDK assigns and re-sends it itself once a
    // session is established -- so it must be in the fixed cross-origin strip set, not only covered
    // by whatever custom credential header name a caller happened to configure. Stripping it means a
    // stateful session cannot continue across an origin change (the same tradeoff as a cookie not
    // following a cross-origin redirect): the connect attempt fails rather than silently leaking it.
    const mcp = new McpServer({ name: 'stateful-fixture', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    })
    await mcp.connect(transport)
    const requests: CapturedRequest[] = []
    const server = createServer((req, res) => {
      requests.push({ method: req.method, headers: { ...req.headers } })
      void transport.handleRequest(req, res)
    })
    const targetUrl = await listen(server)
    cleanup.push(async () => {
      await mcp.close()
      await closeHttpServer(server)
    })
    const redirectUrl = await startRedirectServer(targetUrl)
    await expect(
      connectMcp(
        { id: 'redirect-session-id', transport: 'http', url: redirectUrl, defer: false },
        undefined,
        {
          validateRedirectUrl: loopbackOrHttpsPolicy,
        },
      ),
    ).rejects.toThrow()
    expect(requests.length).toBeGreaterThanOrEqual(1)
    for (const request of requests) expect(request.headers['mcp-session-id']).toBeUndefined()
  })

  it('keeps the credential header on a same-origin redirect (the gateway path-rewrite case)', async () => {
    const mcp = new McpServer({ name: 'same-origin-fixture', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await mcp.connect(transport)
    const requests: Array<{
      path?: string | undefined
      headers: Record<string, string | string[] | undefined>
    }> = []
    const server = createServer((req, res) => {
      requests.push({ path: req.url, headers: { ...req.headers } })
      if (req.url === '/mcp') {
        res.writeHead(307, { location: '/mcp2' }).end()
        return
      }
      void transport.handleRequest(req, res)
    })
    const url = await listen(server)
    cleanup.push(async () => {
      await mcp.close()
      await closeHttpServer(server)
    })
    const conn = await connectMcp(
      {
        id: 'redirect-same-origin',
        transport: 'http',
        url,
        headers: { authorization: 'Bearer top-secret-token' },
        defer: false,
      },
      undefined,
      { validateRedirectUrl: loopbackOrHttpsPolicy },
    )
    expect(conn.id).toBe('redirect-same-origin')
    await conn.close()
    const postRedirectRequests = requests.filter((request) => request.path === '/mcp2')
    expect(postRedirectRequests.length).toBeGreaterThan(0)
    for (const request of postRedirectRequests)
      expect(request.headers.authorization).toBe('Bearer top-secret-token')
  })

  it('downgrades a POST to a bodyless GET when a 303 redirect is followed', async () => {
    const capture = startCaptureServer()
    const targetUrl = await capture.url
    const redirectUrl = await startRedirectServer(targetUrl, 303)
    await connectMcp({ id: 'redirect-303', transport: 'http', url: redirectUrl, defer: false }, undefined, {
      validateRedirectUrl: loopbackOrHttpsPolicy,
      connectTimeoutMs: 2_000,
    }).catch(() => undefined)
    expect(capture.requests.length).toBeGreaterThan(0)
    const request = capture.requests[0]
    expect(request?.method).toBe('GET')
    expect(request?.headers['content-length']).toBeUndefined()
    expect(request?.headers['content-type']).toBeUndefined()
  })

  /**
   * Grabs the real `fetch` `httpTransport()` builds (the `policedHttpFetch` closure under test) by
   * faking just enough of `McpSdkDeps` to capture it from `createHttpTransport`'s `init.fetch` --
   * `connect()` never touches the transport it's handed, so the fake client resolves trivially and
   * the capture is the only thing this test cares about. Lets a test drive an arbitrary HTTP method
   * (e.g. DELETE, which the real SDK only ever issues via the encapsulated `terminateSession()`, not
   * reachable through `McpConnection`'s public surface) straight at the real redirect-following logic.
   */
  async function capturedHttpFetch(
    url: string,
  ): Promise<(input: string | URL, init?: RequestInit) => Promise<Response>> {
    let captured: ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined
    const deps: McpSdkDeps = {
      createClient: () => ({
        setElicitationHandler: () => undefined,
        setToolListChangedHandler: () => undefined,
        connect: async () => undefined,
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      }),
      createStdioTransport: () => {
        throw new Error('stdio transport not used in this test')
      },
      createHttpTransport: (_url, init) => {
        captured = init?.fetch
        return { kind: 'http' } as never
      },
      createSseTransport: () => {
        throw new Error('sse transport not used in this test')
      },
      defaultEnvironment: () => ({}),
    }
    await connectMcp({ id: 'captured-fetch', transport: 'http', url, defer: false }, deps, {
      validateRedirectUrl: loopbackOrHttpsPolicy,
    })
    if (!captured) throw new Error('httpTransport did not supply a fetch implementation')
    return captured
  }

  it('downgrades a DELETE (any non-GET/HEAD method) to a bodyless GET when a 303 is followed', async () => {
    // Per the Fetch spec, 303 downgrades every method except GET/HEAD, not only POST -- the MCP SDK
    // issues DELETE for session termination, and it must be downgraded the same way POST is.
    const capture = startCaptureServer()
    const targetUrl = await capture.url
    const redirectUrl = await startRedirectServer(targetUrl, 303)
    const fetchImpl = await capturedHttpFetch(redirectUrl)
    await fetchImpl(redirectUrl, { method: 'DELETE' })
    expect(capture.requests.length).toBeGreaterThan(0)
    expect(capture.requests[0]?.method).toBe('GET')
  })

  it('preserves a DELETE across a 301 redirect (only 303 downgrades a non-POST method)', async () => {
    // Per the Fetch spec, 301/302 only downgrade a POST; a DELETE keeps its method through them.
    const capture = startCaptureServer()
    const targetUrl = await capture.url
    const redirectUrl = await startRedirectServer(targetUrl, 301)
    const fetchImpl = await capturedHttpFetch(redirectUrl)
    await fetchImpl(redirectUrl, { method: 'DELETE' })
    expect(capture.requests.length).toBeGreaterThan(0)
    expect(capture.requests[0]?.method).toBe('DELETE')
  })

  it('refuses a redirect to a target that fails the managed transport policy', async () => {
    const redirectUrl = await startRedirectServer('http://mcp.example.test/mcp')
    await expect(
      connectMcp({ id: 'redirect-bad', transport: 'http', url: redirectUrl, defer: false }, undefined, {
        validateRedirectUrl: loopbackOrHttpsPolicy,
      }),
    ).rejects.toThrow(/fails the managed HTTP transport policy/)
  })

  it('refuses any redirect when the caller supplies no redirect policy', async () => {
    const target = await startMcpServer()
    const redirectUrl = await startRedirectServer(target.url)
    await expect(
      connectMcp(
        { id: 'redirect-no-policy', transport: 'http', url: redirectUrl, defer: false },
        undefined,
        {},
      ),
    ).rejects.toThrow(/redirect/i)
  })

  it('rejects a malformed Location header with a clear error instead of an opaque URL parse failure', async () => {
    const server = createServer((_req, res) => {
      // An absolute-looking URL with an invalid host, so the WHATWG URL parser throws instead of
      // resolving it as a relative path against the base (which is lenient about almost anything).
      res.writeHead(307, { location: 'http://[not-valid/mcp' }).end()
    })
    const redirectUrl = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    await expect(
      connectMcp(
        { id: 'redirect-bad-location', transport: 'http', url: redirectUrl, defer: false },
        undefined,
        {
          validateRedirectUrl: loopbackOrHttpsPolicy,
        },
      ),
    ).rejects.toThrow(/redirect-bad-location.*invalid Location header/is)
  })

  it('does not treat a non-redirect 3xx status (e.g. 304) as a redirect to follow', async () => {
    // A reachable target that would record a request if (wrongly) followed -- proves the hop never
    // happened, rather than merely that following it failed for some unrelated network reason.
    const capture = startCaptureServer()
    const targetUrl = await capture.url
    const server = createServer((_req, res) => {
      res.writeHead(304, { location: targetUrl }).end()
    })
    const url = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    await connectMcp({ id: 'redirect-304', transport: 'http', url, defer: false }, undefined, {
      validateRedirectUrl: loopbackOrHttpsPolicy,
      connectTimeoutMs: 2_000,
    }).catch(() => undefined)
    expect(capture.requests).toEqual([])
  })

  it('fails cleanly instead of looping forever past the maximum redirect count', async () => {
    // A server that always redirects to itself: every hop passes policy, so only the hop count
    // can be what stops the loop.
    let selfUrl = ''
    const server = createServer((_req, res) => {
      res.writeHead(307, { location: selfUrl }).end()
    })
    selfUrl = await listen(server)
    cleanup.push(() => closeHttpServer(server))
    await expect(
      connectMcp({ id: 'redirect-loop', transport: 'http', url: selfUrl, defer: false }, undefined, {
        validateRedirectUrl: loopbackOrHttpsPolicy,
      }),
    ).rejects.toThrow(new RegExp(`maximum of ${MAX_MCP_REDIRECTS} HTTP redirects`))
  })
})

describe('connectMcp SSE transport', () => {
  const cleanup: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  function closeHttpServer(server: HttpServer): Promise<void> {
    server.closeAllConnections()
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }

  /** Like the HTTP describe's `listen` above, but returns the bare origin -- this fixture's real
   * paths (`/sse`, plus the SDK-assigned `/messages?sessionId=...`) are appended by its callers. */
  function listenOrigin(server: HttpServer): Promise<string> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('missing fixture address')
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
  }

  type CapturedRequest = {
    method?: string | undefined
    headers: Record<string, string | string[] | undefined>
  }

  /** Mirrors validateManagedTransport's HTTP branch: HTTPS anywhere, plain HTTP only on loopback. */
  const loopbackOrHttpsPolicy = (url: URL): void => {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return
    throw new Error(`redirect target ${url.href} fails the managed HTTP transport policy`)
  }

  /**
   * A real MCP server over the legacy SSE transport: a real `SSEServerTransport` per GET connection
   * (the SDK's own `examples/server/simpleSseServer` pattern, adapted from Express onto raw
   * `node:http` to match this file's other fixtures), with POST messages routed by the SDK-assigned
   * session id. `requests` records every request that actually reaches this server -- both the GET
   * stream and every POST message -- so a test can assert what a redirect hop carried or stripped.
   */
  async function startFixtureSseServer(): Promise<{ url: string; requests: CapturedRequest[] }> {
    const mcp = new McpServer({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
    }))
    const requests: CapturedRequest[] = []
    const sessions = new Map<string, InstanceType<typeof SSEServerTransport>>()
    const server = createServer((req, res) => {
      requests.push({ method: req.method, headers: { ...req.headers } })
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && requestUrl.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res)
        sessions.set(transport.sessionId, transport)
        transport.onclose = () => sessions.delete(transport.sessionId)
        void mcp.connect(transport)
        return
      }
      if (req.method === 'POST' && requestUrl.pathname === '/messages') {
        const transport = sessions.get(requestUrl.searchParams.get('sessionId') ?? '')
        if (!transport) {
          res.writeHead(404).end('unknown SSE session')
          return
        }
        void transport.handlePostMessage(req, res)
        return
      }
      res.writeHead(404).end()
    })
    const origin = await listenOrigin(server)
    cleanup.push(async () => {
      await mcp.close()
      await closeHttpServer(server)
    })
    return { url: `${origin}/sse`, requests }
  }

  /**
   * Redirects every request to the same path+query on `targetOrigin` -- a path-preserving reverse
   * proxy, unlike `startRedirectServer` in the HTTP describe above (whose single fixed Location works
   * only because Streamable HTTP uses one endpoint for everything). SSE needs this because the client
   * POSTs follow-up messages to a server-assigned `/messages?sessionId=...` path distinct from the
   * `/sse` stream path, and both legs must reach the real target across the same redirect hop.
   */
  async function startPathPreservingRedirectProxy(targetOrigin: string): Promise<string> {
    const server = createServer((req, res) => {
      res.writeHead(307, { location: `${targetOrigin}${req.url ?? ''}` }).end()
    })
    cleanup.push(() => closeHttpServer(server))
    const origin = await listenOrigin(server)
    return `${origin}/sse`
  }

  it('connects over SSE and lists tools', async () => {
    const fixture = await startFixtureSseServer()
    const conn = await connectMcp(
      { id: 'sse-demo', transport: 'sse', url: fixture.url, defer: false },
      undefined,
      {},
    )
    expect(conn.id).toBe('sse-demo')
    const tools = await conn.listTools()
    expect(tools.length).toBeGreaterThan(0)
    await conn.close()
  })

  it('delivers configured credentials to both the GET stream and POST messages legs', async () => {
    // The HTTP describe above has a real positive assertion that configured credentials reach the
    // wire (`request.headers.authorization` against a real server, "keeps the credential header on a
    // same-origin redirect" above). SSE only had negative assertions (cross-origin stripping below)
    // plus an object-shape assertion on what's handed to the SDK -- neither proves delivery, because
    // SSE's actual delivery path (`eventsource` + the SDK's `_commonHeaders()`) shares no code with
    // Streamable HTTP's. This closes that gap with the same same-origin, real-server pattern.
    const fixture = await startFixtureSseServer()
    const conn = await connectMcp(
      {
        id: 'sse-credentialed',
        transport: 'sse',
        url: fixture.url,
        headers: { authorization: 'Bearer sse-real-wire-token', 'x-api-key': 'sse-real-wire-key' },
        defer: false,
      },
      undefined,
      {},
    )
    expect((await conn.listTools()).length).toBeGreaterThan(0)
    await conn.close()
    const getRequests = fixture.requests.filter((request) => request.method === 'GET')
    const postRequests = fixture.requests.filter((request) => request.method === 'POST')
    expect(getRequests.length).toBeGreaterThan(0)
    expect(postRequests.length).toBeGreaterThan(0)
    for (const request of [...getRequests, ...postRequests]) {
      expect(request.headers.authorization).toBe('Bearer sse-real-wire-token')
      expect(request.headers['x-api-key']).toBe('sse-real-wire-key')
    }
  })

  it('follows a cross-origin SSE redirect but strips credential headers before the new hop', async () => {
    // Same intent as "follows a cross-origin redirect but strips the credential headers before the
    // new hop" in the HTTP describe above, retargeted at the SSE transport: this is Task 2's mandatory
    // M2 reverse-mutation proof that sseTransport() genuinely reuses policedHttpFetch rather than a
    // parallel, independently-maintained redirect/credential-safety path for SSE.
    const target = await startFixtureSseServer()
    const redirectUrl = await startPathPreservingRedirectProxy(new URL(target.url).origin)
    const conn = await connectMcp(
      {
        id: 'sse-redirect-cross-origin',
        transport: 'sse',
        url: redirectUrl,
        headers: { authorization: 'Bearer top-secret-token', 'x-api-key': 'top-secret-key' },
        defer: false,
      },
      undefined,
      { validateRedirectUrl: loopbackOrHttpsPolicy },
    )
    expect(conn.id).toBe('sse-redirect-cross-origin')
    expect((await conn.listTools()).length).toBeGreaterThan(0)
    await conn.close()
    expect(target.requests.length).toBeGreaterThan(0)
    for (const request of target.requests) {
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['x-api-key']).toBeUndefined()
    }
  })
})
