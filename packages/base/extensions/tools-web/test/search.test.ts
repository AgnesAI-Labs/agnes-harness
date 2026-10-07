import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createWebSearchTool } from '../src/search.js'

describe('web_search', () => {
  it('discloses a valid vendor-neutral tool and refuses clearly without a configured provider', async () => {
    const tool = createWebSearchTool()
    expect(checkToolDef(tool)).toEqual({ ok: true })
    const result = await tool.execute({ queries: ['a'] }, fakeToolContext())
    expect(result.isError).toBe(true)
    expect(result.details).toEqual({ code: 'WEB_SEARCH_UNAVAILABLE' })
  })
  it('passes one to four queries and cancellation to the host provider and spills long results', async () => {
    const ctx = fakeToolContext({ outputMaxBytes: 4096 })
    const tool = createWebSearchTool({
      async search(queries, options) {
        expect(queries).toEqual(['a', 'b', 'c', 'd'])
        expect(options.signal.aborted).toBe(false)
        return queries.map((query) => ({
          query,
          title: 'Title',
          url: 'https://example.com',
          snippet: 'result'.repeat(2000),
        }))
      },
    })
    expect(
      (await tool.execute({ queries: ['a', 'b', 'c', 'd'] }, ctx)).content.some((c) => c.type === 'ref'),
    ).toBe(true)
    expect((await tool.execute({ queries: ['a', 'b', 'c', 'd', 'e'] }, ctx)).isError).toBe(true)
  })
  it('does not expose provider credentials in error output', async () => {
    const tool = createWebSearchTool({
      search: async () => {
        throw new Error('key=private-token')
      },
    })
    const result = await tool.execute({ queries: ['a'] }, fakeToolContext())
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-token')
    const controller = new AbortController()
    const cancelled = createWebSearchTool({ search: async () => new Promise(() => {}) }).execute(
      { queries: ['a'] },
      { ...fakeToolContext(), signal: controller.signal },
    )
    controller.abort()
    expect(JSON.stringify(await cancelled)).toContain('web_search cancelled')
  })
})
