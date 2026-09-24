import { DatabaseSync } from 'node:sqlite'
import { checkToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { SqliteToolIndex, type ToolIndex } from '../../../src/mcp/index-table.js'
import { MemFts } from '../../../testkit/mem-fts.js'
import { MemTable } from '../../../testkit/mem-table.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { toolDescribeTool, toolSearchTool } from '../src/search-tools.js'

const rows = [
  {
    name: 'mcp_gh_list_prs',
    description: 'list pull requests 拉取请求',
    schema: '{"repo":"string"}',
  },
  { name: 'mcp_gh_merge', description: 'merge a pull request', schema: '{}' },
  { name: 'mcp_db_query', description: '查询销售数据', schema: '{"sql":"string"}' },
]

const runInWorkspace = async <T>(_sessionKey: string, invoke: () => Promise<T>): Promise<T> => invoke()

describe('MemFts', () => {
  it('ranks weighted matches, handles Chinese substrings, and breaks ties by name', () => {
    const index = new MemFts()
    index.upsert(rows)
    expect(index.search('pull', 5).map((hit) => hit.name)).toEqual(['mcp_gh_list_prs', 'mcp_gh_merge'])
    expect(index.search('销售', 5)).toEqual([{ name: 'mcp_db_query', score: 1 }])

    index.upsert([
      { name: 'z_tool', description: 'same', schema: '{}' },
      { name: 'a_tool', description: 'same', schema: '{}' },
    ])
    expect(index.search('same', 2).map((hit) => hit.name)).toEqual(['a_tool', 'z_tool'])
  })

  it('replaces rows by exact name and does not match an empty query', () => {
    const index = new MemFts()
    index.upsert([{ name: 'one', description: 'before', schema: '{}' }])
    index.upsert([{ name: 'one', description: 'after', schema: '{"x":true}' }])
    expect(index.get('one')).toEqual({ name: 'one', description: 'after', schema: '{"x":true}' })
    expect(index.search('', 5)).toEqual([])
  })
})

describe('SqliteToolIndex', () => {
  it('uses FTS5 trigram and the planned bm25 weights when the table adapter permits it', () => {
    const calls: Array<{ kind: string; sql: string; params?: readonly unknown[] }> = []
    const table = {
      name: 'tool_index',
      exec: (sql: string) => calls.push({ kind: 'exec', sql }),
      run: (sql: string, params?: readonly unknown[]) => {
        calls.push({ kind: 'run', sql, ...(params ? { params } : {}) })
        return { changes: 1 }
      },
      all: <T>(sql: string, params?: readonly unknown[]) => {
        calls.push({ kind: 'all', sql, ...(params ? { params } : {}) })
        return [{ name: 'mcp_gh_list_prs', score: -1 }] as T[]
      },
      get: <T>() => undefined as T | undefined,
      transaction: <T>(fn: () => T) => fn(),
    }
    const index = new SqliteToolIndex(table)
    expect(index.mode).toBe('fts5')
    expect(calls[0]?.sql).toContain("USING fts5(name, description, schema, tokenize='trigram')")
    expect(index.search('pull "open"', 4)).toEqual([{ name: 'mcp_gh_list_prs', score: -1 }])
    expect(calls.at(-1)).toMatchObject({
      kind: 'all',
      sql: expect.stringContaining('bm25(tool_index, 3.0, 1.0, 0.5)'),
      params: ['"pull ""open"""', 4],
    })
  })

  it('falls back to a persistent ordinary table when virtual tables are denied', () => {
    const table = new MemTable('tool_index')
    const one = new SqliteToolIndex(table)
    expect(one.mode).toBe('portable')
    one.upsert(rows)
    one.upsert([{ name: 'mcp_gh_merge', description: 'updated', schema: '{"n":1}' }])
    expect(one.search('pull', 5).map((hit) => hit.name)).toEqual(['mcp_gh_list_prs'])
    expect(one.get('mcp_gh_merge')).toEqual({
      name: 'mcp_gh_merge',
      description: 'updated',
      schema: '{"n":1}',
    })
    expect(new SqliteToolIndex(table).get('mcp_gh_list_prs')).toEqual(rows[0])
  })

  it('delete removes exactly the named rows and leaves the rest untouched', () => {
    const table = new MemTable('tool_index')
    const index = new SqliteToolIndex(table)
    index.upsert(rows)
    index.delete(['mcp_gh_list_prs'])
    expect(index.get('mcp_gh_list_prs')).toBeUndefined()
    expect(index.get('mcp_gh_merge')).toEqual(rows[1])
    // A name the index never held is a no-op, not an error.
    index.delete(['never-existed'])
    expect(index.get('mcp_gh_merge')).toEqual(rows[1])
  })

  it('executes real FTS5 trigram/BM25 queries and preserves two-character Chinese search', () => {
    const db = new DatabaseSync(':memory:')
    const table = {
      name: 'tool_index',
      exec: (sql: string) => db.exec(sql),
      run: (sql: string, params: readonly unknown[] = []) => ({
        changes: Number(db.prepare(sql).run(...(params as never[])).changes),
      }),
      all: <T>(sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).all(...(params as never[])) as T[],
      get: <T>(sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).get(...(params as never[])) as T | undefined,
      transaction: <T>(fn: () => T) => {
        db.exec('BEGIN')
        try {
          const value = fn()
          db.exec('COMMIT')
          return value
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
    }
    try {
      const index = new SqliteToolIndex(table)
      expect(index.mode).toBe('fts5')
      index.upsert([...rows, { name: 'mcp_pull_exact', description: 'miscellaneous action', schema: '{}' }])
      expect(index.search('pull', 5).map((hit) => hit.name)).toEqual([
        'mcp_pull_exact',
        'mcp_gh_merge',
        'mcp_gh_list_prs',
      ])
      expect(index.search('销售', 5)).toEqual([{ name: 'mcp_db_query', score: 1 }])
    } finally {
      db.close()
    }
  })
})

describe('tool_search / tool_describe', () => {
  const populated = (): ToolIndex => {
    const index = new MemFts()
    index.upsert(rows)
    return index
  }

  it('defines safe, eager tools and honors search limits', async () => {
    const search = toolSearchTool(populated())
    const describe = toolDescribeTool(populated())
    expect(checkToolDef(search).ok).toBe(true)
    expect(checkToolDef(describe).ok).toBe(true)
    expect(search.meta).toMatchObject({ deferLoading: false, replay: 'safe', isReadOnly: true })
    expect(describe.meta).toMatchObject({ deferLoading: false, replay: 'safe', isReadOnly: true })

    const result = await search.execute({ query: 'pull', limit: 1 }, fakeToolContext())
    expect(result.content).toEqual([{ type: 'text', text: 'mcp_gh_list_prs — list pull requests 拉取请求' }])
    expect((await search.execute({ query: 'absent' }, fakeToolContext())).content).toEqual([
      { type: 'text', text: 'no matching tools' },
    ])
  })

  it.each(['my skill', 'my skills', '请列出技能'])('finds catalogued ready Skills for %s', async (query) => {
    const index = populated()
    const search = toolSearchTool(index, {
      runInWorkspace,
      list: () => [
        {
          resourceId: 'skill/user/teacher',
          name: 'chinese-teacher',
          description: 'Teach Chinese.',
          revision: 'a'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'teacher' },
          actual: 'ready',
        },
        {
          resourceId: 'skill/user/disabled',
          name: 'disabled-skill',
          revision: 'b'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'disabled' },
          actual: 'disabled',
        },
      ],
    })
    const result = await search.execute({ query }, fakeToolContext())
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('Skill chinese-teacher — Teach Chinese.'),
    })
    expect((result.content[0] as { text: string }).text).toContain('Call skill_read with this exact name')
    expect((result.content[0] as { text: string }).text).not.toContain('disabled-skill')
    expect(index.get('skill/user/teacher')).toBeUndefined()
  })

  it('fails closed before Skill discovery when the workspace invocation is missing', async () => {
    const list = vi.fn(() => [])
    const search = toolSearchTool(new MemFts(), { list } as never)

    await expect(search.execute({ query: 'my skills' }, fakeToolContext())).rejects.toMatchObject({
      code: 'E_WORKSPACE_REQUIRED',
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps Skill discovery inside the requesting session workspace invocation', async () => {
    const events: string[] = []
    const search = toolSearchTool(new MemFts(), {
      list: () => {
        events.push('list')
        return []
      },
      runInWorkspace: async <T>(sessionKey: string, invoke: () => Promise<T>) => {
        events.push(`acquire:${sessionKey}`)
        try {
          return await invoke()
        } finally {
          events.push(`release:${sessionKey}`)
        }
      },
    })

    await expect(search.execute({ query: 'my skills' }, fakeToolContext())).resolves.toMatchObject({
      content: [{ text: 'no matching tools or ready Skills' }],
    })
    expect(events).toEqual(['acquire:agnes:t:a:cli:dm:x', 'list', 'release:agnes:t:a:cli:dm:x'])
  })

  it('ranks a catalogued Skill name ahead of earlier description matches', async () => {
    const index = new MemFts()
    const target = 'skill/user/chinese-teacher'
    const search = toolSearchTool(index, {
      runInWorkspace,
      list: () => [
        ...Array.from({ length: 5 }, (_, index) => ({
          resourceId: `skill/user/earlier-${index}`,
          name: `earlier-${index}`,
          description: 'chinese-teacher 中文教学',
          revision: 'a'.repeat(64),
          sourceIdentity: {
            scope: 'user' as const,
            rootKey: 'user-agnes' as const,
            sourceId: `earlier-${index}`,
          },
          actual: 'ready' as const,
        })),
        {
          resourceId: target,
          name: 'chinese-teacher',
          description: '中文教学',
          revision: 'b'.repeat(64),
          sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId: 'target' },
          actual: 'ready' as const,
        },
      ],
    })
    const ranked = await search.execute(
      { query: 'chinese-teacher skill 中文教学', limit: 5 },
      fakeToolContext(),
    )
    const rankedText = (ranked.content[0] as { text: string }).text
    expect(rankedText).toMatch(/^Skill chinese-teacher —/u)
    expect(rankedText.match(/^Skill /gmu)).toHaveLength(5)
    expect(rankedText).not.toContain(target)

    const unrelated = await search.execute({ query: 'weather forecast' }, fakeToolContext())
    expect(unrelated.content).toEqual([{ type: 'text', text: 'no matching tools or ready Skills' }])
  })

  it('finds catalogued Chinese Skills and ignores untrusted entries', async () => {
    const search = toolSearchTool(new MemFts(), {
      runInWorkspace,
      list: () => [
        {
          resourceId: 'skill/user/teacher',
          name: '语文老师',
          description: '讲解古诗',
          revision: 'a'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'teacher' },
          actual: 'ready',
        },
        {
          resourceId: 'skill/user/untrusted',
          name: '语文老师备份',
          description: '讲解古诗',
          revision: 'b'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'backup' },
          actual: 'unavailable',
        },
      ],
    })
    const chinese = await search.execute({ query: '语文老师' }, fakeToolContext())
    const chineseText = (chinese.content[0] as { text: string }).text
    expect(chineseText).toContain('Skill 语文老师 — 讲解古诗')
    expect(chineseText).not.toContain('语文老师备份')
    const partial = await search.execute({ query: '语文' }, fakeToolContext())
    expect((partial.content[0] as { text: string }).text).toContain('Skill 语文老师 —')
    expect((partial.content[0] as { text: string }).text).not.toContain('skill/user/teacher')
    const description = await search.execute({ query: '古诗' }, fakeToolContext())
    expect((description.content[0] as { text: string }).text).toContain('Skill 语文老师 —')
    expect((description.content[0] as { text: string }).text).not.toContain('语文老师备份')
  })

  it('reserves a result for an exact Skill, but keeps the tool limit when no Skill matches', async () => {
    const index = populated()
    index.upsert([
      { name: 'mcp_web_access', description: 'web-access skill', schema: '{}' },
      { name: 'mcp_weather', description: 'weather skill', schema: '{}' },
    ])
    const list = vi.fn(() =>
      ['web', 'web-access'].map((name) => ({
        resourceId: `skill/user/${name}`,
        name,
        description: 'Read web pages',
        revision: 'a'.repeat(64),
        sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: name },
        actual: 'ready' as const,
      })),
    )
    const search = toolSearchTool(index, { list, runInWorkspace })
    for (const query of ['web-access', ' WEB-ACCESS ', 'web-access skill']) {
      list.mockClear()
      const result = await search.execute({ query, limit: 1 }, fakeToolContext())
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Skill web-access —') })
      expect((result.content[0] as { text: string }).text).not.toContain('mcp_web_access')
      expect((result.content[0] as { text: string }).text.match(/^Skill /gmu)).toHaveLength(1)
      expect(list).toHaveBeenCalledTimes(1)
    }
    const noSkill = await search.execute({ query: 'weather skill', limit: 1 }, fakeToolContext())
    expect(noSkill.content).toEqual([{ type: 'text', text: 'mcp_weather — weather skill' }])
    const ctx = fakeToolContext()
    ctx.tools.list = () => [{ ...toolSearchTool(index), name: 'web-access' }]
    const collision = await search.execute({ query: 'web-access', limit: 1 }, ctx)
    expect(collision.content[0]).toMatchObject({ text: expect.stringMatching(/^Skill web-access —/u) })
    const both = await search.execute({ query: 'web-access', limit: 2 }, ctx)
    const text = (both.content[0] as { text: string }).text
    expect(text).toContain('Already provided in this session')
    expect(text.match(/^Skill /gmu)).toHaveLength(1)
    expect(text).toContain('Skill web-access —')
  })

  it('returns a ready Skill beyond the name-only catalog budget', async () => {
    const target = 'skill/user/late-skill'
    const search = toolSearchTool(new MemFts(), {
      runInWorkspace,
      list: () => [
        ...Array.from({ length: 600 }, (_, index) => ({
          resourceId: `skill/user/early-${String(index).padStart(2, '0')}`,
          name: `early-${String(index).padStart(3, '0')}`.padEnd(128, 'n'),
          description: 'd'.repeat(400),
          revision: 'a'.repeat(64),
          sourceIdentity: {
            scope: 'user' as const,
            rootKey: 'user-agnes' as const,
            sourceId: `early-${index}`,
          },
          actual: 'ready' as const,
        })),
        {
          resourceId: target,
          name: 'zebra-review',
          description: 'late catalog entry',
          revision: 'b'.repeat(64),
          sourceIdentity: { scope: 'user' as const, rootKey: 'user-agnes' as const, sourceId: 'late' },
          actual: 'ready' as const,
        },
      ],
    })
    const found = await search.execute({ query: 'zebra' }, fakeToolContext())
    expect((found.content[0] as { text: string }).text).toContain('Call skill_read with this exact name')
    expect((found.content[0] as { text: string }).text).not.toContain(target)
  })

  it('describes and finds an eager tool only while present in the invocation view', async () => {
    const ctx = fakeToolContext()
    const eager = toolSearchTool(populated())
    ctx.tools.list = () => [eager]
    const index = populated()
    expect(await toolDescribeTool(index).execute({ name: eager.name }, ctx)).toMatchObject({
      content: [{ text: expect.stringContaining('parameters:') }],
    })
    expect(await toolSearchTool(index).execute({ query: eager.name }, ctx)).toMatchObject({
      content: [{ text: expect.stringContaining('Already provided in this session') }],
    })
    ctx.tools.list = () => []
    expect(await toolDescribeTool(index).execute({ name: eager.name }, ctx)).toMatchObject({ isError: true })
  })

  it('describes an exact tool, caps schema bytes, and errors on unknown names', async () => {
    const index = populated()
    index.upsert([{ name: 'huge', description: 'large', schema: '🙂'.repeat(5000) }])
    const describe = toolDescribeTool(index)
    const result = await describe.execute({ name: 'mcp_db_query' }, fakeToolContext())
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"sql"') })

    const huge = await describe.execute({ name: 'huge' }, fakeToolContext())
    const schema = (huge.content[0] as { text: string }).text.split('\nparameters: ')[1] as string
    expect(new TextEncoder().encode(schema).byteLength).toBeLessThanOrEqual(8192)
    expect(await describe.execute({ name: 'nope' }, fakeToolContext())).toMatchObject({
      content: [{ text: 'unknown tool: nope' }],
      isError: true,
    })
  })
})
