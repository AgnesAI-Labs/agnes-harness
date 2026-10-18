import type { OwnedStore, ServiceContext } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool, toolError } from '@agnes/plugin-runtime'
import { type Static, Type } from '@sinclair/typebox'

const inputSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('toggle')]),
    text: Type.Optional(Type.String({ maxLength: 200 })),
    id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
const itemSchema = Type.Object({ id: Type.String(), text: Type.String(), done: Type.Boolean() })
const outputSchema = Type.Object({ items: Type.Array(itemSchema, { maxItems: 100 }) })
type Item = Static<typeof itemSchema>

// Both entry points use the Host's same owner/profile namespace, never a caller-selected path.
function run(input: Static<typeof inputSchema>, store?: OwnedStore) {
  if (!store) throw new Error('Store capability unavailable / 存储能力不可用')
  return store.transaction(() => {
    const items = (store.get('items') ?? []) as Item[]
    if (input.action === 'add') {
      const text = input.text?.trim()
      if (!text) throw new Error('Enter an item / 请输入待办事项')
      if (items.length >= 100) throw new Error('List is full / 待办列表已满')
      items.push({ id: crypto.randomUUID(), text, done: false })
    } else if (input.action === 'toggle') {
      const item = items.find((item) => item.id === input.id)
      if (!item) throw new Error('Item not found / 待办事项不存在')
      item.done = !item.done
    }
    if (input.action !== 'list') store.set('items', items)
    return { items }
  })
}

export const todos = defineTool({
  name: '__TOOL_NAME__',
  description: 'List, add or toggle profile to-dos / 查看、添加或切换当前档案的待办事项。',
  parameters: inputSchema,
  result: outputSchema,
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'never',
    requiresApproval: 'never',
  },
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      const output = run(input, ctx.store)
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structured: output }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error))
    }
  },
})

export const main = defineAgnesPlugin({
  apply(ctx: Context) {
    ctx.tools.register(todos)
    // Service metadata is plain JSON; only tool parameters retain TypeBox Kind symbols.
    const common = {
      scope: 'profile' as const,
      outputSchema: JSON.parse(JSON.stringify(outputSchema)),
      timeoutMs: 5000,
      maxResultBytes: 65536,
    }
    ctx.services.register({
      ...common,
      name: '__SERVICE_NAME__.list',
      kind: 'query',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler(_input, context) {
        return run({ action: 'list' }, context.store)
      },
    })
    ctx.services.register({
      ...common,
      name: '__SERVICE_NAME__.change',
      kind: 'effect',
      inputSchema: JSON.parse(
        JSON.stringify({
          ...inputSchema,
          properties: {
            ...inputSchema.properties,
            action: Type.Union([Type.Literal('add'), Type.Literal('toggle')]),
          },
        }),
      ),
      effectPolicy: {
        isDestructive: false,
        isOpenWorld: false,
        replay: 'never',
        requiresApproval: 'never',
        approvalScopes: [],
      },
      async handler(input, context: ServiceContext) {
        context.signal.throwIfAborted()
        return run(input as Static<typeof inputSchema>, context.store)
      },
    })
  },
})
