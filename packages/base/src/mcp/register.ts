import { sanitize } from '@agnes/core'
import {
  checkToolDef,
  type Disposer,
  defineTool,
  type ExtensionAPI,
  TOOL_DESCRIPTION_MAX_LENGTH,
  TOOL_PARAMETERS_MAX_BYTES,
  type ToolDef,
  type ToolResult,
} from '@agnes/extension-api'
import { inspectJsonData, type McpStatus, validateResourceControlData } from '@agnes/protocol'
import { decodeSafeImages, type SafeImage, type SafeImageLimits } from '@agnes/protocol-validation'
import {
  CALL_OUTPUT_LIMIT_BYTES,
  guardOutput,
  refBlock,
} from '../../extensions/tools-core/src/guards/output.js'
import { remoteInputSchema } from '../mcp-json-schema.js'
import type { McpServerConfig } from './config.js'
import { mcpLocalToolPrefix } from './naming.js'

export type McpRemoteTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}
type RemoteContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type RemoteToolIndexRow = { name: string; description: string; schema: string }
/** A remote tool left out of registration, and why; `name` only when it is a usable remote name. */
export type McpSkippedTool = NonNullable<McpStatus['skippedTools']>[number]
export type McpCheckedCatalog = Readonly<{
  tools: readonly McpRemoteTool[]
  skipped: readonly McpSkippedTool[]
}>

/**
 * All limits are mandatory when media is enabled. P0 has not frozen production values, so an
 * omitted policy disables MCP images instead of silently installing guessed defaults.
 * `maxBlocks` counts the provider-facing pair emitted for every selected image: one untrusted label
 * plus one image block. It is deliberately distinct from `maxImages`.
 */
export type McpMediaLimits = SafeImageLimits &
  Readonly<{
    maxImages: number
    maxBlocks: number
  }>
/** Resource catalogue work must be bounded before it becomes a Host generation. */
export const MAX_MCP_CATALOG_TOOLS = 1_000
/** Byte budgets cannot bound empty blocks, so remote result shape has independent cardinality caps. */
export const MAX_MCP_REMOTE_CONTENT_BLOCKS = 256
export const MAX_MCP_TEXT_BLOCKS = 128

export type McpConnection = {
  id: string
  listTools(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpRemoteTool[]>
  callTool(
    name: string,
    args: unknown,
    opts: { signal: AbortSignal },
  ): Promise<{ content: RemoteContent[]; isError?: boolean }>
  close(): Promise<void>
  /** Reports an unexpected transport close/error; disposal stops the subscription. */
  onClose?(listener: () => void): () => void
  /** Reports the server's `notifications/tools/list_changed`; disposal stops the subscription. */
  onToolsChanged?(listener: () => void): () => void
}

const secretValues = (cfg: McpServerConfig): string[] =>
  [...Object.values(cfg.env ?? {}), ...Object.values(cfg.headers ?? {})]
    .flatMap((value) => (value.startsWith('Bearer ') ? [value, value.slice('Bearer '.length)] : [value]))
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)

const redactSecrets = (value: string, cfg: McpServerConfig): string => {
  let redacted = value
  for (const secret of secretValues(cfg)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

const errorText = (error: unknown, cfg?: McpServerConfig): string => {
  let message = 'unknown failure'
  try {
    // `Error.message` is only typed as a string; an untrusted realm can replace it with an object.
    // Own the primitive before redaction so a hostile `replaceAll` never receives configured secrets.
    message = String(error instanceof Error ? error.message : error)
  } catch {
    // Untrusted transports may reject with objects whose coercion throws. Error reporting must stay total.
  }
  if (cfg) message = redactSecrets(message, cfg)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1024)
}

function localName(serverId: string, remoteName: string): string {
  const remote = remoteName.replace(/[^A-Za-z0-9_]/g, '_')
  const prefix = mcpLocalToolPrefix(serverId)
  if (!remote || prefix.length >= 64) throw new Error(`invalid remote tool name: ${remoteName}`)
  return `${prefix}${remote.slice(0, 64 - prefix.length)}`
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function resolveMediaLimits(input?: McpMediaLimits): McpMediaLimits | undefined {
  if (input === undefined) return undefined
  return Object.freeze({
    maxBytesPerImage: positiveLimit(input.maxBytesPerImage, 'maxBytesPerImage'),
    maxPixelsPerImage: positiveLimit(input.maxPixelsPerImage, 'maxPixelsPerImage'),
    maxAggregateBytes: positiveLimit(input.maxAggregateBytes, 'maxAggregateBytes'),
    maxAggregatePixels: positiveLimit(input.maxAggregatePixels, 'maxAggregatePixels'),
    maxImages: positiveLimit(input.maxImages, 'maxImages'),
    maxBlocks: positiveLimit(input.maxBlocks, 'maxBlocks'),
  })
}

type PreparedContent =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'image'; image: SafeImage }>

type OutputPiece =
  | Readonly<{ kind: 'text'; blocks: ToolResult['content']; bytes: number }>
  | Readonly<{ kind: 'image'; block: ToolResult['content'][number] }>

type RefBlock = ReturnType<typeof refBlock>

function includePersistedRefs(
  content: ToolResult['content'],
  persisted: ReadonlyMap<string, RefBlock>,
): void {
  const reachable = new Set(
    content.flatMap((block) => (block.type === 'ref' || block.type === 'image' ? [block.ref.sha256] : [])),
  )
  for (const [sha256, block] of persisted) {
    if (reachable.has(sha256)) continue
    content.push(block)
    reachable.add(sha256)
  }
}

function guardedArtifactContext(
  ctx: Parameters<typeof guardOutput>[0],
  cfg: McpServerConfig,
  persisted: Map<string, RefBlock>,
): Parameters<typeof guardOutput>[0] {
  const artifacts = Object.create(ctx.artifacts) as typeof ctx.artifacts
  Object.defineProperty(artifacts, 'put', {
    enumerable: true,
    async value(
      bytes: Parameters<typeof ctx.artifacts.put>[0],
      meta: Parameters<typeof ctx.artifacts.put>[1],
    ) {
      try {
        const ref = await ctx.artifacts.put(bytes, meta)
        persisted.set(ref.sha256, refBlock(ref, meta?.mime))
        return ref
      } catch (error) {
        // guardOutput truncates backend messages before returning them. Redact here first so a
        // configured secret longer than that truncation cannot survive as an unmatched prefix.
        throw new Error(errorText(error, cfg))
      }
    },
  })
  const guarded = Object.create(ctx) as Parameters<typeof guardOutput>[0]
  Object.defineProperty(guarded, 'artifacts', { enumerable: true, value: artifacts })
  return guarded
}

function prepareContent(
  content: readonly RemoteContent[],
  cfg: McpServerConfig,
  limits: McpMediaLimits | undefined,
): readonly PreparedContent[] {
  if (content.length > MAX_MCP_REMOTE_CONTENT_BLOCKS)
    throw new Error('content block count exceeds remote result limit')
  const images: Array<{ data: string; mimeType: string }> = []
  const kinds: Array<{ kind: 'text'; text: string } | { kind: 'image' }> = []
  let textBlocks = 0
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      textBlocks++
      if (textBlocks > MAX_MCP_TEXT_BLOCKS) throw new Error('text block count exceeds remote result limit')
      kinds.push({ kind: 'text', text: redactSecrets(item.text, cfg) })
    } else if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      images.push({ data: item.data, mimeType: item.mimeType })
      kinds.push({ kind: 'image' })
    } else throw new Error('unsupported content block')
  }
  if (images.length > 0 && limits === undefined)
    throw new Error('image content is disabled until explicit media limits are configured')
  if (!limits) return kinds as readonly PreparedContent[]
  if (images.length > limits.maxImages) throw new Error('image count exceeds media limit')
  if (images.length > Math.floor(limits.maxBlocks / 2))
    throw new Error('image label and data blocks exceed media block limit')
  const decoded = decodeSafeImages(images, limits)
  let imageIndex = 0
  return kinds.map((item): PreparedContent => {
    if (item.kind === 'text') return item
    const image = decoded[imageIndex++]
    if (!image) throw new Error('decoded image count mismatch')
    return { kind: 'image', image }
  })
}

async function storeOmittedTextSet(
  ctx: Parameters<typeof guardOutput>[0],
  texts: readonly string[],
): Promise<Readonly<{ note: string; ref?: ReturnType<typeof refBlock> }>> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(texts.map((text) => ({ kind: 'text', text }))))
    const artifact = await ctx.artifacts.put(bytes, { mime: 'application/json' })
    return {
      note: `full text set stored as artifact ${artifact.sha256.slice(0, 12)}`,
      ref: refBlock(artifact),
    }
  } catch {
    return { note: 'full text set could not be stored' }
  }
}

function remoteDefinition(
  conn: McpConnection,
  cfg: McpServerConfig,
  remote: McpRemoteTool,
  mediaLimits?: McpMediaLimits,
): ToolDef {
  const readOnly = remote.annotations?.readOnlyHint === true
  const name = localName(cfg.id, remote.name)
  return defineTool({
    name,
    description: redactSecrets(remote.description || remote.name, cfg),
    parameters: remoteInputSchema(remote.inputSchema),
    meta: {
      isReadOnly: readOnly,
      isDestructive: !readOnly,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: readOnly ? 'safe' : 'never',
      costHint: {},
      deferLoading: cfg.defer,
      requiresApproval: undefined,
    },
    async execute(args, ctx): Promise<ToolResult> {
      let result: Awaited<ReturnType<McpConnection['callTool']>>
      try {
        result = await conn.callTool(remote.name, args, { signal: ctx.signal })
      } catch (error) {
        return {
          content: [{ type: 'text', text: `mcp server ${cfg.id} unavailable: ${errorText(error, cfg)}` }],
          isError: true,
        }
      }
      const persistedRefs = new Map<string, RefBlock>()
      const guardedCtx = guardedArtifactContext(ctx, cfg, persistedRefs)
      try {
        if (!Array.isArray(result.content)) throw new Error('content is not an array')
        // Validate the entire untrusted media set before the first artifact write. A valid leading
        // image followed by a malformed/bomb image must fail closed without publishing a partial set.
        const prepared = prepareContent(result.content, cfg, mediaLimits)
        const pieces: OutputPiece[] = []
        const allTexts = prepared.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
        // Text and media have independent budgets. Do not predict Core's resource-link rendering
        // here: that would duplicate a cross-package wire contract and can drift silently.
        let remainingTextBytes = CALL_OUTPUT_LIMIT_BYTES
        let textExhausted = false
        let omittedTexts = 0
        for (const item of prepared) {
          if (item.kind === 'image') {
            const ref = await guardedCtx.artifacts.put(item.image.bytes, { mime: item.image.mime })
            pieces.push({ kind: 'image', block: { type: 'image', ref, mime: item.image.mime } })
            continue
          }
          if (textExhausted) {
            omittedTexts++
            continue
          }
          // Text keeps the existing per-block and aggregate 32 KiB contracts. Media is guarded by
          // its own count/bytes/pixels/block limits and therefore never spends this text budget.
          const guarded = await guardOutput(guardedCtx, item.text)
          // guardOutput can include an artifact backend failure in its fallback text, so redact again
          // after it returns and charge the actual post-redaction bytes exposed to the model.
          const guardedText = redactSecrets(guarded.text, cfg)
          const cost = new TextEncoder().encode(guardedText).byteLength
          if (cost > remainingTextBytes) {
            textExhausted = true
            omittedTexts++
            continue
          }
          const blocks: ToolResult['content'] = [{ type: 'text', text: guardedText }]
          if (guarded.ref) {
            const block = refBlock(guarded.ref)
            blocks.push(block)
          }
          pieces.push({ kind: 'text', blocks, bytes: cost })
          remainingTextBytes -= cost
        }
        const content: ToolResult['content'] = []
        let omittedNote: Readonly<{ text: string; ref?: ReturnType<typeof refBlock> }> | undefined
        if (omittedTexts > 0) {
          const stored = await storeOmittedTextSet(guardedCtx, allTexts)
          const note = () =>
            `\n[omitted ${omittedTexts} of ${allTexts.length} text content blocks: over the ${CALL_OUTPUT_LIMIT_BYTES}-byte call limit; ${stored.note}]\n`
          // The omission note is itself text. Reclaim the latest admitted text blocks until the
          // complete returned text (including that note) remains inside the same 32 KiB budget.
          const noteCost = () => new TextEncoder().encode(note()).byteLength
          while (noteCost() > remainingTextBytes) {
            const index = pieces.findLastIndex((piece) => piece.kind === 'text')
            if (index < 0) break
            const [removed] = pieces.splice(index, 1)
            if (removed?.kind !== 'text') throw new Error('text budget bookkeeping mismatch')
            remainingTextBytes += removed.bytes
            omittedTexts++
          }
          omittedNote = stored.ref ? { text: note(), ref: stored.ref } : { text: note() }
        }
        for (const piece of pieces)
          if (piece.kind === 'text') content.push(...piece.blocks)
          else content.push(piece.block)
        if (omittedNote) {
          content.push({ type: 'text', text: omittedNote.text })
          if (omittedNote.ref) content.push(omittedNote.ref)
        }
        includePersistedRefs(content, persistedRefs)
        return result.isError === true ? { content, isError: true } : { content }
      } catch (error) {
        const content: ToolResult['content'] = [
          { type: 'text', text: `mcp server ${cfg.id} returned invalid content: ${errorText(error, cfg)}` },
        ]
        includePersistedRefs(content, persistedRefs)
        return {
          content,
          isError: true,
        }
      }
    },
  })
}

/**
 * Why one remote tool cannot be shown to a model, or undefined when it can. An admitted tool passes
 * the checks Core's registry and the protocol `McpTool` shape apply, so registering it cannot fail.
 */
function mcpToolProblem(
  conn: McpConnection,
  cfg: McpServerConfig,
  tool: McpRemoteTool,
): McpSkippedTool['code'] | undefined {
  if (typeof tool?.name !== 'string' || !tool.name || typeof tool.description !== 'string') return 'malformed'
  if (tool.name.length > 128) return 'invalid-name'
  try {
    localName(cfg.id, tool.name)
  } catch {
    return 'invalid-name'
  }
  const inspected = inspectJsonData(tool.inputSchema, TOOL_PARAMETERS_MAX_BYTES)
  if (!inspected.ok) return inspected.reason.startsWith('size ') ? 'schema-too-large' : 'invalid-schema'
  let definition: ToolDef
  try {
    definition = remoteDefinition(conn, cfg, tool)
  } catch {
    return 'invalid-schema'
  }
  const checked = checkToolDef(definition, { prefix: 'mcp_' })
  const problems = checked.ok ? [] : checked.problems
  if (problems.some((p) => p.startsWith('parameters: serialized size'))) return 'schema-too-large'
  if (problems.some((p) => p.startsWith('parameters:'))) return 'invalid-schema'
  if (
    tool.description.length > TOOL_DESCRIPTION_MAX_LENGTH ||
    problems.some((p) => p.startsWith('description:')) ||
    sanitize(definition.description).length > TOOL_DESCRIPTION_MAX_LENGTH
  )
    return 'description-too-long'
  if (problems.length) return 'malformed'
  const shape = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
  return validateResourceControlData('McpTool', shape).ok ? undefined : 'invalid-schema'
}

/**
 * Splits a catalog already obtained during Host candidate health checks into the tools a model can be
 * shown and the ones skipped with a reason. Only catalog-level faults throw: a connection id that
 * does not match, too many tools, or two admitted tools sharing a local name.
 */
export function validateRemoteCatalog(
  conn: McpConnection,
  cfg: McpServerConfig,
  remote: readonly McpRemoteTool[],
): McpCheckedCatalog {
  if (conn.id !== cfg.id) throw new Error(`connection id ${conn.id} does not match config id ${cfg.id}`)
  if (remote.length > MAX_MCP_CATALOG_TOOLS) throw new Error('MCP tool catalog exceeds Host limit')
  const allowed = cfg.allowedTools === undefined ? undefined : new Set(cfg.allowedTools)
  const accepted =
    allowed === undefined
      ? remote
      : remote.filter((tool) => typeof tool?.name === 'string' && allowed.has(tool.name))
  const names = new Set<string>()
  const tools: McpRemoteTool[] = []
  const skipped: McpSkippedTool[] = []
  for (const tool of accepted) {
    const code = mcpToolProblem(conn, cfg, tool)
    if (code) {
      const name: unknown = tool?.name
      skipped.push(typeof name === 'string' && name && name.length <= 128 ? { code, name } : { code })
      continue
    }
    const local = localName(cfg.id, tool.name)
    if (names.has(local)) throw new Error(`remote tool name collision: ${local}`)
    names.add(local)
    tools.push(tool)
  }
  return Object.freeze({ tools: Object.freeze(tools), skipped: Object.freeze(skipped) })
}

/**
 * Performs the same strict catalog validation used for registration. Host lifecycle code calls this
 * before activation so a failed candidate is observable instead of becoming an empty disposer.
 */
export async function inspectRemoteCatalog(
  conn: McpConnection,
  cfg: McpServerConfig,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<McpCheckedCatalog> {
  const remote = await conn.listTools(options)
  if (!Array.isArray(remote)) throw new Error('tool catalog is not an array')
  return validateRemoteCatalog(conn, cfg, remote)
}

/**
 * Strict registration: every connection/catalog/duplicate failure rejects after undoing partial
 * registration and closing its connection when this extension owns it.
 */
export async function registerRemoteToolsStrict(
  agnes: ExtensionAPI,
  conn: McpConnection,
  cfg: McpServerConfig,
  opts: {
    onCatalog?: (rows: RemoteToolIndexRow[]) => void
    /** The admitted (`allowedTools`-filtered) remote catalog and the tools skipped from it,
     *  unconditionally - unlike `onCatalog`, never gated by `cfg.defer`. Lets a caller compute
     *  status/health info independent of whether this server's tools are eagerly disclosed or
     *  deferred to `tool_search`. */
    onRemoteCatalog?: (remote: readonly McpRemoteTool[], skipped: readonly McpSkippedTool[]) => void
    claimedNames?: Set<string>
    catalog?: readonly McpRemoteTool[]
    /**
     * A Host resource manager owns its connection generation. Registration only owns registry
     * disposers in that mode: a failed new extension generation must never close either the
     * candidate connection or an old generation retained by the Host.
     */
    ownsConnection?: boolean
    /** Explicit trusted policy; omission safely disables media until P0 freezes production caps. */
    mediaLimits?: McpMediaLimits
  } = {},
): Promise<Disposer> {
  const disposers: Disposer[] = []
  try {
    const { tools: remote, skipped } =
      opts.catalog === undefined
        ? await inspectRemoteCatalog(conn, cfg)
        : validateRemoteCatalog(conn, cfg, opts.catalog)
    opts.onRemoteCatalog?.(remote, skipped)
    const mediaLimits = resolveMediaLimits(opts.mediaLimits)
    const definitions = remote.map((tool) => remoteDefinition(conn, cfg, tool, mediaLimits))
    const duplicate = definitions.find((definition) => opts.claimedNames?.has(definition.name))
    if (duplicate) throw new Error(`duplicate MCP tool name: ${duplicate.name}`)
    const catalog = definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      schema: JSON.stringify(definition.parameters),
    }))
    disposers.push(
      agnes.registerResource({
        id: cfg.id,
        kind: 'mcp',
        name: cfg.id,
        description: `MCP server ${cfg.id} (${definitions.length} tools)`,
      }),
    )
    for (const definition of definitions) disposers.push(agnes.registerTool(definition))
    // `tool_search` discovers only tools omitted from the default disclosure. Eager MCP tools
    // are already offered directly in every request and must not be duplicated in that index.
    if (cfg.defer) opts.onCatalog?.(catalog)
    for (const definition of definitions) opts.claimedNames?.add(definition.name)
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    if (opts.ownsConnection !== false) await conn.close().catch(() => undefined)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    if (opts.ownsConnection !== false)
      void conn.close().catch((error) =>
        agnes.ctx.log.warn('MCP connection did not close cleanly', {
          id: cfg.id,
          message: errorText(error, cfg),
        }),
      )
  }
}
