import { presetDefaults, ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, openSession, readTool, textTurn, toolTurn } from '@agnes/core/testkit'
import { checkToolDef, type ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { MetadataToolIndex, type ToolIndex } from '../../../src/mcp/index-table.js'
import { MemFts } from '../../../testkit/mem-fts.js'
import { MemNamespace } from '../../../testkit/seam-init.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { pluginCreatorTools } from '../../plugin-creator/src/index.js'
import { createWebSearchTool } from '../../tools-web/src/search.js'
import { toolDescribeTool, toolSearchTool } from '../src/search-tools.js'

const unknownAvailability =
  '\nAvailability unknown (request snapshot unavailable); use the schemas supplied in the current model request and refresh discovery after the next model request.'

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
    index.upsert([
      { name: 'ui_render', description: 'Render a bounded surface', schema: '{}' },
      { name: 'render_card', description: 'ui_render render detail card UI', schema: '{}' },
    ])
    expect(index.search('UI_RENDER render detail card UI', 1).map((hit) => hit.name)).toEqual(['ui_render'])
    expect(index.search('render detail card', 2).map((hit) => hit.name)).toEqual(['render_card', 'ui_render'])
    expect(index.search('ui_render extra terms', 0)).toEqual([])
  })

  it('replaces rows by exact name and does not match an empty query', () => {
    const index = new MemFts()
    index.upsert([{ name: 'one', description: 'before', schema: '{}' }])
    index.upsert([{ name: 'one', description: 'after', schema: '{"x":true}' }])
    expect(index.get('one')).toEqual({ name: 'one', description: 'after', schema: '{"x":true}' })
    expect(index.search('', 5)).toEqual([])
  })
})

describe('MetadataToolIndex', () => {
  it('replaces a row on upsert and ranks with the portable scorer', () => {
    const index = new MetadataToolIndex(new MemNamespace())
    index.upsert(rows)
    index.upsert([{ name: 'mcp_gh_merge', description: 'updated', schema: '{"n":1}' }])
    expect(index.search('pull', 5).map((hit) => hit.name)).toEqual(['mcp_gh_list_prs'])
    expect(index.search('销售', 5)).toEqual([{ name: 'mcp_db_query', score: 1 }])
    expect(index.get('mcp_gh_merge')).toEqual({
      name: 'mcp_gh_merge',
      description: 'updated',
      schema: '{"n":1}',
    })
  })

  it('ranks an exact tool-name match above a row that only repeats the terms in its description', () => {
    const index = new MetadataToolIndex(new MemNamespace())
    index.upsert([
      { name: 'ui_render', description: 'Render a bounded surface', schema: '{}' },
      { name: 'render_card', description: 'ui_render render detail card UI', schema: '{}' },
    ])
    expect(index.search('UI_RENDER render detail card UI', 1).map((hit) => hit.name)).toEqual(['ui_render'])
    // Without an exact name term the description-heavy row wins on plain substring score.
    expect(index.search('render detail card', 2).map((hit) => hit.name)).toEqual(['render_card', 'ui_render'])
  })

  it('delete removes exactly the named rows and leaves the rest untouched', () => {
    const index = new MetadataToolIndex(new MemNamespace())
    index.upsert(rows)
    index.delete(['mcp_gh_list_prs'])
    expect(index.get('mcp_gh_list_prs')).toBeUndefined()
    expect(index.get('mcp_gh_merge')).toEqual(rows[1])
    // A name the index never held is a no-op, not an error.
    index.delete(['never-existed'])
    expect(index.get('mcp_gh_merge')).toEqual(rows[1])
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
    expect(result.content).toEqual([
      { type: 'text', text: 'mcp_gh_list_prs — list pull requests 拉取请求' + unknownAvailability },
    ])
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

  it('omits a user-only skill from tool_search', async () => {
    const search = toolSearchTool(populated(), {
      runInWorkspace,
      list: () => [
        {
          resourceId: 'skill/user/people',
          name: 'people-only',
          description: 'Teach Chinese.',
          revision: 'c'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'people' },
          actual: 'ready',
        },
      ],
      invocation: () => ({ modelInvocable: false, userInvocable: true, disabled: false }),
    })
    const result = await search.execute({ query: 'my skills' }, fakeToolContext())
    expect((result.content[0] as { text: string }).text).not.toContain('people-only')
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
    expect(noSkill.content).toEqual([
      { type: 'text', text: 'mcp_weather — weather skill' + unknownAvailability },
    ])
    const ctx = fakeToolContext()
    ctx.tools.list = () => [{ ...toolSearchTool(index), name: 'web-access' }]
    const collision = await search.execute({ query: 'web-access', limit: 1 }, ctx)
    expect(collision.content[0]).toMatchObject({ text: expect.stringMatching(/^Skill web-access —/u) })
    const both = await search.execute({ query: 'web-access', limit: 2 }, ctx)
    const text = (both.content[0] as { text: string }).text
    expect(text).toContain('Availability unknown')
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
      content: [{ text: expect.stringContaining('Availability unknown') }],
    })
    const web = createWebSearchTool()
    const deferred = {
      ...eager,
      name: 'search_panel',
      description: 'A search tool panel',
      meta: { ...eager.meta, deferLoading: true },
    }
    ctx.tools.list = () => [web, deferred]
    // Indexed duplicates must not consume slots or override the visible catalog's description/rank.
    index.upsert(
      [web, deferred].map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: JSON.stringify(tool.parameters),
      })),
    )
    for (const query of ['public web', 'search tool', 'queries']) {
      const result = await toolSearchTool(index).execute({ query, limit: 2 }, ctx)
      const text = (result.content[0] as { text: string }).text
      expect(text).toMatch(query === 'search tool' ? /^search_panel —/ : /^web_search —/)
      expect(text.match(/web_search —/g)).toHaveLength(1)
      expect(text).toContain('Availability unknown')
      expect(await toolSearchTool(new MemFts()).execute({ query, limit: 2 }, ctx)).toEqual(result)
      if (query === 'search tool') expect(text).toContain('search_panel —')
    }
    // Matching metadata in a stale indexed duplicate must not revive a hidden description.
    index.upsert([{ name: web.name, description: 'retired-provider-marker', schema: '{}' }])
    expect(await toolSearchTool(index).execute({ query: 'retired-provider-marker' }, ctx)).toMatchObject({
      content: [{ text: 'no matching tools' }],
    })
    index.upsert([{ name: 'z_docs', description: 'retired-provider-marker', schema: '{}' }])
    expect(
      await toolSearchTool(index).execute({ query: 'retired-provider-marker', limit: 1 }, ctx),
    ).toMatchObject({ content: [{ text: 'z_docs — retired-provider-marker' + unknownAvailability }] })
    ctx.tools.list = () => []
    expect(await toolDescribeTool(index).execute({ name: eager.name }, ctx)).toMatchObject({ isError: true })
  })

  it.each([
    ['read', {}, 'offered', undefined],
    ['later', { deferLoading: true }, 'deferred', undefined],
    ['run_code', {}, 'unavailable', 'mode'],
    ['compact', {}, 'unavailable', 'policy'],
    ['internal', { modelVisible: false }, 'unavailable', 'policy'],
    ['camera', { requiresImageInput: true }, 'unavailable', 'model_capability'],
  ] as const)(
    'reports request availability for %s and agrees with Core refusal',
    async (name, meta, status, reason) => {
      const index = new MemFts()
      const target = { ...(readTool() as ToolDef), name, meta: { ...(readTool() as ToolDef).meta, ...meta } }
      index.upsert([{ name, description: target.description, schema: '{}' }])
      const registry = new ToolRegistry()
      const states: unknown[] = []
      const search = toolSearchTool(index)
      registry.add(
        {
          ...search,
          async execute(
            args: Parameters<typeof search.execute>[0],
            ctx: Parameters<typeof search.execute>[1],
          ) {
            states.push(ctx.tools.availability?.(name))
            return search.execute(args, ctx)
          },
        },
        { source: 'test', trust: 'builtin' },
      )
      registry.add(toolDescribeTool(index), { source: 'test', trust: 'builtin' })
      registry.add(target, { source: 'test', trust: 'builtin' })
      const provider = fakeProvider([
        toolTurn('tool_search', { query: name }),
        toolTurn(name, {}),
        ...(status === 'deferred'
          ? [
              toolTurn('tool_describe', { name }),
              toolTurn('tool_search', { query: name }),
              toolTurn(name, {}),
            ]
          : []),
        textTurn('done'),
      ])
      const preset = presetDefaults()
      preset.compaction.agentCallable = false
      const { session } = await openSession({ provider, registry, preset })
      try {
        await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'discover' }] })
        await session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(states[0]).toMatchObject({ status, ...(reason ? { reason } : {}) })
        const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
        const message = (states[0] as { message: string }).message
        expect(results[0]?.data).toMatchObject({
          content: [{ type: 'text', text: expect.stringContaining(message) }],
        })
        expect(provider.requests[0]?.tools.some((tool) => tool.name === name)).toBe(status === 'offered')
        if (status === 'deferred') {
          expect(states[1]).toMatchObject({ status: 'offered' })
          expect(provider.requests[3]?.tools.some((tool) => tool.name === name)).toBe(true)
          expect(results[3]?.data).toMatchObject({
            content: [{ text: expect.stringContaining('Offered in this request; call it directly') }],
          })
          expect(results[4]?.data).not.toMatchObject({ isError: true })
        }
        if (status === 'offered') expect(results[1]?.data).not.toMatchObject({ isError: true })
        else
          expect(results[1]?.data).toMatchObject({
            code: 'TOOL_NOT_DISCLOSED',
            content: [{ text: expect.stringContaining(message) }],
          })
      } finally {
        await session.close()
      }
    },
  )

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

  it('finds deferred plugin tools outside the MCP index and loads only the described available tool', async () => {
    const ctx = fakeToolContext()
    const template = toolSearchTool(populated())
    const tool = {
      ...template,
      name: 'ui_render',
      description: 'Render a review surface',
      meta: { ...template.meta, deferLoading: true },
    }
    const disclosed: string[] = []
    ctx.tools.list = () => [tool]
    ctx.tools.disclose = async (name) => {
      disclosed.push(name)
    }
    const index = new MemFts()
    expect(await toolSearchTool(index).execute({ query: 'review' }, ctx)).toMatchObject({
      content: [{ text: expect.stringContaining('ui_render — Render a review surface') }],
    })
    ctx.tools.list = () => [tool, { ...tool, name: 'render_card', description: 'render detail card UI' }]
    const search = toolSearchTool(index, {
      runInWorkspace,
      list: () => [
        {
          resourceId: 'skill/user/ui-review',
          name: 'ui-review',
          description: 'ui_render render detail card UI',
          revision: 'a'.repeat(64),
          sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'ui-review' },
          actual: 'ready',
        },
      ],
    })
    const query = 'ui_render render detail card UI'
    expect(await search.execute({ query, limit: 1 }, ctx)).toMatchObject({
      content: [{ text: expect.stringMatching(/^ui_render —/) }],
    })
    expect(await search.execute({ query: query + ' Skill', limit: 2 }, ctx)).toMatchObject({
      content: [{ text: expect.stringMatching(/^ui_render —[\s\S]*Skill ui-review/) }],
    })
    expect(disclosed).toEqual([])
    expect(await toolDescribeTool(index).execute({ name: 'ui_render' }, ctx)).toMatchObject({
      content: [{ text: expect.stringContaining('parameters:') }],
    })
    expect(disclosed).toEqual(['ui_render'])
    ctx.tools.list = () => []
    expect(await toolSearchTool(index).execute({ query: 'review' }, ctx)).toMatchObject({
      content: [{ text: 'no matching tools' }],
    })
    expect(await toolDescribeTool(index).execute({ name: 'ui_render' }, ctx)).toMatchObject({ isError: true })
    expect(disclosed).toEqual(['ui_render'])
  })

  it('keeps plugin and Skill authoring absent from ordinary requests, then offers described tools', async () => {
    const registry = new ToolRegistry()
    const index = new MemFts()
    const add = (tool: ToolDef) =>
      registry.add(tool, {
        source: 'test',
        trust: 'builtin',
        packageIdentity: 'test-authoring',
        packageVersion: '1.0.0',
      })
    add(toolSearchTool(index))
    add(toolDescribeTool(index))
    for (const tool of pluginCreatorTools) add(tool)
    const helper = await import(
      new URL('../../../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
    )
    const skills = await import(
      new URL('../../../../package-manager/bundled-plugins/skill-helper/index.mjs', import.meta.url).href
    )
    helper.pluginHelper.apply({ tools: { register: add } })
    skills.skillHelper.apply({ tools: { register: add } })
    const authoring = registry
      .snapshot(0)
      .defs.filter((tool) => tool.name.startsWith('plugin_') || tool.name.startsWith('skill_helper_'))
    const provider = fakeProvider([
      toolTurn('tool_search', { query: 'plugin_creator_guide' }),
      ...authoring.map((tool) => toolTurn('tool_describe', { name: tool.name })),
      textTurn('ready'),
    ])
    const preset = presetDefaults()
    preset.compaction.agentCallable = false
    const { session } = await openSession({ provider, registry, preset })
    try {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'build a plugin' }] })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const first = provider.requests[0]!
      expect(first.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['tool_search', 'tool_describe']),
      )
      for (const tool of authoring) {
        expect(first.tools.map((t) => t.name)).not.toContain(tool.name)
        expect(provider.requests.at(-1)!.tools.map((t) => t.name)).toContain(tool.name)
      }
      expect(authoring.length).toBeGreaterThanOrEqual(14)
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      expect(results[0]?.data).toMatchObject({
        content: [{ text: expect.stringContaining('plugin_creator_guide') }],
      })
      expect(results.every((row) => !(row.data as { isError?: boolean }).isError)).toBe(true)
    } finally {
      await session.close()
    }
  })

  it('finds deferred MCP tools by name, description and server name', async () => {
    const ctx = fakeToolContext()
    const template = toolSearchTool(populated())
    const remote = (name: string, description: string, group: string) => ({
      ...template,
      name,
      description,
      meta: { ...template.meta, deferLoading: true, discoveryGroup: group },
    })
    ctx.tools.list = () => [
      remote('mcp__tracker__create_issue', 'Create an issue', 'MCP server Acme Tracker'),
      remote('mcp__tracker__close_issue', 'Close an issue', 'MCP server Acme Tracker'),
      remote('mcp__wiki__edit_page', 'Edit a page', 'MCP server Team Wiki'),
    ]
    const names = async (query: string) =>
      (
        (await toolSearchTool(new MemFts()).execute({ query, limit: 5 }, ctx)).content[0] as { text: string }
      ).text
        .split('\n')
        .filter((line) => line.includes(' — '))
        .map((line) => line.split(' — ')[0])
    expect(await names('create_issue')).toEqual(['mcp__tracker__create_issue'])
    expect(await names('edit page')).toEqual(['mcp__wiki__edit_page'])
    expect(await names('Acme Tracker')).toEqual(['mcp__tracker__close_issue', 'mcp__tracker__create_issue'])
    // The label only helps ranking; the model still sees the tool's own description.
    expect(
      (
        (await toolSearchTool(new MemFts()).execute({ query: 'Team Wiki' }, ctx)).content[0] as {
          text: string
        }
      ).text,
    ).toBe('mcp__wiki__edit_page — Edit a page' + unknownAvailability)
  })
})
