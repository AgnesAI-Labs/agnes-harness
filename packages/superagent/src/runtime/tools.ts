/**
 * The `orchestrator_*` tools. The plugin row registers each one; its handler reaches the running service through the
 * handle `profileRuntime.register` returned and never through Host internals, so a call while the service is not current
 * fails with the handle's `CAPABILITY_DENIED`. The service binds every call to the calling session: the main session gets
 * the main tools, a worker session the tools of its own ticket, and any other session none.
 */
import type { PluginContextFacets, ProfileManagedHandle, ToolMeta, ToolResult } from '@agnes/extension-api'
import { z } from 'zod'
import type { Store } from '../app/store.js'
import { liveTicket, type Ticket, UserError } from '../core/index.js'
import { FEISHU_READ_DESCRIPTION, FEISHU_READ_NAME, FeishuReadSchema } from './feishu-read-tool.js'
import type { SessionRegistry } from './sessions.js'
import type { Tool } from './tool.js'
import { type ExecutorToolsHost, executorTools } from './tools-executor.js'
import { type MainToolsHost, mainTools } from './tools-main.js'

export type ToolCall = { sessionId: string; toolName: string; input: unknown; signal: AbortSignal }
export type ToolAnswer = Pick<ToolResult, 'content' | 'isError'>

export interface ToolsHost {
  readonly registry: Pick<SessionRegistry, 'owner'>
  readonly store: Pick<Store, 'tickets'>
  readonly main: MainToolsHost
  readonly executor: ExecutorToolsHost
  /** Why Superagent cannot run tools now, such as during startup or before setup; undefined when it can. */
  unavailable(): string | undefined
  /** Tools other parts add, such as the Feishu read tool, for the worker of `ticket`. */
  extra?(ticket: Ticket): Tool[]
}

const failure = (text: string): ToolAnswer => ({ content: [{ type: 'text', text }], isError: true })
const problems = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')

/** The tools of the calling session, or why it has none. */
function toolsOf(host: ToolsHost, sessionId: string): Tool[] | string {
  const owner = host.registry.owner(sessionId)
  if (!owner) return 'This session is not one of Superagent sessions, so its tools do not apply here'
  if (owner.child) return 'Superagent tools belong to the main and worker sessions, not to their subagents'
  if (owner.role.kind === 'orchestrator') return mainTools(host.main, sessionId)
  const ticket = host.store.tickets.get(owner.role.ticketId)
  if (!ticket) return `The ticket ${owner.role.ticketId} of this session no longer exists`
  if (!liveTicket(ticket)) return 'Ticket ended; new work needs a new authorized ticket'
  return [...executorTools(host.executor, ticket), ...(host.extra?.(ticket) ?? [])]
}

/** Runs one call for the calling session: a refused call or an invalid input answers `isError` with the reason. */
export async function handleTool(host: ToolsHost, call: ToolCall): Promise<ToolAnswer> {
  const unavailable = host.unavailable()
  if (unavailable) return failure(unavailable)
  const tools = toolsOf(host, call.sessionId)
  if (typeof tools === 'string') return failure(tools)
  const found = tools.find((item) => item.name === call.toolName)
  if (!found) return failure(`${call.toolName} is not available to this session`)
  const input = found.schema.safeParse(call.input ?? {})
  if (!input.success) return failure(`Invalid input: ${problems(input.error)}`)
  try {
    const result = await found.execute(input.data, call.signal)
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
  } catch (error) {
    if (error instanceof z.ZodError) return failure(`Invalid input: ${problems(error)}`)
    return failure(error instanceof UserError || error instanceof Error ? error.message : String(error))
  }
}

/**
 * The worker's Feishu read tool as the row registers it; the Feishu part supplies its body for a ticket through
 * `ToolsHost.extra`, and until then a call answers that it is not available.
 */
export const FEISHU_READ: Tool = {
  name: FEISHU_READ_NAME,
  description: FEISHU_READ_DESCRIPTION,
  schema: FeishuReadSchema,
  execute: async () => {
    throw new Error('orchestrator_feishu_read is not available')
  },
}
/** Every tool the manifest declares, by name, with its schema and description; bodies need a running service. */
export function toolCatalog(): Tool[] {
  const none = undefined as never
  const placeholder = { id: '' } as Ticket
  const all = [...mainTools(none, ''), ...executorTools(none, placeholder), FEISHU_READ]
  return all.filter((item, index) => all.findIndex((other) => other.name === item.name) === index)
}
const READ_ONLY = new Set(['orchestrator_read', 'orchestrator_eval', 'orchestrator_eval_read'])
const OPEN_WORLD = new Set([
  'orchestrator_eval_read',
  'orchestrator_read',
  'orchestrator_reply',
  'orchestrator_ack',
])
export function toolMeta(name: string): ToolMeta {
  return {
    isReadOnly: READ_ONLY.has(name),
    isDestructive: false,
    isConcurrencySafe: READ_ONLY.has(name),
    isOpenWorld: OPEN_WORLD.has(name),
    replay: READ_ONLY.has(name) ? 'safe' : 'never',
    requiresApproval: 'never',
  } as ToolMeta
}

type Schema = Record<string, unknown>
const KIND = Symbol.for('TypeBox.Kind')
/** A JSON schema the tool registry validates: every node carries the TypeBox kind its keywords describe. */
export function toolParameters(schema: z.ZodType): unknown {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Schema
  return tagged(json)
}
function tagged(value: Schema): Schema {
  const union = (value.anyOf ?? value.oneOf) as Schema[] | undefined
  const type = value.type
  const kind =
    'const' in value
      ? 'Literal'
      : union
        ? 'Union'
        : typeof type === 'string'
          ? type.charAt(0).toUpperCase() + type.slice(1)
          : 'Unknown'
  const { oneOf: _oneOf, ...rest } = value
  const out: Record<string | symbol, unknown> = { ...rest, [KIND]: kind }
  if (union) out.anyOf = union.map(tagged)
  if (value.properties && typeof value.properties === 'object')
    out.properties = Object.fromEntries(
      Object.entries(value.properties as Record<string, Schema>).map(([name, child]) => [
        name,
        tagged(child),
      ]),
    )
  if (value.items && typeof value.items === 'object') out.items = tagged(value.items as Schema)
  if (value.additionalProperties && typeof value.additionalProperties === 'object')
    out.additionalProperties = tagged(value.additionalProperties as Schema)
  return out as Schema
}

/** Registers every declared tool on the plugin row; each call goes to the current service through `handle`. */
export function registerTools(
  plugin: Pick<PluginContextFacets, 'tools'>,
  handle: ProfileManagedHandle<{ handleTool(call: ToolCall): Promise<ToolAnswer> }>,
): (() => void)[] {
  return toolCatalog().map((item) =>
    plugin.tools.register({
      name: item.name,
      description: item.description,
      parameters: toolParameters(item.schema) as never,
      meta: toolMeta(item.name),
      async execute(args, ctx) {
        const service = await handle.get()
        return service.handleTool({
          sessionId: ctx.session.key,
          toolName: item.name,
          input: args,
          signal: ctx.signal,
        }) as Promise<ToolResult>
      },
    }),
  )
}
