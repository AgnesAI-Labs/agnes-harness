import { applyContextResults } from '@agnes/core'
import type { ExtensionAPI, HookContext, ResourceEntry, ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { ContextReturn } from '@agnes/protocol/gen/hooks'
import { describe, expect, it, vi } from 'vitest'
import { toolSearchTool } from '../../extensions/mcp-search/src/search-tools.js'
import { skillsExtension } from '../../extensions/skills/src/runtime.js'
import { MemFts } from '../../testkit/mem-fts.js'
import { fakeToolContext } from '../../testkit/tool-context.js'

const BASE_SENTINEL = 'BASE_SENTINEL_SKILL_S00'
const baseSection = { id: 'persona', order: 100, text: BASE_SENTINEL, source: 'core' }
const historicalAuthorSections = {
  sections: [
    {
      id: 'skills',
      order: 150,
      content: 'Skill resources are available below.',
      source: 'agnes/skills',
    },
  ],
}
const fieldOnlyProtocolSections = {
  sections: [{ id: 'skills', order: 150, text: 'Skill resources are available below.' }],
}

const runInWorkspace = async <T>(_sessionKey: string, invoke: () => Promise<T>): Promise<T> => invoke()

function authorCatalog(result: unknown): string {
  return (result as { sections?: Array<{ content?: string }> }).sections?.[0]?.content ?? ''
}

function wireContext(result: unknown): ContextReturn {
  const value = result as { sections?: Array<{ id: string; order: number; content: string }> }
  if (!value.sections) return {}
  return {
    sections: value.sections.map((section) => ({
      id: section.id,
      order: section.order,
      text: section.content,
    })),
  }
}

function install(runtime: Parameters<typeof skillsExtension>[0]) {
  const resources: ResourceEntry[] = []
  const tools: ToolDef[] = []
  const hooks = new Map<string, (payload: unknown, context?: HookContext) => unknown>()
  skillsExtension(runtime)({
    registerTool(tool: ToolDef) {
      tools.push(tool)
      return () => undefined
    },
    registerHook(event: string, handler: (payload: unknown, context?: HookContext) => unknown) {
      hooks.set(event, handler)
      return () => undefined
    },
    registerResource(resource: ResourceEntry) {
      resources.push(resource)
      return () => undefined
    },
  } as unknown as ExtensionAPI)
  return { resources, tools, hooks }
}

describe('skill runtime extension', () => {
  it('holds the Host workspace invocation around context and body reads', async () => {
    const events: string[] = []
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const { tools, hooks } = install({
      skillResources: {
        list: () => {
          events.push('list')
          return [
            {
              resourceId,
              name: 'review',
              revision: 'b'.repeat(64),
              sourceIdentity: {
                scope: 'workspace',
                rootKey: 'workspace-agnes',
                sourceId: 'a'.repeat(64),
              },
              actual: 'ready' as const,
            },
          ]
        },
        read: () => {
          events.push('read')
          return { ok: true as const, content: 'body' }
        },
        runInWorkspace: async <T>(sessionKey: string, invoke: () => Promise<T>): Promise<T> => {
          events.push(`acquire:${sessionKey}`)
          try {
            return await invoke()
          } finally {
            events.push(`release:${sessionKey}`)
          }
        },
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    expect(events).toEqual([])

    await expect(
      hooks.get('context')?.({}, { session: { key: 'session-1' } } as HookContext),
    ).resolves.toMatchObject({
      sections: [{ id: 'skills', order: 160, content: expect.stringContaining('review\t') }],
    })
    expect(events).toEqual(['acquire:session-1', 'list', 'release:session-1'])
    events.length = 0

    await expect(
      tools
        .find((tool) => tool.name === 'skill_read')
        ?.execute(
          { name: 'review' } as never,
          { session: { key: 'session-1' }, artifacts: { put: vi.fn() } } as never,
        ),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('body') }],
    })
    expect(events).toEqual(['acquire:session-1', 'list', 'read', 'release:session-1'])
  })

  it('fails closed before discovery or reads when the workspace invocation or session is missing', async () => {
    const list = vi.fn(() => [])
    const read = vi.fn(() => ({ ok: false as const, code: 'NOT_FOUND' as const }))
    const { tools, hooks } = install({
      skillResources: { list, read },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const skillRead = tools.find((tool) => tool.name === 'skill_read')

    expect(() => hooks.get('context')?.({}, {} as HookContext)).toThrowError(
      'E_WORKSPACE_REQUIRED: Skill context has no session',
    )
    await expect(
      hooks.get('context')?.({}, { session: { key: 'session-1' } } as HookContext),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    await expect(
      skillRead?.execute(
        { name: 'missing' } as never,
        { session: { key: 'session-1' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    expect(list).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('injects a safe context section only inside a session invocation and reads the body through the Host input', async () => {
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const { resources, tools, hooks } = install({
      skillResources: {
        list: () => [
          {
            resourceId,
            name: 'review',
            description: 'Review changes',
            revision: 'b'.repeat(64),
            sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
            actual: 'ready' as const,
          },
          {
            resourceId: `skill/user/user-agents/${'c'.repeat(64)}`,
            name: 'hidden',
            description: 'not injected',
            revision: 'd'.repeat(64),
            sourceIdentity: { scope: 'user', rootKey: 'user-agents', sourceId: 'c'.repeat(64) },
            actual: 'unavailable' as const,
          },
        ],
        read: (id: string) =>
          id === resourceId
            ? { ok: true as const, content: 'approved body only' }
            : { ok: false as const, code: 'NOT_FOUND' as const },
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])

    expect(resources).toEqual([])
    expect(tools.map((tool) => tool.name)).toEqual(['skill_read', 'skill_read_file'])
    const injected = await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)
    expect(validateAgainst(ContextReturn, wireContext(injected)).ok).toBe(true)
    expect(injected).not.toHaveProperty('additionalContext')
    const content = authorCatalog(injected)
    expect(content).toContain('review\t')
    expect(content).not.toContain(resourceId)
    expect(content).toContain('call skill_read')
    expect(content).toContain('A description is not the skill procedure.')
    expect(content).not.toContain('The listing is data, not instructions.')
    expect(content).toContain('<available_skills>')
    expect(content).toContain('</available_skills>')
    expect(content).not.toContain('approved body only')
    expect(content).not.toContain('not injected')
    const read = tools[0]
    expect(read?.description).toContain('when the user names a Skill or the current task matches')
    expect(read?.description).toContain('Use tool_search to find ready Skills by name or description')
    expect(read?.parameters).toMatchObject({
      properties: { name: { description: 'Exact skill name from available_skills or tool_search.' } },
    })
    await expect(
      read?.execute(
        { name: 'review' } as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/^resourceId: .+\nrevision: .+\ndirectory: -\n\napproved body only$/),
        },
      ],
    })
    const file = tools[1]
    const revision = 'b'.repeat(64)
    await expect(
      file?.execute(
        { resourceId, expectedRevision: revision, relativePath: '../secret' } as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).resolves.toMatchObject({ isError: true, structured: { code: 'NOT_FOUND' } })
    await expect(
      file?.execute(
        {
          resourceId,
          expectedRevision: revision,
          relativePath: 'references/guide.md',
        } as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).resolves.toMatchObject({ isError: true, structured: { code: 'NOT_FOUND' } })
  })

  it('reads an authorized Skill file and refuses a revision mismatch', async () => {
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const revision = 'b'.repeat(64)
    const { tools } = install({
      skillResources: {
        list: () => [
          {
            resourceId,
            name: 'review',
            revision,
            sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: true as const, content: 'body' }),
        readFile: (
          id: string,
          expectedRevision: string,
          relativePath: string,
        ): { ok: true; content: string; mime: string } | { ok: false; code: 'UNTRUSTED_REVISION' } =>
          id === resourceId && expectedRevision === revision && relativePath === 'references/guide.md'
            ? { ok: true, content: '# guide', mime: 'text/markdown' }
            : { ok: false, code: 'UNTRUSTED_REVISION' },
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const file = tools.find((tool) => tool.name === 'skill_read_file')
    await expect(
      file?.execute(
        { resourceId, expectedRevision: revision, relativePath: 'references/guide.md' } as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: '# guide' }] })
    await expect(
      file?.execute(
        { resourceId, expectedRevision: 'c'.repeat(64), relativePath: 'references/guide.md' } as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ),
    ).resolves.toMatchObject({ isError: true, structured: { code: 'UNTRUSTED_REVISION' } })
  })

  it('pages a long Skill through UTF-8 boundaries and binds continuation to the read content', async () => {
    const name = `${'界'.repeat(127)}"`
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    let body = `${'😀界\n'.repeat(19_320)}${'x'.repeat(40_000)}`
    let revision = 'b'.repeat(64)
    const put = vi.fn()
    const { tools } = install({
      skillResources: {
        list: () => [
          {
            resourceId,
            name,
            revision,
            sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: true as const, content: body, revision }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const read = tools.find((tool) => tool.name === 'skill_read')
    const call = async (args: Record<string, unknown>) =>
      read?.execute(args as never, { session: { key: 's' }, artifacts: { put } } as never) as Promise<{
        content: Array<{ type: string; text?: string }>
        structured: { offset: number; totalBytes: number; nextOffset?: number; code?: string }
        isError?: boolean
      }>
    const first = await call({ name })
    expect(first.content).toHaveLength(1)
    expect(first.structured.nextOffset).toBeGreaterThan(0)
    expect(first.content[0]?.text).toMatch(/^resourceId: .+\nrevision: .+\ndirectory: -\n\n/u)
    expect(first.content[0]?.text).toContain(`"name":${JSON.stringify(name)}`)
    expect(put).not.toHaveBeenCalled()

    const nextCall = JSON.parse(first.content[0]?.text?.match(/call skill_read with (\{.*\})\]$/u)?.[1] ?? '')
    revision = 'c'.repeat(64)
    await expect(call(nextCall)).resolves.toMatchObject({ isError: true, structured: { code: 'CHANGED' } })
    revision = 'b'.repeat(64)
    body += 'changed'
    await expect(call(nextCall)).resolves.toMatchObject({ isError: true, structured: { code: 'CHANGED' } })
    body = body.slice(0, -7)
    await expect(call({ name, offset: 1 })).resolves.toMatchObject({
      isError: true,
      structured: { code: 'INVALID_ARGUMENT' },
    })
    await expect(call({ name, offset: 2, pageKey: nextCall.pageKey })).resolves.toMatchObject({
      isError: true,
      structured: { code: 'INVALID_OFFSET' },
    })
    await expect(call({ name, offset: 0, pageKey: '0'.repeat(64) })).resolves.toMatchObject({
      isError: true,
      structured: { code: 'CHANGED' },
    })
    await expect(
      call({ name, offset: new TextEncoder().encode(body).byteLength, pageKey: nextCall.pageKey }),
    ).resolves.toMatchObject({ isError: true, structured: { code: 'INVALID_OFFSET' } })

    const source = new TextEncoder().encode(body)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let args: Record<string, unknown> = { name }
    let offset = 0
    let pages = 0
    while (true) {
      const page = await call(args)
      expect(page.isError).not.toBe(true)
      expect(new TextEncoder().encode(page.content[0]?.text ?? '').byteLength).toBeLessThanOrEqual(32768)
      expect(page.structured).toMatchObject({ offset, totalBytes: source.byteLength })
      const end = page.structured.nextOffset ?? source.byteLength
      const visible = (page.content[0]?.text ?? '')
        .split('\n\n')
        .slice(1)
        .join('\n\n')
        .replace(/\n\[Skill text continues:.*\]$/u, '')
      expect(visible).toBe(decoder.decode(source.subarray(offset, end)))
      pages++
      if (end === source.byteLength) break
      args = JSON.parse(page.content[0]?.text?.match(/call skill_read with (\{.*\})\]$/u)?.[1] ?? '')
      offset = end
    }
    expect(pages).toBeGreaterThan(2)
    expect(put).not.toHaveBeenCalled()
  })

  it('invalidates a continuation when the selected resource or directory changes', async () => {
    const ids = ['a', 'c'].map((letter) => `skill/workspace/workspace-agnes/${letter.repeat(64)}`)
    const revision = 'b'.repeat(64)
    let selected = 0
    let directory = 'references/one.md'
    const body = 'x'.repeat(100_000)
    const { tools } = install({
      skillResources: {
        list: () => [
          {
            resourceId: ids[selected],
            name: 'review',
            revision,
            sourceIdentity: {
              scope: 'workspace',
              rootKey: 'workspace-agnes',
              sourceId: ['a', 'c'][selected]?.repeat(64),
            },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: true as const, revision, content: `${body}\nDirectory: ${directory}` }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const read = tools.find((tool) => tool.name === 'skill_read')
    const call = async (args: Record<string, unknown>) =>
      read?.execute(
        args as never,
        { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
      ) as Promise<{
        content: Array<{ text?: string }>
        structured: { code?: string }
        isError?: boolean
      }>
    const first = await call({ name: 'review' })
    const nextCall = JSON.parse(first.content[0]?.text?.match(/call skill_read with (\{.*\})\]$/u)?.[1] ?? '')
    selected = 1
    await expect(call(nextCall)).resolves.toMatchObject({ isError: true, structured: { code: 'CHANGED' } })
    selected = 0
    directory = 'references/two.md'
    await expect(call(nextCall)).resolves.toMatchObject({ isError: true, structured: { code: 'CHANGED' } })
  })

  it('keeps short Skill output byte-for-byte at the 32 KiB boundary', async () => {
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const revision = 'b'.repeat(64)
    const header = `resourceId: ${resourceId}\nrevision: ${revision}\ndirectory: -\n\n`
    const body = 'x'.repeat(32768 - new TextEncoder().encode(header).byteLength)
    const { tools } = install({
      skillResources: {
        list: () => [
          {
            resourceId,
            name: 'review',
            revision,
            sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: true as const, content: body, revision }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const read = tools.find((tool) => tool.name === 'skill_read')
    const result = await read?.execute(
      { name: 'review' } as never,
      { session: { key: 's' }, artifacts: { put: vi.fn() } } as never,
    )
    expect(result?.content).toEqual([{ type: 'text', text: header + body }])
    const visible = result?.content[0]
    expect(new TextEncoder().encode(visible?.type === 'text' ? visible.text : '').byteLength).toBe(32768)
    expect(result?.structured).not.toHaveProperty('nextOffset')
  })

  it('pages long text attachments while binary attachments remain resource references', async () => {
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const revision = 'b'.repeat(64)
    const body = `${'界😀\n'.repeat(15_000)}${'x'.repeat(20_000)}`
    const put = vi.fn(async () => 'artifact://image')
    const { tools } = install({
      skillResources: {
        list: () => [],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        readFile: (_id: string, _revision: string, relativePath: string) =>
          relativePath === 'image.png'
            ? {
                ok: true as const,
                bytes: new Uint8Array([1, 2, 3]),
                mime: 'image/png',
                binary: true as const,
              }
            : { ok: true as const, content: body, mime: 'text/markdown' },
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const file = tools.find((tool) => tool.name === 'skill_read_file')
    const call = async (relativePath: string, offset = 0) =>
      file?.execute(
        { resourceId, expectedRevision: revision, relativePath, offset } as never,
        { session: { key: 's' }, artifacts: { put } } as never,
      ) as Promise<{
        content: Array<{ type: string; text?: string }>
        structured: { offset: number; totalBytes: number; nextOffset?: number; code?: string }
        isError?: boolean
      }>
    let offset = 0
    let collected = ''
    let pages = 0
    while (true) {
      const page = await call('guide.md', offset)
      expect(new TextEncoder().encode(page.content[0]?.text ?? '').byteLength).toBeLessThanOrEqual(32768)
      collected += (page.content[0]?.text ?? '').replace(/\n\[Skill file continues:.*\]$/u, '')
      pages++
      if (page.structured.nextOffset === undefined) break
      offset = page.structured.nextOffset
    }
    expect(pages).toBeGreaterThan(2)
    expect(collected).toBe(body)
    expect(put).not.toHaveBeenCalled()
    await expect(call('guide.md', 1)).resolves.toMatchObject({
      isError: true,
      structured: { code: 'INVALID_OFFSET' },
    })
    await expect(call('image.png')).resolves.toMatchObject({
      content: [{ type: 'ref', ref: 'artifact://image' }],
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('keeps every ready skill in the catalog and stays within the protocol section limit', async () => {
    const { hooks } = install({
      skillResources: {
        list: () =>
          Array.from({ length: 100 }, (_, index) => ({
            resourceId: `skill/workspace/workspace-agnes/${String(index).padStart(64, '0')}`,
            name: `skill-${index}`,
            description: '界'.repeat(400),
            revision: 'a'.repeat(64),
            sourceIdentity: {
              scope: 'workspace',
              rootKey: 'workspace-agnes',
              sourceId: String(index).padStart(64, '0'),
            },
            actual: 'ready' as const,
          })),
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = (await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)) as {
      sections?: Array<{ id: string; text: string }>
    }
    expect(validateAgainst(ContextReturn, wireContext(injected)).ok).toBe(true)
    const text = authorCatalog(injected)
    expect(injected.sections?.[0]?.id).toBe('skills')
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(65536)
    expect(text).toContain('skill-0\t')
    expect(text).toContain('skill-99\t')
    expect(text).not.toContain('omitted ')
    expect(text).not.toMatch(/^catalog\t/mu)
    const descriptions = [...text.matchAll(/^skill-\d+\t(.*)$/gmu)].map((match) => match[1] ?? '')
    expect(descriptions).toHaveLength(100)
    expect(new Set(descriptions.map((item) => new TextEncoder().encode(item).byteLength)).size).toBe(1)
    expect(new TextEncoder().encode(descriptions[0] ?? '').byteLength).toBeLessThan(
      new TextEncoder().encode(`${'界'.repeat(249)}…`).byteLength,
    )
  })

  it.each([
    { count: 90, nameLength: 9, description: '界'.repeat(400), omitted: false },
    { count: 500, nameLength: 128, description: '界🙂', omitted: false },
    { count: 600, nameLength: 128, description: '界🙂', omitted: true },
  ])('keeps accurate catalog coverage with $count rows of name length $nameLength', async (fixture) => {
    const skills = Array.from({ length: fixture.count }, (_, index) => ({
      resourceId: `skill/user/${index}`,
      name: `skill-${String(index).padStart(3, '0')}`.padEnd(fixture.nameLength, 'n'),
      description: fixture.description,
      revision: 'a'.repeat(64),
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: String(index) },
      actual: 'ready' as const,
    }))
    const read = vi.fn(() => ({ ok: false as const, code: 'NOT_FOUND' as const }))
    const { hooks } = install({
      skillResources: { list: () => skills, read, runInWorkspace },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)
    const text = authorCatalog(injected)
    const lines = text.split('\n').filter((line) => line.includes('\t'))
    expect(validateAgainst(ContextReturn, wireContext(injected)).ok).toBe(true)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(65536)
    expect(lines.map((line) => line.split('\t')[0])).toEqual(
      skills.slice(0, lines.length).map((skill) => skill.name),
    )
    if (fixture.omitted) {
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThan(skills.length)
      expect(text).toContain(`omitted ${skills.length - lines.length} skills; use tool_search\n`)
    } else {
      expect(lines).toHaveLength(skills.length)
      expect(text).not.toContain('omitted ')
    }
    if (fixture.nameLength === 128) expect(lines.every((line) => line.endsWith('\t'))).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('caps each catalog description at 250 UTF-16 units while tool_search keeps the full text', async () => {
    const skill = (name: string, description: string, index: number) => ({
      resourceId: `skill/user/user-agnes/${String(index).padStart(64, 'c')}`,
      name,
      description,
      revision: 'a'.repeat(64),
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: String(index).padStart(64, 'c') },
      actual: 'ready' as const,
    })
    const long = `${'x'.repeat(1023)}y`
    const skills = [
      skill('cap-long', long, 1),
      skill('cap-surrogate', `${'a'.repeat(248)}😀${'b'.repeat(100)}`, 2),
      skill('cap-exact', 'e'.repeat(250), 3),
      skill('cap-ellipsis', `${'m'.repeat(248)}…${'n'.repeat(10)}`, 4),
      skill('cap-space', `${'s'.repeat(248)} ${'t'.repeat(10)}`, 5),
    ]
    const discovery = { list: () => skills, runInWorkspace }
    const { hooks } = install({
      skillResources: { ...discovery, read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }) },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const text = authorCatalog(await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext))
    const row = (name: string) => new RegExp(`^${name}\\t(.*)$`, 'mu').exec(text)?.[1]

    expect(row('cap-long')).toBe(`${'x'.repeat(249)}…`)
    expect(row('cap-long')).toHaveLength(250)
    expect(row('cap-surrogate')).toBe(`${'a'.repeat(248)}…`)
    expect(row('cap-exact')).toBe('e'.repeat(250))
    expect(row('cap-ellipsis')).toBe(`${'m'.repeat(248)}…`)
    expect(row('cap-space')).toBe(`${'s'.repeat(248)}…`)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)

    const search = toolSearchTool(new MemFts(), discovery as never)
    const found = await search.execute({ query: 'cap-long' }, fakeToolContext())
    expect((found.content[0] as { text: string }).text).toContain(`Skill cap-long — ${long}\n`)
  })

  it('keys the catalog on the capped text', async () => {
    const skill = {
      resourceId: `skill/user/user-agnes/${'d'.repeat(64)}`,
      name: 'cap-key',
      description: 'k'.repeat(400),
      revision: 'a'.repeat(64),
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'd'.repeat(64) },
      actual: 'ready' as const,
    }
    const { hooks } = install({
      skillResources: {
        list: () => [skill],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const render = async () =>
      authorCatalog(await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext))
    const first = await render()
    expect(await render()).toBe(first)
    skill.description = `${'k'.repeat(299)}Z${'k'.repeat(100)}`
    expect(await render()).toBe(first)
    skill.description = `${'k'.repeat(9)}Z${'k'.repeat(390)}`
    expect(await render()).not.toBe(first)
  })

  it('logs one count-only warning when the catalog is shortened', async () => {
    const warn = vi.fn()
    const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
    const skills = Array.from({ length: 100 }, (_, index) => ({
      resourceId: `skill/user/user-agnes/${String(index).padStart(64, 'b')}`,
      name: `warn-${index}`,
      description: '界'.repeat(400),
      revision: 'a'.repeat(64),
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: String(index).padStart(64, 'b') },
      actual: 'ready' as const,
    }))
    const { hooks } = install({
      skillResources: {
        list: () => skills,
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const context = { session: { key: 's' }, log } as unknown as HookContext
    await hooks.get('context')?.({}, context)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('skill catalog exceeded its budget', {
      ready: 100,
      listed: 100,
      descriptionBytes: expect.any(Number),
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('warn-')
    await hooks.get('context')?.({}, context)
    expect(warn).toHaveBeenCalledTimes(1)

    skills.splice(10)
    await hooks.get('context')?.({}, context)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the catalog stable when only a revision changes', async () => {
    const skill = {
      resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
      name: 'review',
      description: 'Review changes',
      revision: 'b'.repeat(64),
      sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
      actual: 'ready' as const,
    }
    const { hooks } = install({
      skillResources: {
        list: () => [skill],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const read = async () => {
      const injected = (await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)) as {
        sections?: Array<{ text: string }>
      }
      return authorCatalog(injected)
    }
    const first = await read()
    expect(await read()).toBe(first)
    skill.revision = 'c'.repeat(64)
    expect(await read()).toBe(first)
    skill.description = 'Review the other changes'
    expect(await read()).not.toBe(first)
  })

  it('clips descriptions on a UTF-8 boundary', async () => {
    const { hooks } = install({
      skillResources: {
        list: () =>
          Array.from({ length: 100 }, (_, index) => ({
            resourceId: `skill/workspace/workspace-agnes/${String(index).padStart(64, 'e')}`,
            name: `wide-${index}`,
            description: '界'.repeat(400),
            revision: 'a'.repeat(64),
            sourceIdentity: {
              scope: 'workspace',
              rootKey: 'workspace-agnes',
              sourceId: String(index).padStart(64, 'e'),
            },
            actual: 'ready' as const,
          })),
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = (await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)) as {
      sections?: Array<{ text: string }>
    }
    const text = authorCatalog(injected)
    const descriptions = [...text.matchAll(/^wide-\d+\t(.*)$/gmu)].map((match) => match[1] ?? '')
    expect(descriptions.length).toBe(100)
    for (const description of descriptions) {
      expect(description.endsWith('…')).toBe(true)
      expect(description.length).toBeLessThan(250)
      expect(() =>
        new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(description)),
      ).not.toThrow()
    }
  })

  it('lists a tail skill that the old 8 KiB catalog dropped', async () => {
    const lastId = `skill/user/user-agents/${'f'.repeat(64)}`
    const { hooks } = install({
      skillResources: {
        list: () => [
          ...Array.from({ length: 44 }, (_, index) => ({
            resourceId: `skill/user/user-agents/${String(index).padStart(64, 'a')}`,
            name: `skill-${String(index).padStart(2, '0')}`,
            description: 'd'.repeat(200),
            revision: 'b'.repeat(64),
            sourceIdentity: {
              scope: 'user' as const,
              rootKey: 'user-agents' as const,
              sourceId: 'a'.repeat(64),
            },
            actual: 'ready' as const,
          })),
          {
            resourceId: lastId,
            name: 'web-access',
            description: 'Fetch pages that need a browser. UNIQUE_TAIL_MARK',
            revision: 'c'.repeat(64),
            sourceIdentity: {
              scope: 'user' as const,
              rootKey: 'user-agents' as const,
              sourceId: 'f'.repeat(64),
            },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = (await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)) as {
      sections?: Array<{ text: string }>
    }
    const text = authorCatalog(injected)
    expect(text).toContain('web-access\t')
    expect(text).not.toContain(lastId)
    expect(text).toContain('UNIQUE_TAIL_MARK')
    expect(text).not.toContain('C:\\')
    expect(text).not.toContain('/home/')
  })

  it('returns nothing when no Skill is ready', async () => {
    const { hooks } = install({
      skillResources: {
        list: () => [
          {
            resourceId: `skill/user/user-agnes/${'e'.repeat(64)}`,
            name: 'hidden',
            description: 'not injected',
            revision: 'f'.repeat(64),
            sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'e'.repeat(64) },
            actual: 'unavailable' as const,
          },
        ],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = await hooks.get('context')?.({}, { session: { key: 's' } } as HookContext)
    expect(injected).toEqual({})
    expect(validateAgainst(ContextReturn, wireContext(injected)).ok).toBe(true)
    const applied = applyContextResults(
      [baseSection],
      [{ ext: 'agnes/skills', result: wireContext(injected) }],
    )
    expect(applied.sections).toEqual([baseSection])
  })

  it('rejects the historical author-shaped sections payload at the protocol boundary', () => {
    expect(validateAgainst(ContextReturn, historicalAuthorSections).ok).toBe(false)
    expect(() =>
      applyContextResults(
        [baseSection],
        [{ ext: 'agnes/skills', result: historicalAuthorSections as never }],
      ),
    ).toThrow('E_ENVELOPE')
  })

  it('keeps the base sentinel when only the protocol field names are repaired on a replacement section', () => {
    expect(validateAgainst(ContextReturn, fieldOnlyProtocolSections).ok).toBe(true)
    const applied = applyContextResults(
      [baseSection],
      [{ ext: 'agnes/skills', result: fieldOnlyProtocolSections }],
    )
    expect(applied.sections.map((section) => section.id)).toEqual(['persona', 'skills'])
    expect(applied.sections.some((section) => section.text.includes(BASE_SENTINEL))).toBe(true)
  })

  it('keeps the base sentinel when the live handler return is applied', async () => {
    const resourceId = `skill/workspace/workspace-agnes/${'a'.repeat(64)}`
    const { hooks } = install({
      skillResources: {
        list: () => [
          {
            resourceId,
            name: 'review',
            description: 'Review changes',
            revision: 'b'.repeat(64),
            sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
            actual: 'ready' as const,
          },
        ],
        read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
        runInWorkspace,
      },
    } as unknown as Parameters<typeof skillsExtension>[0])
    const injected = await hooks.get('context')?.({}, {
      session: { key: 's' },
    } as HookContext)
    const other = { additionalContext: 'OTHER_EXT_CONTEXT_SENTINEL_SKILL_S00' }
    const applied = applyContextResults(
      [baseSection],
      [
        { ext: 'agnes/tools-core', result: other },
        { ext: 'agnes/skills', result: wireContext(injected) },
      ],
    )
    expect(applied.sections.some((section) => section.text.includes(BASE_SENTINEL))).toBe(true)
    expect(applied.sections.find((section) => section.id === 'skills')?.text).toContain('review\t')
    expect(applied.sections.find((section) => section.id === 'skills')?.text).not.toContain(resourceId)
    expect(applied.sections.find((section) => section.id === 'skills')?.order).toBe(160)
    expect(applied.sections.some((section) => section.text.includes(other.additionalContext))).toBe(true)
    expect(applied.sections.find((section) => section.id === 'additional-context')?.text ?? '').not.toContain(
      '<available_skills>',
    )
    expect(
      new TextEncoder().encode(
        applied.sections.find((section) => section.id === 'additional-context')?.text ?? '',
      ).byteLength,
    ).toBeLessThanOrEqual(8192)
  })
})
