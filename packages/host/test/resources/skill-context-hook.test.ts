import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillRuntimeInput } from '../../src/resources/skills.js'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const BASE_SENTINEL = 'BASE_SENTINEL_SKILL_S00'
const OTHER_EXT_SENTINEL = 'OTHER_EXT_CONTEXT_SENTINEL_SKILL_S00'
const SKILL_BODY = 'Synthetic trusted instructions only.'
const USER_MESSAGE = 'USER_MESSAGE_SENTINEL_SKILL_S00'
const resourceId = `skill/user/user-agnes/${'a'.repeat(64)}`

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-skill-context-'))
  dirs.push(dir)
  return dir
}

function readyRuntime(
  overrides: Partial<ReturnType<SkillRuntimeInput['list']>[number]> = {},
): SkillRuntimeInput {
  return {
    list: () => [
      {
        kind: 'skill',
        resourceId,
        name: 'review',
        description: 'Review a change set.',
        revision: 'b'.repeat(64),
        sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'c'.repeat(64) },
        priority: 400,
        resolution: { winner: true, shadowed: [] },
        trust: 'trusted',
        desired: 'enabled',
        actual: 'ready',
        stale: false,
        ...overrides,
      },
    ],
    read: (id) => (id === resourceId ? { ok: true, content: SKILL_BODY } : { ok: false, code: 'NOT_FOUND' }),
    readFile: () => ({ ok: false, code: 'NOT_FOUND' as const }),
  }
}

function manyReadyRuntime(): SkillRuntimeInput {
  return {
    list: () =>
      Array.from({ length: 64 }, (_, index) => ({
        kind: 'skill' as const,
        resourceId: `skill/workspace/workspace-agnes/${String(index).padStart(64, '0')}`,
        name: `skill-${index}`,
        description: 'd'.repeat(512),
        revision: 'a'.repeat(64),
        sourceIdentity: {
          scope: 'workspace' as const,
          rootKey: 'workspace-agnes' as const,
          sourceId: String(index).padStart(64, '0'),
        },
        priority: 500,
        resolution: { winner: true, shadowed: [] },
        trust: 'trusted' as const,
        desired: 'enabled' as const,
        actual: 'ready' as const,
        stale: false,
      })),
    read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
    readFile: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
  }
}

function packages(otherContext: string) {
  return {
    '@agnes/code': {
      operations: {
        sentinel: () => ({
          name: 's00-base-sentinel',
          slot: 'before-inference' as const,
          replay: 'safe' as const,
          applicable: async () => 'applied' as const,
          run: async () => ({}),
          contribute: () => ({
            promptSections: [{ id: 'persona', order: 100, text: BASE_SENTINEL, source: 'test' }],
          }),
        }),
      },
    },
    '@agnes/base': {
      ecosystem: {
        ...baseEcosystem,
        'agnes/hooks-runner': (init: Parameters<(typeof baseEcosystem)['agnes/hooks-runner']>[0]) => {
          const inner = baseEcosystem['agnes/hooks-runner'](init)
          return (api: Parameters<typeof inner>[0]) => {
            const dispose = inner(api)
            const hook = api.registerHook('context', () => ({ additionalContext: otherContext }))
            return () => {
              hook()
              return Promise.resolve(dispose).then((cleanup) => {
                if (typeof cleanup === 'function') cleanup()
              })
            }
          }
        },
      },
    },
  }
}

function say(text: string): InferenceEvent[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', reason: 'stop' },
  ]
}

async function runPrompt(input: {
  skillResources?: SkillRuntimeInput
  otherContext?: string
  prompt: string
  inspect: (request: RequestBody) => InferenceEvent[]
}): Promise<{ request: RequestBody; overflow: unknown[] }> {
  const dataDir = scratch()
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [input.inspect],
    onExhausted: 'error',
  })
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    provider,
    ...(input.skillResources ? { skillResources: input.skillResources } : {}),
    packages: packages(input.otherContext ?? OTHER_EXT_SENTINEL),
  })
  try {
    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: input.prompt }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({ reason: 'completed' })
    const overflow = await session.scan({ type: 'x/core/hook-context-overflow', toSeq: session.lastSeq })
    const request = provider.calls[0]
    if (!request) throw new Error('provider was not called')
    return { request, overflow }
  } finally {
    await host.close()
  }
}

function expectAssembled(request: RequestBody, opts: { catalog?: boolean; preload?: boolean }) {
  expect(request.system).toContain(BASE_SENTINEL)
  expect(request.system).toContain(OTHER_EXT_SENTINEL)
  expect(JSON.stringify(request.messages)).toContain(USER_MESSAGE)
  if (opts.catalog) {
    expect(request.system).toContain('review\t')
    expect(request.system).not.toContain(resourceId)
    expect(request.system).toContain('<available_skills>')
    expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeDefined()
    expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeDefined()
  } else {
    expect(request.system).not.toContain('<available_skills>')
  }
  if (opts.preload) {
    expect(request.system).toContain(SKILL_BODY)
    expect(request.system).toContain('Host has already loaded it for this turn')
    expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeUndefined()
    expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeUndefined()
  } else {
    expect(request.system).not.toContain(SKILL_BODY)
    expect(request.system).not.toContain('Host has already loaded it for this turn')
  }
}

describe('skill context hook assembly', () => {
  it('keeps base prompt, other extension context, Skill catalog and the user message on a generic query', async () => {
    const { request } = await runPrompt({
      skillResources: readyRuntime(),
      prompt: `Please help. ${USER_MESSAGE}`,
      inspect: (request) => {
        expectAssembled(request, { catalog: true, preload: false })
        return say('ok')
      },
    })
    expect(request.system).not.toContain('E_ENVELOPE')
  })

  it('does not inject a catalog when no Skill is ready and still keeps base prompt and other context', async () => {
    await runPrompt({
      skillResources: readyRuntime({ actual: 'unavailable', trust: 'untrusted', desired: 'disabled' }),
      prompt: `Please help. ${USER_MESSAGE}`,
      inspect: (request) => {
        expectAssembled(request, { catalog: false, preload: false })
        expect(request.system).not.toContain(resourceId)
        return say('ok')
      },
    })
  })

  it('keeps base prompt when an explicitly named Skill is preloaded and does not hide later generic discovery', async () => {
    const dataDir = scratch()
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        (request) => {
          expect(request.system).toContain(BASE_SENTINEL)
          expect(request.system).toContain(OTHER_EXT_SENTINEL)
          expect(request.system).toContain(resourceId)
          expect(request.system).toContain(SKILL_BODY)
          expect(request.system).toContain('Host has already loaded it for this turn')
          expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeUndefined()
          expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeUndefined()
          expect(JSON.stringify(request.messages)).toContain('Use the review Skill.')
          return say('loaded')
        },
        (request) => {
          expectAssembled(request, { catalog: true, preload: false })
          expect(request.system).toContain('review\t')
          return say('discovered')
        },
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
      skillResources: readyRuntime(),
      packages: packages(OTHER_EXT_SENTINEL),
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Use the review Skill.' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: `Can you find my listed Skill? ${USER_MESSAGE}` }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })
      expect(provider.calls).toHaveLength(2)
    } finally {
      await host.close()
    }
  })

  it('preserves base prompt when Skill catalog and another hook compete for the additionalContext budget', async () => {
    const crowded = `${OTHER_EXT_SENTINEL}\n${'Y'.repeat(8000)}`
    const { request } = await runPrompt({
      skillResources: manyReadyRuntime(),
      otherContext: crowded,
      prompt: `Please help. ${USER_MESSAGE}`,
      inspect: (request) => {
        expect(request.system).toContain(BASE_SENTINEL)
        expect(request.system).toContain(OTHER_EXT_SENTINEL)
        expect(JSON.stringify(request.messages)).toContain(USER_MESSAGE)
        return say('ok')
      },
    })
    expect(request.system).toContain('<available_skills>')
    expect(request.system).toContain(BASE_SENTINEL)
    const catalogStart = request.system.indexOf('<available_skills>')
    const catalogEnd = request.system.indexOf('</available_skills>')
    const catalog = request.system.slice(catalogStart, catalogEnd)
    expect(catalog).not.toContain(OTHER_EXT_SENTINEL)
    expect(request.system).toContain(OTHER_EXT_SENTINEL)
  })
})
