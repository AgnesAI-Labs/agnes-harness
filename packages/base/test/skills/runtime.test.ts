import { applyContextResults } from '@agnes/core'
import type { ExtensionAPI, HookContext, ResourceEntry, ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { ContextReturn } from '@agnes/protocol/gen/hooks'
import { describe, expect, it, vi } from 'vitest'
import { skillsExtension } from '../../extensions/skills/src/runtime.js'

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

  it('keeps every ready skill in the catalog and stays within the protocol section limit', async () => {
    const { hooks } = install({
      skillResources: {
        list: () =>
          Array.from({ length: 100 }, (_, index) => ({
            resourceId: `skill/workspace/workspace-agnes/${String(index).padStart(64, '0')}`,
            name: `skill-${index}`,
            description: 'd'.repeat(800),
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
    expect(new TextEncoder().encode(descriptions[0] ?? '').byteLength).toBeLessThan(800)
  })

  it.each([
    { count: 80, nameLength: 9, description: 'd'.repeat(815), omitted: false },
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
          Array.from({ length: 80 }, (_, index) => ({
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
    expect(descriptions.length).toBe(80)
    for (const description of descriptions) {
      expect(description.endsWith('…') || description === '界'.repeat(400)).toBe(true)
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
