import type { WorkspaceInvocationPort, WorkspaceInvocationView } from '@agnes/core'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  bindSkillRuntimeToWorkspace,
  createSkillPromptPreloader,
  explicitlyMentionsSkill,
} from '../../src/resources/skill-preload.js'

const resourceId = 'skill:review'
const body = 'Synthetic trusted instructions.'
type SkillActual = ReturnType<SkillRuntimeInput['list']>[number]
type SkillRead = ReturnType<SkillRuntimeInput['read']>

function runtime(
  overrides: Partial<SkillActual> = {},
  read: (resourceId: string, session: { sessionKey: string }) => SkillRead = () => ({
    ok: true,
    content: body,
  }),
): SkillRuntimeInput {
  return {
    list: () => [
      {
        kind: 'skill',
        resourceId,
        name: 'review',
        description: 'Synthetic test Skill',
        revision: 'a'.repeat(64),
        sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'source' },
        priority: 500,
        resolution: { winner: true, shadowed: [] },
        trust: 'trusted',
        desired: 'enabled',
        actual: 'ready',
        stale: false,
        ...overrides,
      },
    ],
    read,
    readFile: () => ({ ok: false, code: 'NOT_FOUND' as const }),
  }
}

function invocation(events: string[] = []): WorkspaceInvocationPort {
  return {
    run<T>(invoke: (view: WorkspaceInvocationView) => Promise<T>): Promise<T> {
      events.push('acquire')
      return Promise.resolve()
        .then(() => invoke({} as WorkspaceInvocationView))
        .finally(() => events.push('release'))
    },
  }
}

describe('Skill prompt preloader', () => {
  it('resolves the current generation after admission and stops preloading revoked Skills', async () => {
    let current: SkillRuntimeInput | undefined = runtime()
    const preload = createSkillPromptPreloader(
      () => current,
      () => invocation(),
    )
    const prompt = { sessionKey: 's', prompt: 'Use review' }
    const pending = preload(prompt)
    current = undefined
    await expect(pending).resolves.toBeUndefined()
    current = runtime()
    const loaded = (await preload(prompt))?.section.text ?? ''
    expect(loaded).toContain(
      `resourceId: ${resourceId}\nrevision: ${'a'.repeat(64)}\ndirectory: -\n\n${body}`,
    )
    current = runtime({ desired: 'disabled', actual: 'disabled' })
    await expect(preload(prompt)).resolves.toBeUndefined()
  })
  it('selects the acquired workspace for both extension calls and prompt preload', async () => {
    const scopes: string[] = []
    let inside = false
    const base = runtime()
    const scoped: SkillRuntimeInput = {
      ...base,
      list: () => (inside ? base.list() : []),
      async scopeWorkspace(root, sessionKey, invoke) {
        scopes.push(`${root}:${sessionKey}`)
        inside = true
        try {
          return await invoke()
        } finally {
          inside = false
        }
      },
    }
    const resolver = () => ({
      run: <T>(invoke: (view: WorkspaceInvocationView) => Promise<T>) =>
        invoke({ root: '/workspace/a' } as WorkspaceInvocationView),
    })
    const bound = bindSkillRuntimeToWorkspace(scoped, resolver)
    expect(await bound.runInWorkspace('s', async () => bound.list())).toHaveLength(1)
    const preload = await createSkillPromptPreloader(
      scoped,
      resolver,
    )({
      sessionKey: 's',
      prompt: 'Use review',
    })
    expect(preload?.section.text).toContain(body)
    expect(scopes).toEqual(['/workspace/a:s', '/workspace/a:s'])
    expect(scoped.list()).toEqual([])
  })
  it('matches normalized complete names but rejects partial names', () => {
    expect(explicitlyMentionsSkill('Use the REVIEW Skill.', 'review')).toBe(true)
    expect(explicitlyMentionsSkill('Use reviewer instructions.', 'review')).toBe(false)
    expect(explicitlyMentionsSkill('Use review-tool.', 'review')).toBe(false)
    expect(explicitlyMentionsSkill('Use review.notes.', 'review')).toBe(false)
    expect(explicitlyMentionsSkill('用stock-analysis这个skill查询', 'stock-analysis')).toBe(true)
    expect(explicitlyMentionsSkill('用stock-analysis-2这个skill查询', 'stock-analysis')).toBe(false)
    expect(explicitlyMentionsSkill('用mystock-analysis这个skill查询', 'stock-analysis')).toBe(false)
    expect(explicitlyMentionsSkill('请使用语文老师技能。', '语文老师')).toBe(true)
    expect(explicitlyMentionsSkill('请使用语文老师技能。', '语文老')).toBe(false)
  })

  it('loads one explicit ready trusted enabled winner through Host authorization', async () => {
    const read = vi.fn(() => ({ ok: true as const, content: body }))
    const preloader = createSkillPromptPreloader(runtime({}, read), () => invocation())
    const loaded = await preloader({ sessionKey: 'session-1', prompt: 'Use the review Skill.' })
    expect(loaded).toMatchObject({
      suppressTools: ['tool_search', 'skill_read'],
      section: {
        id: `skill-preload:${resourceId}`,
        source: 'runtime:skill-preload',
        text: expect.stringContaining(body),
      },
    })
    expect(loaded?.suppressTools).not.toEqual(expect.arrayContaining(['find', 'grep', 'ls']))
    expect(read).toHaveBeenCalledWith(resourceId, { sessionKey: 'session-1' })
  })

  it('preloads an English Skill name embedded in Chinese prose', async () => {
    const read = vi.fn(() => ({ ok: true as const, content: body }))
    const preloader = createSkillPromptPreloader(runtime({ name: 'stock-analysis' }, read), () =>
      invocation(),
    )
    const loaded = await preloader({ sessionKey: 'session-1', prompt: '用stock-analysis这个skill查询' })
    expect(loaded?.section.text).toContain(body)
    expect(read).toHaveBeenCalledWith(resourceId, { sessionKey: 'session-1' })
  })

  const rejected: Array<[string, Partial<SkillActual>, string, string | null | undefined, number]> = [
    ['not explicitly named', {}, 'Use the reviewer Skill.', undefined, 0],
    ['disabled', { actual: 'disabled', desired: 'disabled' }, 'Use the review Skill.', undefined, 0],
    ['untrusted', { actual: 'unavailable', trust: 'untrusted' }, 'Use the review Skill.', undefined, 0],
    [
      'shadowed',
      { actual: 'unavailable', resolution: { winner: false, shadowed: [] } },
      'Use the review Skill.',
      undefined,
      0,
    ],
    ['oversize', {}, 'Use the review Skill.', 'x'.repeat(32 * 1024 + 1), 1],
    ['read failure', {}, 'Use the review Skill.', null, 1],
  ]
  it.each(rejected)('fails closed for %s', async (_case, overrides, prompt, result, expectedReads) => {
    const read = vi.fn(() =>
      result === null
        ? { ok: false as const, code: 'UNAUTHORIZED' as const }
        : { ok: true as const, content: result ?? body },
    )
    const preloader = createSkillPromptPreloader(runtime(overrides, read), () => invocation())
    await expect(preloader({ sessionKey: 'session-1', prompt })).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledTimes(expectedReads)
  })

  it('acquires before reading resource context and releases after a failed lookup settles', async () => {
    const events: string[] = []
    const resources = runtime({}, () => {
      events.push('read')
      throw new Error('resource read failed')
    })
    const originalList = resources.list
    const observed: SkillRuntimeInput = {
      ...resources,
      list: () => {
        events.push('list')
        return originalList()
      },
    }
    const preloader = createSkillPromptPreloader(observed, () => invocation(events))

    await expect(
      preloader({ sessionKey: 'session-1', prompt: 'Use the review Skill.' }),
    ).resolves.toBeUndefined()
    expect(events).toEqual(['acquire', 'list', 'read', 'release'])
  })

  it('does not fall back to a worker-global catalogue when the session has no workspace', async () => {
    const error = Object.assign(new Error('workspace required'), { code: 'E_WORKSPACE_REQUIRED' })
    const read = vi.fn(() => ({ ok: true as const, content: body }))
    const preloader = createSkillPromptPreloader(runtime({}, read), () => {
      throw error
    })

    expect(() => preloader({ sessionKey: 'missing', prompt: 'Use the review Skill.' })).toThrow(error)
    expect(read).not.toHaveBeenCalled()
  })

  it('binds extension Skill calls to the same session invocation through settle', async () => {
    const events: string[] = []
    const bound = bindSkillRuntimeToWorkspace(runtime(), () => invocation(events))
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = bound.runInWorkspace?.('session-1', async () => {
      events.push('handler')
      await pending
      events.push('settled')
      return 'ok'
    })
    expect(events).toEqual(['acquire'])
    await Promise.resolve()
    expect(events).toEqual(['acquire', 'handler'])
    release()
    await expect(result).resolves.toBe('ok')
    expect(events).toEqual(['acquire', 'handler', 'settled', 'release'])
  })
})
