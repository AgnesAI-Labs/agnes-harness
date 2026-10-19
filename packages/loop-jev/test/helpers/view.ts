import type { LoopToolMeta, LoopTurnView } from '@agnes/extension-api'
import type { JsonObject } from '../../src/types.js'

const path = { type: 'string', minLength: 1, maxLength: 4096 }
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})
const empty = (): JsonObject => object({})

/** JSON Schemas with the same fields as the built-in tools' parameters. */
export const BUILTIN_SCHEMAS: Record<string, JsonObject> = {
  ls: object({ path, limit: { type: 'integer', minimum: 1, maximum: 5000 } }),
  read: object(
    {
      path,
      save_to: path,
      max_edge: { type: 'integer', minimum: 8, maximum: 1456 },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 },
    },
    ['path'],
  ),
  grep: object(
    {
      pattern: { type: 'string', minLength: 1 },
      path,
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean' },
      literal: { type: 'boolean' },
      context: { type: 'integer', minimum: 0, maximum: 10 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    ['pattern'],
  ),
  find: object(
    {
      pattern: { type: 'string', minLength: 1 },
      path,
      limit: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    ['pattern'],
  ),
  write: object({ path, content: { type: 'string' } }, ['path', 'content']),
  edit: object(
    {
      path,
      edits: {
        type: 'array',
        minItems: 1,
        items: object({ oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, [
          'oldText',
          'newText',
        ]),
      },
    },
    ['path', 'edits'],
  ),
  shell: object(
    {
      command: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1 },
      cwd: path,
      background: { type: 'boolean' },
      timeoutToBackground: { type: 'boolean' },
      persistent: { type: 'boolean' },
      shell: { enum: ['bash', 'zsh', 'pwsh'] },
      sessionId: { type: 'string', minLength: 1 },
    },
    ['command'],
  ),
  tool_search: empty(),
  tool_describe: empty(),
  compact: empty(),
  run_code: empty(),
  todo: empty(),
}

const DEFAULT_TOOLS = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell', 'tool_search', 'tool_describe']

const meta = (isReadOnly: boolean, isDestructive: boolean, isOpenWorld: boolean): LoopToolMeta => ({
  isReadOnly,
  isDestructive,
  isOpenWorld,
  offered: true,
})
const READ_ONLY = meta(true, false, false)

/** The static meta of the tools in `BUILTIN_SCHEMAS`, as Core reports it, every one offered. */
export const BUILTIN_META: Record<string, LoopToolMeta> = {
  ls: READ_ONLY,
  read: READ_ONLY,
  grep: READ_ONLY,
  find: READ_ONLY,
  write: meta(false, true, false),
  edit: meta(false, true, false),
  shell: meta(false, true, true),
  tool_search: READ_ONLY,
  tool_describe: READ_ONLY,
  compact: READ_ONLY,
  run_code: meta(false, false, true),
  todo: meta(false, false, false),
}
/** The meta of a tool `BUILTIN_META` does not list: mutable, not destructive, not open-world. */
const OTHER_META = meta(false, false, false)

/** The platform fields of a turn view: `toolMeta` and `disclosedTools`. */
export type PlatformOptions = {
  /** The disclosed tool names; by default the catalog without `run_code`. */
  disclosed?: string[]
  /** Fields laid over the default meta of each named tool. */
  meta?: Record<string, Partial<LoopToolMeta>>
}

/** A turn view with a scripted model and the given tool catalog. */
export function turnView(
  over: {
    tools?: readonly string[]
    turnId?: number
    cancelled?: boolean
    history?: LoopTurnView['history']
    /** Adds `toolMeta` and `disclosedTools`, which a view leaves out by default. */
    platform?: true | PlatformOptions
  } = {},
): LoopTurnView {
  const names = over.tools ?? DEFAULT_TOOLS
  const platform = over.platform === true ? {} : over.platform
  return {
    turnId: over.turnId ?? 1,
    step: 0,
    cancelled: over.cancelled ?? false,
    history: over.history ?? [],
    tools: names.map((name) => ({
      name,
      description: name,
      parameters: BUILTIN_SCHEMAS[name] ?? empty(),
    })),
    model: { slot: 'primary', id: 'scripted', capabilities: null },
    prompt: { sections: [], runtime: {} },
    budget: { maxSteps: null, stepsUsed: 0, creditsUsed: 0, perRequestCap: null, onExceed: 'quote' },
    ...(platform === undefined
      ? {}
      : {
          toolMeta: Object.fromEntries(
            names.map((name) => [name, { ...(BUILTIN_META[name] ?? OTHER_META), ...platform.meta?.[name] }]),
          ),
          disclosedTools: platform.disclosed ?? names.filter((name) => name !== 'run_code'),
        }),
  }
}
