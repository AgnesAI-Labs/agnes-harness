import { expect, it, vi } from 'vitest'
import { observe, observedVersion } from '../extensions/tools-core/src/guards/observed.js'
import { normalizeWorkspacePath } from '../extensions/tools-core/src/paths.js'
import { memoryDeleteTool } from '../extensions/tools-core/src/tools/memory-delete.js'
import { fakeToolContext } from '../testkit/tool-context.js'

it('preserves the workspace file observation when deleting a same-named memory topic', async () => {
  const ctx = fakeToolContext()
  const path = 'prefs.md'
  const abs = normalizeWorkspacePath(path, ctx.cwd).abs
  observe(ctx.session.key, abs, 'before')
  const remove = vi.fn(async () => {})
  const result = await memoryDeleteTool.execute({ path }, { ...ctx, fs: { ...ctx.fs, remove } })
  expect(remove).toHaveBeenCalledWith(path)
  expect(observedVersion(ctx.session.key, abs)).toBe('before')
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('immediately hidden') })
})

it('reports unavailable and attested refusals, and propagates ambiguous failures', async () => {
  const ctx = fakeToolContext()
  const args = { path: 'prefs.md' }
  expect(await memoryDeleteTool.execute(args, ctx)).toMatchObject({
    isError: true,
    structured: { code: 'MEMORY_DELETE_UNAVAILABLE' },
  })
  const error = Object.assign(new Error('private hidden paragraph'), {
    name: 'ToolPreEffectRefusal',
    code: 'MEMORY_TOPIC_REFERENCED',
  })
  const failed = {
    ...ctx,
    fs: {
      ...ctx.fs,
      remove: async () => {
        throw error
      },
    },
  }
  const refused = await memoryDeleteTool.execute(args, failed)
  expect(JSON.stringify(refused)).not.toContain('private hidden paragraph')
  expect(refused).toMatchObject({
    isError: true,
    structured: { code: 'MEMORY_TOPIC_REFERENCED' },
  })
  error.name = 'Error'
  await expect(memoryDeleteTool.execute(args, failed)).rejects.toBe(error)
})
