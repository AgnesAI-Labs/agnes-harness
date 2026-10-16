import type { PluginContextFacets, ToolContext, ToolDef, ToolMeta, ToolResult } from '@agnes/extension-api'
import { MhsError, object } from '@agnes/mhs-device'
import { type Invocation, type North, resultSummary, type WakeTarget } from '@agnes/mhs-hub'
import { Type } from '@sinclair/typebox'
import { mhsContext } from './context.js'

/** A connector is profile-owned; session plugin instances must never create their own Hub. */
export interface MhsConnector {
  north: North | (() => Promise<North>)
  invocation(ctx: ToolContext, method?: string, input?: Record<string, unknown>): Promise<Invocation>
  bindWake(ctx: ToolContext): Promise<WakeTarget>
}
const READ: ToolMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: true,
  replay: 'safe',
  requiresApproval: 'never',
}
const WRITE: ToolMeta = {
  ...READ,
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: true,
  replay: 'never',
  requiresApproval: 'always',
}
const device = Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' }))
const anyObject = Type.Record(Type.String(), Type.Unknown())
const params = {
  list_devices: Type.Object({}, { additionalProperties: false }),
  read_device: Type.Object(
    {
      device,
      sources: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
      since: Type.Optional(Type.Number()),
      history: Type.Optional(Type.Boolean()),
      cursor: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    },
    { additionalProperties: false },
  ),
  call_device: Type.Object(
    { device, tool: Type.String(), args: Type.Optional(anyObject) },
    { additionalProperties: false },
  ),
  set_device: Type.Object({ device, values: anyObject }, { additionalProperties: false }),
  stop_device: Type.Object({ device }, { additionalProperties: false }),
  watch_device: Type.Object(
    {
      device,
      until: anyObject,
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600 })),
      note: Type.Optional(Type.String({ maxLength: 1024 })),
    },
    { additionalProperties: false },
  ),
  unwatch_device: Type.Object({ watch: Type.String() }, { additionalProperties: false }),
}
const descriptions = {
  list_devices: 'List connected and offline devices, health, capabilities and availability.',
  read_device:
    'Read a device and its exact tools and state. Optional sources return current observations and validated still images. Video is never model input.',
  call_device:
    'Run a declared device tool under native approval. Long tasks return an operation id and notify this session/lane on completion. Never retry unknown motion.',
  set_device: 'Change declared writable settings under native approval. Settings must not initiate motion.',
  stop_device:
    'Stop manual and agent motion on one device, or every device when omitted. Read the stop receipt; unknown is not confirmed stopped.',
  watch_device:
    'Watch new device state or observations without polling. Receives a durable notification in this session/lane on condition or timeout.',
  unwatch_device: 'Cancel a watch owned by this session and wake binding.',
}
function textResult(value: unknown, summary = resultSummary(value)): ToolResult {
  const outcome =
    value && typeof value === 'object' ? (value as { outcome?: { status?: string } }).outcome : undefined
  return {
    ...(outcome?.status && ['error', 'interrupted', 'rejected', 'unknown'].includes(outcome.status)
      ? { isError: true }
      : {}),
    content: [{ type: 'text', text: summary }],
    structured: value,
  }
}
export function createMhsTools(connector: MhsConnector): ToolDef[] {
  return Object.entries(params).map(([name, parameters]) => ({
    name,
    parameters,
    description: descriptions[name as keyof typeof descriptions],
    meta:
      name === 'list_devices' || name === 'read_device'
        ? READ
        : name === 'call_device' || name === 'set_device'
          ? WRITE
          : { ...READ, isReadOnly: false, replay: 'idempotent', isConcurrencySafe: false },
    async execute(input, ctx) {
      const args = object(input)
      try {
        ctx.signal.throwIfAborted()
        const north = typeof connector.north === 'function' ? await connector.north() : connector.north
        if (name === 'list_devices') {
          const devices = await north.hub.list()
          return textResult(devices, await north.hub.summarizeDevices(devices))
        }
        if (name === 'read_device') {
          const read = await north.hub.read(
            typeof args.device === 'string' ? args.device : undefined,
            Array.isArray(args.sources) ? args.sources.map(String) : [],
            {
              signal: ctx.signal,
              ...(typeof args.since === 'number' ? { since: args.since } : {}),
              ...(args.history === true ? { history: true } : {}),
              ...(typeof args.cursor === 'number' ? { cursor: args.cursor } : {}),
              ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            },
          )
          const content: ToolResult['content'] = []
          for (const item of read.items) {
            if (!item.bytes) continue
            if (!ctx.session.imageInput || !ctx.session.imageInputPolicy)
              throw new MhsError('image-input-unavailable')
            const policy = await ctx.session.imageInputPolicy()
            if (!policy.supported) throw new MhsError('model-image-input-unsupported')
            if (
              item.bytes.byteLength > policy.maxBytes ||
              !['image/png', 'image/jpeg'].includes(item.mime ?? '')
            )
              throw new MhsError('invalid-image')
            const image = await ctx.session.imageInput({
              bytes: item.bytes,
              mimeType: item.mime as 'image/png' | 'image/jpeg',
              name: `${read.device.id}-${item.source}`,
            })
            if (image.isError) return image
            content.push(...image.content)
          }
          const safe = { ...read, items: read.items.map(({ bytes: _bytes, ...item }) => item) }
          return {
            content: [
              ...content,
              ...textResult(
                safe,
                await north.hub.summarizeRead(read, typeof args.since === 'number' ? args.since : undefined),
              ).content,
            ],
            structured: safe,
          }
        }
        const invocation = await connector.invocation(ctx, name, args)
        // Binding comes from the authorized current invocation, not a supplied session id.
        if (name === 'call_device' || name === 'watch_device' || name === 'unwatch_device')
          invocation.target = await connector.bindWake(ctx)
        const method = {
          call_device: 'call',
          set_device: 'set',
          stop_device: 'stop',
          watch_device: 'watch',
          unwatch_device: 'unwatch',
        }[name]
        if (!method) throw new MhsError('unknown-tool')
        const value = await north.effect(method, object(args), invocation)
        if (name === 'call_device') {
          try {
            return textResult(
              await north.hub.waitOperation(
                invocation.operationId,
                ctx.signal,
                Math.min(ctx.timeoutMs ?? 50_000, 50_000),
              ),
            )
          } catch (error) {
            await north.hub.stop(typeof args.device === 'string' ? args.device : undefined)
            throw error
          }
        }
        return textResult(value)
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `MHS: ${error instanceof MhsError ? error.code : 'operation-failed'}` },
          ],
          isError: true,
        }
      }
    },
  }))
}
export function registerMhsTools(
  ctx: Pick<PluginContextFacets, 'tools' | 'hooks'>,
  connector: MhsConnector,
): void {
  for (const tool of createMhsTools(connector)) ctx.tools.register(tool)
  ctx.hooks.register('context', async () => {
    try {
      const north = typeof connector.north === 'function' ? await connector.north() : connector.north
      const views = await north.hub.list()
      const text = mhsContext(await north.hub.maps(), views)
      return { additionalContext: text }
    } catch {
      return {}
    }
  })
}
