import { type ModelAdapterConfig, type ModelAdapterInstance, registerLoopPlugin } from '@agnes/extension-api'
import {
  type Context,
  defineAgnesPlugin,
  defineLoop,
  defineModelAdapter,
  defineTool,
  type LoopPluginContext,
  type ModelAdapterPluginContext,
} from '@agnes/plugin-runtime'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { createDagLoop } from '../dag/index.mjs'

export const route = 'community-dag'
export const modelId = 'dag-demo'
export const plan = [
  { id: 'left', tool: 'community_echo', args: { value: 'left' }, after: [] },
  { id: 'right', tool: 'community_echo', args: { value: 'right' }, after: [] },
  {
    id: 'join',
    tool: 'community_join',
    args: { a: { $result: 'left' }, b: { $result: 'right' } },
    after: ['left', 'right'],
  },
]

export const model: ModelRecord = {
  id: modelId,
  name: 'Deterministic DAG demo',
  api: route,
  route,
  baseUrl: 'https://unused.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: [],
  thinkingReplay: 'drop',
  contract_id: null,
}

function reply(request: RequestBody): string {
  if (request.messages.some((message) => message.content.some((block) => block.type === 'image'))) {
    throw new Error('The deterministic DAG demo accepts text only')
  }
  if (request.system.includes('Return only a JSON array of DAG nodes')) return JSON.stringify(plan)
  if (!request.system.includes('Summarize the DAG tool results')) throw new Error('Unsupported demo request')
  const last = request.messages.at(-1)?.content.at(-1)
  if (last?.type !== 'text') throw new Error('DAG summary requires text results')
  const results = JSON.parse(last.text)
  return results.join.content
    .map((block: { type: string; text?: string }) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/** A demonstration protocol: no network, credentials, retries, or real inference. */
export const adapter = defineModelAdapter({
  id: route,
  api: route,
  version: '0.1.0',
  capabilities: { imageInput: false, tools: false, streaming: true },
  create(config: ModelAdapterConfig): ModelAdapterInstance {
    const lifetime = new AbortController()
    const routes = structuredClone(config.routes.filter((candidate) => candidate.api === route))
    return {
      id: route,
      routes: () => routes.map(({ keyless: _keyless, ...decl }) => structuredClone(decl)),
      models: (name) => structuredClone(routes.find((candidate) => candidate.route === name)?.models ?? []),
      async *stream(name, request, options) {
        const signal = AbortSignal.any([options.signal, lifetime.signal])
        signal.throwIfAborted()
        if (
          !routes.some(
            (candidate) =>
              candidate.route === name && candidate.models.some((model) => model.id === request.model),
          ) ||
          request.route !== name
        ) {
          throw new Error('Unknown demo route/model')
        }
        yield { type: 'text_delta', delta: reply(request) }
        signal.throwIfAborted()
        yield { type: 'done', reason: 'stop' }
      },
      dispose() {
        lifetime.abort()
      },
    }
  },
})

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: 'never' as const,
}
const output = Type.Object({ value: Type.String() }, { additionalProperties: false })
const toolOutput = Type.Object(
  {
    content: Type.Array(
      Type.Object({ type: Type.Literal('text'), text: Type.String() }, { additionalProperties: false }),
    ),
    isError: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const echo = defineTool({
  name: 'community_echo',
  description: 'Return the supplied demonstration value.',
  parameters: output,
  result: output,
  meta,
  async execute({ value }, ctx) {
    ctx.signal.throwIfAborted()
    return { content: [{ type: 'text', text: value }], structured: { value } }
  },
})
export const join = defineTool({
  name: 'community_join',
  description: 'Join two completed demonstration outputs.',
  parameters: Type.Object({ a: toolOutput, b: toolOutput }, { additionalProperties: false }),
  result: output,
  meta,
  async execute({ a, b }, ctx) {
    ctx.signal.throwIfAborted()
    if (a.isError || b.isError) throw new Error('Cannot join failed DAG nodes')
    const value = [...a.content, ...b.content].map((block) => block.text).join(' + ')
    return { content: [{ type: 'text', text: value }], structured: { value } }
  },
})

export const factory = defineLoop({
  ...createDagLoop({ target: { route, model: modelId } }),
  id: 'community.dag',
  version: '0.1.0',
})
export const loopPlugin = defineAgnesPlugin({
  inject: ['loops'],
  apply(ctx: LoopPluginContext) {
    registerLoopPlugin(ctx, '@community/dag-loop-adapter', factory)
  },
})
export const adapterPlugin = defineAgnesPlugin({
  inject: ['modelAdapters'],
  apply(ctx: ModelAdapterPluginContext) {
    ctx.modelAdapters.register(adapter)
  },
})
export const toolPlugin = defineAgnesPlugin({
  inject: ['extension'],
  apply(ctx: Context) {
    for (const tool of [echo, join]) {
      const unregister = ctx.extension().registerTool(tool)
      ctx.effect(() => unregister)
    }
  },
})
