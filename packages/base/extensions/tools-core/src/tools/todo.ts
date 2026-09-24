import { createHash } from 'node:crypto'
import { defineTool, type PlanItem, type ToolResult } from '@agnes/extension-api'
import { TodoParams } from './schemas.js'

// The tool's parameter schema is the model-visible face and is hashed into the prompt, so it keeps
// the three names models are used to; the ledger register the plan lands in is frozen on the
// protocol's four. This table is the whole of the translation, and `blocked` is deliberately
// missing from the model's side - whether work is blocked is a judgement about the world that the
// operator and the kernel make.
const STATUS: Record<'pending' | 'in_progress' | 'completed', PlanItem['status']> = {
  pending: 'todo',
  in_progress: 'doing',
  completed: 'done',
}

const ID_CHARS = 12

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, ID_CHARS)
}

export const todoTool = defineTool({
  name: 'todo',
  description:
    'Replace the task plan with the given list. Keep exactly one item in_progress; mark items completed as you finish them. Sending the whole list each time is expected - it replaces the plan rather than adding to it.',
  parameters: TodoParams,
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'idempotent',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, ctx): Promise<ToolResult> {
    // Derived from the wording, so an item keeps its id when the list is reordered. A positional id
    // renamed every task on every call, and the plan register is replaced whole - so anything
    // downstream following progress by id would see the entire plan turn over each time.
    const used = new Set<string>()
    const items: PlanItem[] = args.items.map((it) => {
      let id = digest(it.content)
      // Two items worded the same would otherwise share an id, and one of them would be invisible
      // to anything keyed on it. The salt is the count so far, so the answer is still the same for
      // the same list.
      for (let n = 1; used.has(id); n++) id = digest(`${it.content}#${n}`)
      used.add(id)
      return { id, text: it.content, status: STATUS[it.status] }
    })
    await ctx.plan.set(items)
    const done = items.filter((i) => i.status === 'done').length
    const doing = items.filter((i) => i.status === 'doing').length
    return {
      content: [
        { type: 'text', text: `plan updated: ${items.length} items (${done} done, ${doing} in progress)` },
      ],
    }
  },
})
