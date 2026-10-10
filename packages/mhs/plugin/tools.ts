/**
 * The brain's seven device tools and the per-turn snapshot, registered with Agnes (hub-api.md
 * section 15). The types below are the parts of Agnes's extension API this plugin uses.
 */
import { type TSchema, Type } from '@sinclair/typebox'
import { type Answer, type Brain, CONTEXT_LIMIT } from '../server/brain.js'

type Json = Record<string, unknown>

interface ArtifactRef {
  sha256: string
  size: number
  mime: string
}

/** The tool call context Agnes passes to execute(). */
export interface ToolCall {
  signal: AbortSignal
  session: { key: string; toolUseId: string }
  artifacts: { put(bytes: Uint8Array, meta: { mime?: string; name?: string }): Promise<ArtifactRef> }
}

type Content = { type: 'text'; text: string } | { type: 'image'; ref: ArtifactRef; mime: string }

export interface ToolDef {
  name: string
  description: string
  parameters: TSchema
  meta: {
    isReadOnly: boolean
    isDestructive: boolean
    isConcurrencySafe: boolean
    isOpenWorld: boolean
    replay: 'safe' | 'never' | 'idempotent'
    costHint: undefined
    deferLoading: boolean
    requiresApproval: 'never'
    returnsImages?: boolean
  }
  execute(args: Json, call: ToolCall): Promise<Reply>
}

/** `structured` is recorded with the result for pages (the Devices panel's cards); the model never sees it. */
type Reply = { content: Content[]; isError?: boolean; structured?: Json }

/** What ctx.extension() returns, as far as this plugin uses it. */
export interface Extension {
  registerTool(def: ToolDef): () => void
  registerHook(event: 'context', handler: () => Promise<{ additionalContext?: string }>): () => void
}

// The tools do not mark themselves open-world: that would taint the turn and bring approval prompts
// back for call_device, which device control turns off (hub-api.md 15.1).
const READS = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
} as const
const ACTS = { ...READS, isReadOnly: false, isConcurrencySafe: false, replay: 'never' } as const

const device = Type.Optional(
  Type.String({
    description: 'Device id from list_devices; may be left out only while a single device is online',
  }),
)

async function reply(answer: Answer, call: ToolCall): Promise<Reply> {
  const content: Content[] = []
  const pictures: Json[] = []
  for (const picture of answer.pictures ?? []) {
    const ref = await call.artifacts.put(picture.bytes, { mime: picture.mime, name: picture.name })
    content.push({ type: 'image', ref, mime: picture.mime })
    pictures.push({ name: picture.name, sha256: ref.sha256, size: ref.size, mime: ref.mime })
  }
  content.push({ type: 'text', text: answer.text })
  // Pages load the pictures by these references; the ledger keeps only the hash.
  const structured = answer.data && pictures.length ? { ...answer.data, pictures } : answer.data
  return {
    content,
    ...(answer.isError ? { isError: true } : {}),
    ...(structured ? { structured } : {}),
  }
}

/** Cuts text to at most `bytes` UTF-8 bytes, at a line end. */
function cap(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  let cut = text
  while (Buffer.byteLength(cut) > bytes - 40) cut = cut.slice(0, cut.lastIndexOf('\n'))
  return `${cut}\n(more devices: list_devices)`
}

export function registerBrainTools(agnes: Extension, brain: Brain): (() => void)[] {
  const tools: {
    name: string
    description: string
    parameters: TSchema
    meta: ToolDef['meta']
    run: (args: Json, call: ToolCall) => Promise<Answer> | Answer
  }[] = [
    {
      name: 'list_devices',
      description:
        'List the physical devices connected to AgnesHub: id, name, kind, whether available, health, position, what each is doing, its tools and data sources.',
      parameters: Type.Object({}),
      meta: READS,
      run: () => brain.listDevices(),
    },
    {
      name: 'read_device',
      description:
        "Read a device: its state, health and position, every tool with its exact arguments, and the state fields set_device can change. Read a device before calling a tool you have not used on it. Name `sources` to add their newest data; image sources come back as pictures. Video cannot be read; read the camera's image source instead.",
      parameters: Type.Object({ device, sources: Type.Optional(Type.Array(Type.String())) }),
      // Camera pictures reach the model only from a tool that declares them.
      meta: { ...READS, returnsImages: true },
      run: (args) => brain.readDevice(args as { device?: string; sources?: string[] }),
    },
    {
      name: 'call_device',
      description:
        "Call one of a device's own tools with its arguments, named exactly as read_device lists them (unknown names are dropped). Waits up to 50 s for the result; a longer job returns `running` with its job id, and you are woken when it ends.",
      parameters: Type.Object({
        device,
        tool: Type.String({ description: "The device's tool name" }),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments" }),
        ),
      }),
      meta: ACTS,
      run: (args, call) =>
        brain.callDevice(
          args as { device?: string; tool: string; args?: Json },
          call.session.key,
          call.signal,
          call.session.toolUseId,
        ),
    },
    {
      name: 'set_device',
      description:
        'Change a device\'s settable state fields (listed as `settable` by list_devices and with their ranges by read_device), such as a brightness, a colour or an on/off switch: {"device": "lamp-01", "values": {"brightness": 30}}. Several fields can change at once.',
      parameters: Type.Object({ device, values: Type.Record(Type.String(), Type.Unknown()) }),
      meta: ACTS,
      run: (args) => brain.setDevice(args as { device?: string; values: Json }),
    },
    {
      name: 'stop_device',
      description:
        'Stop all motion of one device at once, or of every device when `device` is left out. Always allowed.',
      parameters: Type.Object({ device }),
      meta: ACTS,
      run: (args) => brain.stopDevice(args as { device?: string }),
    },
    {
      name: 'watch_device',
      description:
        'Wait for something on a device without polling; you are woken when it happens or after `timeout` seconds (default 600, at most 3600). `until` is one of: {"state": field, "lt"|"gt"|"eq"|"ne": value}; {"source": id, "field": name, "lt"|"gt"|"eq"|"ne": value}; {"source": id, "has": label}; {"source": id, "says": words}; {"health": "ok"|"attention"|"bad"}; {"trust": "trusted"|"uncertain"|"lost"}. Only new data counts. `note` says why you wait.',
      parameters: Type.Object({
        device,
        until: Type.Record(Type.String(), Type.Unknown()),
        timeout: Type.Optional(Type.Number()),
        note: Type.Optional(Type.String()),
      }),
      meta: ACTS,
      run: (args, call) =>
        brain.watchDevice(
          args as { device?: string; until: Json; timeout?: number; note?: string },
          call.session.key,
        ),
    },
    {
      name: 'unwatch_device',
      description: 'Stop a watch set with watch_device.',
      parameters: Type.Object({ watch: Type.String() }),
      meta: ACTS,
      run: (args) => brain.unwatchDevice(args as { watch: string }),
    },
  ]
  const disposers = tools.map((tool) =>
    agnes.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      meta: tool.meta,
      async execute(args, call) {
        try {
          return await reply(await tool.run(args, call), call)
        } catch (e) {
          return {
            content: [{ type: 'text', text: `${tool.name} failed: ${(e as Error).message}` }],
            isError: true,
          }
        }
      },
    }),
  )
  // The context hook fails the model request when it throws or takes over 1.5 s, so it only reads
  // memory and never throws.
  disposers.push(
    agnes.registerHook('context', async () => {
      try {
        return { additionalContext: cap(brain.context(), CONTEXT_LIMIT) }
      } catch {
        return {}
      }
    }),
  )
  return disposers
}
