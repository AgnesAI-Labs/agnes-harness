import type { ToolContext } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineTool, toolCancelled, toolError } from './tool.js'

export const greeting = defineTool({
  name: 'greeting',
  description: 'Return a greeting.',
  parameters: Type.Object({ name: Type.String() }),
  result: Type.Object({ greeting: Type.String() }),
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never',
  },
  async execute({ name }) {
    expectTypeOf(name).toEqualTypeOf<string>()
    if (!name) return toolError('A name is required')
    return { content: [{ type: 'text', text: `Hello ${name}` }], structured: { greeting: `Hello ${name}` } }
  },
})

describe('typed tool authoring', () => {
  it('infers schemas, supports business failures, and refuses malformed successful results', async () => {
    const ctx = { signal: new AbortController().signal } as ToolContext
    expect(await greeting.execute({ name: 'Agnes' }, ctx)).toMatchObject({
      structured: { greeting: 'Hello Agnes' },
    })
    expect(await greeting.execute({ name: '' }, ctx)).toEqual(toolError('A name is required'))
    const malformed = defineTool({
      ...greeting,
      // Deliberately exercise an untyped JavaScript implementation at runtime.
      execute: async () => ({ content: [], structured: { greeting: 42 } }) as never,
    })
    await expect(malformed.execute({ name: 'Agnes' }, ctx)).rejects.toThrow('result schema')
    expectTypeOf<Parameters<typeof greeting.execute>[0]>().toEqualTypeOf<{ name: string }>()
    expectTypeOf<Awaited<ReturnType<typeof greeting.execute>>['structured']>().toEqualTypeOf<
      { greeting: string } | undefined
    >()
  })

  it('preserves legacy declarations and cancellation reasons before and after execution', async () => {
    const { result: _result, ...legacy } = greeting
    expect(defineTool(legacy)).toBe(legacy)
    const ac = new AbortController()
    const reason = new DOMException('Stopped by user', 'AbortError')
    ac.abort(reason)
    expect(() => toolCancelled(ac.signal)).toThrow(reason)
    await expect(greeting.execute({ name: 'Agnes' }, { signal: ac.signal } as ToolContext)).rejects.toBe(
      reason,
    )
    const during = new AbortController()
    const cancelling = defineTool({
      ...greeting,
      async execute() {
        during.abort(reason)
        return { content: [], structured: { greeting: 'too late' } }
      },
    })
    await expect(
      cancelling.execute({ name: 'Agnes' }, { signal: during.signal } as ToolContext),
    ).rejects.toBe(reason)
  })
})
