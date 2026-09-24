import { checkToolDef, type ToolResult } from '@agnes/extension-api'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { TodoParams } from '../src/tools/schemas.js'
import { todoTool } from '../src/tools/todo.js'

function textOf(r: ToolResult): string {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(first)
}

describe('todo', () => {
  it('has a complete definition', () => {
    expect(checkToolDef(todoTool)).toEqual({ ok: true })
    expect(todoTool.meta).toMatchObject({ replay: 'idempotent', requiresApproval: 'never' })
  })

  it('writes the plan register through ctx.plan.set, translating the three names to four', async () => {
    // The parameter schema is the model-visible face and is hashed into the prompt, so it keeps the
    // three names models are used to; the ledger register is frozen on the protocol's four.
    const ctx = fakeToolContext()
    const r = await todoTool.execute(
      {
        items: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
        ],
      },
      ctx,
    )
    expect(ctx.calls.plan[0]).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{12}$/), text: 'a', status: 'done' },
      { id: expect.stringMatching(/^[0-9a-f]{12}$/), text: 'b', status: 'doing' },
      { id: expect.stringMatching(/^[0-9a-f]{12}$/), text: 'c', status: 'todo' },
    ])
    expect(textOf(r)).toBe('plan updated: 3 items (1 done, 1 in progress)')
  })

  it('gives an item the same id across calls, whatever position it moved to', async () => {
    // `plan.items` is replaced whole on every call. With a positional id every task is renamed on
    // every call, and anything downstream tracking progress by id sees the entire plan turn over.
    const ctx = fakeToolContext()
    await todoTool.execute(
      {
        items: [
          { content: 'first', status: 'pending' },
          { content: 'second', status: 'pending' },
        ],
      },
      ctx,
    )
    await todoTool.execute(
      {
        items: [
          { content: 'second', status: 'completed' },
          { content: 'first', status: 'in_progress' },
        ],
      },
      ctx,
    )
    const before = ctx.calls.plan[0] as Array<{ id: string; text: string }>
    const after = ctx.calls.plan[1] as Array<{ id: string; text: string }>
    expect(after.find((i) => i.text === 'first')?.id).toBe(before.find((i) => i.text === 'first')?.id)
    expect(after.find((i) => i.text === 'second')?.id).toBe(before.find((i) => i.text === 'second')?.id)
  })

  it('gives two items with the same wording distinct ids', async () => {
    // A content-derived id collides when a plan repeats itself, and two items sharing an id make
    // one of them invisible to anything keyed on it.
    const ctx = fakeToolContext()
    await todoTool.execute(
      {
        items: [
          { content: 'review', status: 'completed' },
          { content: 'review', status: 'pending' },
        ],
      },
      ctx,
    )
    const items = ctx.calls.plan[0] as Array<{ id: string }>
    expect(new Set(items.map((i) => i.id)).size).toBe(2)
    for (const i of items) expect(i.id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('counts what is done and what is in progress', async () => {
    const ctx = fakeToolContext()
    const r = await todoTool.execute({ items: [{ content: 'only', status: 'pending' }] }, ctx)
    expect(textOf(r)).toBe('plan updated: 1 items (0 done, 0 in progress)')
  })
})

describe('the todo parameter schema', () => {
  it('refuses an empty list, so clearing the plan cannot happen by accident', () => {
    expect(Value.Check(TodoParams, { items: [] })).toBe(false)
    expect(Value.Check(TodoParams, { items: [{ content: 'a', status: 'pending' }] })).toBe(true)
  })

  it('does not offer the model a blocked state', () => {
    expect(Value.Check(TodoParams, { items: [{ content: 'a', status: 'blocked' }] })).toBe(false)
    expect(Value.Check(TodoParams, { items: [{ content: 'a', status: 'todo' }] })).toBe(false)
  })
})
