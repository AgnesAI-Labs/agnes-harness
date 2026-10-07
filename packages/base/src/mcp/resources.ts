import { defineTool, type ToolDef, type ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { guardOutput, refBlock } from '../../extensions/tools-core/src/guards/output.js'
import { mcpErrorText, redactMcpSecrets, type McpServerConfig } from './config.js'
import { mcpLocalToolPrefix } from './naming.js'
import type {
  McpConnection,
  McpRemoteResource,
  McpRemoteResourceTemplate,
  McpResourceContent,
} from './register.js'

/**
 * Suffixes after `mcpLocalToolPrefix`. They stay inside the 64-character tool-name contract even
 * when the server id slugs to the 40-character maximum (prefix length 54).
 */
export const MCP_RESOURCE_LIST_SUFFIX = 'res_list'
export const MCP_RESOURCE_TEMPLATES_SUFFIX = 'res_tpls'
export const MCP_RESOURCE_READ_SUFFIX = 'res_read'

const SUFFIXES = [
  MCP_RESOURCE_LIST_SUFFIX,
  MCP_RESOURCE_TEMPLATES_SUFFIX,
  MCP_RESOURCE_READ_SUFFIX,
] as const
export type McpResourceToolSuffix = (typeof SUFFIXES)[number]

/** One server page. A larger page is refused rather than silently truncated. */
export const MAX_MCP_RESOURCE_PAGE = 256
export const MAX_MCP_RESOURCE_CONTENTS = 32
const MAX_URI = 4096
const MAX_NAME = 256
const MAX_TEXT = 256
const MAX_MIME = 128
const MAX_BODY = 1_048_576

const readOnlyMeta = (defer: boolean) =>
  Object.freeze({
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: true,
    replay: 'safe' as const,
    costHint: Object.freeze({}),
    deferLoading: defer,
    requiresApproval: undefined,
  })

export function mcpResourceToolName(serverId: string, suffix: McpResourceToolSuffix): string {
  const name = `${mcpLocalToolPrefix(serverId)}${suffix}`
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
    throw new Error(`MCP resource tool name exceeds the tool name contract: ${name}`)
  return name
}

function bound(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new TypeError(`MCP resource ${field} is missing or too long`)
  return value
}

function optional(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`MCP resource ${field} is invalid`)
  return value.length === 0 ? undefined : value
}

function withOptional(description: string | undefined, mimeType: string | undefined) {
  return {
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  }
}

export function readRemoteResource(value: {
  uri: string
  name: string
  description?: string
  mimeType?: string
}): McpRemoteResource {
  return Object.freeze({
    uri: bound(value?.uri, MAX_URI, 'uri'),
    name: bound(value?.name, MAX_NAME, 'name'),
    ...withOptional(optional(value?.description, MAX_TEXT, 'description'), optional(value?.mimeType, MAX_MIME, 'mimeType')),
  })
}

export function readRemoteResourceTemplate(value: {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}): McpRemoteResourceTemplate {
  return Object.freeze({
    uriTemplate: bound(value?.uriTemplate, MAX_URI, 'uriTemplate'),
    name: bound(value?.name, MAX_NAME, 'name'),
    ...withOptional(optional(value?.description, MAX_TEXT, 'description'), optional(value?.mimeType, MAX_MIME, 'mimeType')),
  })
}

export function readRemoteResourceContent(value: {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}): McpResourceContent {
  const uri = bound(value?.uri, MAX_URI, 'uri')
  const mimeType = optional(value?.mimeType, MAX_MIME, 'mimeType')
  if (typeof value?.text === 'string') {
    if (value.text.length > MAX_BODY) throw new TypeError('MCP resource text exceeds Host limit')
    return Object.freeze({ uri, text: value.text, ...(mimeType ? { mimeType } : {}) })
  }
  if (typeof value?.blob === 'string') {
    if (value.blob.length > MAX_BODY) throw new TypeError('MCP resource blob exceeds Host limit')
    return Object.freeze({ uri, blob: value.blob, ...(mimeType ? { mimeType } : {}) })
  }
  throw new TypeError('MCP resource content is neither text nor blob')
}

function pageNote(
  key: 'resources' | 'resourceTemplates',
  items: readonly object[],
  nextCursor: string | undefined,
): string {
  return JSON.stringify({
    [key]: items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  })
}

function contentText(contents: readonly McpResourceContent[]): string {
  return contents
    .map((item) => {
      const mime = item.mimeType ? `\nmime: ${item.mimeType}` : ''
      if ('text' in item) return `uri: ${item.uri}${mime}\n\n${item.text}`
      return `uri: ${item.uri}${mime}\n\nblob-base64:\n${item.blob}`
    })
    .join('\n---\n')
}

type ToolCtx = Parameters<NonNullable<ToolDef['execute']>>[1]

async function present(ctx: ToolCtx, cfg: McpServerConfig, text: string): Promise<ToolResult> {
  const guarded = await guardOutput(ctx, redactMcpSecrets(text, cfg))
  const content: ToolResult['content'] = [{ type: 'text', text: redactMcpSecrets(guarded.text, cfg) }]
  if (guarded.ref) content.push(refBlock(guarded.ref))
  return { content }
}

function failure(cfg: McpServerConfig, error: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: `mcp server ${cfg.id} unavailable: ${mcpErrorText(error, cfg)}` }],
    isError: true,
  }
}

function cursorOf(cursor: string | undefined): { cursor?: string; signal?: AbortSignal } {
  return cursor && cursor.length > 0 ? { cursor } : {}
}

/**
 * Model-callable resource bridge for one server. Names that a remote tool or another registration
 * already owns are omitted; the remote tool wins. Servers that did not advertise `resources` get
 * none of these tools.
 */
export function admitMcpResourceTools(
  conn: McpConnection,
  cfg: McpServerConfig,
  taken: ReadonlySet<string>,
  onConflict: (name: string) => void,
): Readonly<{ tools: ToolDef[]; conflicts: number }> {
  if (conn.supportsResources !== true || !conn.listResources || !conn.readResource)
    return Object.freeze({ tools: [], conflicts: 0 })
  const tools: ToolDef[] = []
  let conflicts = 0
  const consider = (tool: ToolDef) => {
    if (taken.has(tool.name)) {
      conflicts += 1
      onConflict(tool.name)
      return
    }
    tools.push(tool)
  }
  consider(
    defineTool({
      name: mcpResourceToolName(cfg.id, MCP_RESOURCE_LIST_SUFFIX),
      description: `List one page of resources from MCP server ${cfg.id}. Pass nextCursor back as cursor.`,
      parameters: Type.Object(
        { cursor: Type.Optional(Type.String({ maxLength: 1024 })) },
        { additionalProperties: false },
      ),
      meta: readOnlyMeta(cfg.defer),
      async execute(args, ctx) {
        try {
          const page = await conn.listResources?.({
            ...cursorOf(args.cursor),
            signal: ctx.signal,
          })
          if (!page || !Array.isArray(page.resources)) throw new TypeError('MCP resource page is invalid')
          if (page.resources.length > MAX_MCP_RESOURCE_PAGE)
            throw new TypeError('MCP resource page exceeds Host limit')
          const items = page.resources.map((item) => readRemoteResource(item))
          return await present(ctx, cfg, pageNote('resources', items, page.nextCursor))
        } catch (error) {
          return failure(cfg, error)
        }
      },
    }),
  )
  if (conn.listResourceTemplates) {
    consider(
      defineTool({
        name: mcpResourceToolName(cfg.id, MCP_RESOURCE_TEMPLATES_SUFFIX),
        description: `List one page of resource URI templates from MCP server ${cfg.id}. Pass nextCursor back as cursor.`,
        parameters: Type.Object(
          { cursor: Type.Optional(Type.String({ maxLength: 1024 })) },
          { additionalProperties: false },
        ),
        meta: readOnlyMeta(cfg.defer),
        async execute(args, ctx) {
          try {
            const page = await conn.listResourceTemplates?.({
              ...cursorOf(args.cursor),
              signal: ctx.signal,
            })
            if (!page || !Array.isArray(page.resourceTemplates))
              throw new TypeError('MCP resource template page is invalid')
            if (page.resourceTemplates.length > MAX_MCP_RESOURCE_PAGE)
              throw new TypeError('MCP resource template page exceeds Host limit')
            const items = page.resourceTemplates.map((item) => readRemoteResourceTemplate(item))
            return await present(ctx, cfg, pageNote('resourceTemplates', items, page.nextCursor))
          } catch (error) {
            return failure(cfg, error)
          }
        },
      }),
    )
  }
  consider(
    defineTool({
      name: mcpResourceToolName(cfg.id, MCP_RESOURCE_READ_SUFFIX),
      description: `Read one resource or expanded template URI from MCP server ${cfg.id}.`,
      parameters: Type.Object(
        { uri: Type.String({ minLength: 1, maxLength: MAX_URI }) },
        { additionalProperties: false },
      ),
      meta: readOnlyMeta(cfg.defer),
      async execute(args, ctx) {
        try {
          const page = await conn.readResource?.(args.uri, { signal: ctx.signal })
          if (!page || !Array.isArray(page.contents)) throw new TypeError('MCP resource read is invalid')
          if (page.contents.length === 0 || page.contents.length > MAX_MCP_RESOURCE_CONTENTS)
            throw new TypeError('MCP resource content count exceeds Host limit')
          const contents = page.contents.map((item) => readRemoteResourceContent(item))
          return await present(ctx, cfg, contentText(contents))
        } catch (error) {
          return failure(cfg, error)
        }
      },
    }),
  )
  return Object.freeze({ tools, conflicts })
}
