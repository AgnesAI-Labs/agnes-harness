import { expect, it, vi } from 'vitest'
import { memoryRecallTool } from '../extensions/tools-core/src/tools/memory-recall.js'
import { fakeToolContext } from '../testkit/tool-context.js'

it('returns labeled, untrusted workspace and user excerpts from the selected provider', async () => {
  const recall = vi.fn(async () => ({
    revision: 'r1',
    truncated: true,
    hits: [
      {
        layer: 'workspace' as const,
        path: 'tools.md',
        lineStart: 2,
        lineEnd: 4,
        text: 'Use pnpm.',
        score: 1,
      },
      {
        layer: 'user' as const,
        path: 'MEMORY.md',
        lineStart: 9,
        lineEnd: 9,
        text: 'Answer briefly.',
        score: 0.5,
      },
    ],
  }))
  const args = { query: 'preferences', limit: 2, includeUser: true }
  const result = await memoryRecallTool.execute(args, { ...fakeToolContext(), memory: { recall } })
  expect(memoryRecallTool.meta).toMatchObject({ isReadOnly: true, deferLoading: true })
  expect(recall).toHaveBeenCalledWith(args)
  expect(result.content[0]).toMatchObject({
    text: expect.stringMatching(
      /untrusted learned preferences[\s\S]*\[workspace\] tools.md:2-4\nUse pnpm.[\s\S]*\[user\] MEMORY.md:9-9\nAnswer briefly.[\s\S]*truncated/,
    ),
  })
})

it.each([undefined, 'MEMORY_DISABLED', 'MEMORY_RECALL_UNAVAILABLE'])(
  'gives the read fallback when recall is unavailable (%s)',
  async (code) => {
    const ctx = fakeToolContext()
    const memory = {
      recall: async () => {
        throw Object.assign(new Error('private provider detail'), { code })
      },
    }
    const result = await memoryRecallTool.execute({ query: 'format' }, code ? { ...ctx, memory } : ctx)
    expect(result).toMatchObject({
      isError: true,
      structured: { code: 'MEMORY_RECALL_UNAVAILABLE' },
      content: [{ type: 'text', text: expect.stringMatching(/use read on MEMORY\.md/i) }],
    })
  },
)
