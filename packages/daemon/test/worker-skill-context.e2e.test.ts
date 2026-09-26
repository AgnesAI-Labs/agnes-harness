import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { canonicalJson, sha256hex } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { bootstrapWorkerResources, scanSkills } from '@agnes/resource-control-worker'
import { afterEach, expect, it } from 'vitest'
import { workspaceBinding } from './workspace-authority.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const roots: string[] = []
// This test Host has a narrower profile than the user-facing Web process, whose observed generic
// schema starts f6befbfe. Within this fixed production assembly the generic request remains stable;
// an explicitly loaded Skill must produce the distinct, discovery-tool-free schema below.
// 2026-09-15: v1 same-instance subagent tools (fork/spawn/collect/cancel) join the disclosed
// surface. Preload still suppresses tool_search and skill_read. Hashes re-measured on the
// current assembly; previous pins a27a12ea / 513280f4 predate those four tools.
// 2026-09-22: both the legacy explicit-cwd and shared-worker paths produce these hashes;
// complete tool-name assertions below remain unchanged across the merged dependency/schema update.
// Pagination adds skill_read offset/pageKey and skill_read_file offset to the disclosed schemas.
const TEST_DISCOVERY_TOOL_SCHEMA_HASH = 'c35a8f64eefcf614f96ae3f4eb3f2c221091f4f3973f07d79cee004dd12efa69'
const ACTIVE_SKILL_TOOL_SCHEMA_HASH = 'a6172175c1ba66fa365e505ad8995c61498bf2bdb39eeaf1e1663e6d76d6b66e'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const barrier = {
  quiesce: async <T>(_operationId: string, publish: (permit: unknown) => Promise<T>): Promise<T> =>
    publish({}),
}

it.each([false, true])('preloads and discovers workspace Skills with shared worker = %s', async (shared) => {
  // Skill identity must use the same canonical workspace as the Host session (macOS /var alias).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-worker-skill-context-')))
  roots.push(root)
  const dataDir = join(root, 'agnes-home')
  const homeDir = join(root, 'worker-home')
  const workspace = join(dataDir, 'workspace')
  const skillDir = join(workspace, '.agh', 'skills', 'review')
  const snapshot = join(root, 'resource-snapshot.json')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: chinese-teacher\ndescription: Teach Chinese poetry\n---\nSynthetic test instructions only.',
  )

  const discovered = await scanSkills(workspace, undefined, undefined, homeDir)
  const candidate = discovered.roots.find((root) => root.rootKey === 'workspace-agnes')?.candidates[0]
  if (!candidate) throw new Error('test Skill was not discovered')
  await writeFile(
    snapshot,
    JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: {
        control: {
          desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
          trust: [
            {
              resourceId: candidate.resourceId,
              revision: candidate.revision,
              capabilityHash: candidate.capabilityHash,
              state: 'trusted',
            },
          ],
        },
      },
      mcp: [],
    }),
  )

  const boot = () =>
    bootstrapWorkerResources({
      env: { AGNES_RESOURCE_SNAPSHOT: snapshot, HOME: homeDir },
      ...(shared ? {} : { cwd: workspace }),
      profile: { name: 'local-dev', dataDir, adapters: { secrets: { kind: 'env' } } } as never,
      createBarrier: () => barrier,
      createSecrets: () => ({ resolve: () => '' }),
    })
  const resources = await boot()
  if (!resources) throw new Error('worker bootstrap did not return the managed Skill snapshot')
  // Production chat workers are shared: startup has no cwd; Host selects it per invocation.
  if (shared) expect(resources.skills).toEqual([])
  else expect(resources.skills).toMatchObject([{ resourceId: candidate.resourceId, actual: 'ready' }])

  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [
      (request) => {
        expect(request.system).toContain(candidate.resourceId)
        expect(request.system).toContain('Synthetic test instructions only.')
        expect(request.system).toContain('Host has already loaded it for this turn')
        expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeUndefined()
        expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeUndefined()
        expect(request.tools.find((tool) => tool.name === 'find')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'grep')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'ls')).toBeDefined()
        expect(request.tools.map((tool) => tool.name).sort()).toEqual([
          'compact',
          'edit',
          'find',
          'grep',
          'ls',
          'read',
          'shell',
          'skill_read_file',
          'subagent_cancel',
          'subagent_collect',
          'subagent_fork',
          'subagent_spawn',
          'todo',
          'tool_describe',
          'web_fetch',
          'write',
        ])
        return [
          { type: 'text_delta', delta: 'Read the synthetic Skill.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeDefined()
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(request.tools.map((tool) => tool.name).sort()).toEqual([
          'compact',
          'edit',
          'find',
          'grep',
          'ls',
          'read',
          'shell',
          'skill_read',
          'skill_read_file',
          'subagent_cancel',
          'subagent_collect',
          'subagent_fork',
          'subagent_spawn',
          'todo',
          'tool_describe',
          'tool_search',
          'web_fetch',
          'write',
        ])
        expect(request.system).toContain('<available_skills>')
        expect(request.system).toContain('chinese-teacher')
        expect(request.system).not.toContain(candidate.resourceId)
        return [
          {
            type: 'toolcall_end',
            call: {
              toolUseId: '',
              name: 'skill_read',
              args: { name: 'chinese-teacher' },
              ordinal: 0,
            },
            via: 'native',
          },
          { type: 'done', reason: 'toolUse' },
        ]
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Synthetic test instructions only.')
        return [
          { type: 'text_delta', delta: 'The Skill instructions are ready.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(request.system).not.toContain(candidate.resourceId)
        return [
          { type: 'text_delta', delta: 'Skill is disabled.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).toContain('Host has already loaded it for this turn')
        expect(request.system).toContain('Synthetic test instructions only.')
        return [
          { type: 'text_delta', delta: 'Skill is enabled again.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).toContain('Updated synthetic instructions.')
        expect(request.system).not.toContain('Synthetic test instructions only.')
        return [
          { type: 'text_delta', delta: 'The edited Skill is visible.' },
          { type: 'done', reason: 'stop' },
        ]
      },
    ],
    onExhausted: 'error',
  })
  let contextSawPreloadedBody = false
  let mcpReceivedSkillResources = false
  let mcpDiscoveryHasRead = false
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    provider,
    disableSessionTitle: true,
    skillResources: resources.skillResources,
    packages: {
      '@agnes/base': {
        ecosystem: {
          ...baseEcosystem,
          'agnes/skills': (init) => {
            const skills = baseEcosystem['agnes/skills'](init)
            return (api) => {
              const dispose = skills(api)
              const hook = api.registerHook('context', (payload) => {
                contextSawPreloadedBody ||= payload.sections.some((section) =>
                  section.content.includes('Synthetic test instructions only.'),
                )
                return {}
              })
              return () => {
                hook()
                return Promise.resolve(dispose).then((cleanup) => {
                  if (typeof cleanup === 'function') cleanup()
                })
              }
            }
          },
          'agnes/mcp-search': (init) => {
            mcpReceivedSkillResources = init.skillResources !== undefined
            mcpDiscoveryHasRead = 'read' in (init.skillDiscovery ?? {})
            return baseEcosystem['agnes/mcp-search'](init)
          },
        },
      },
    },
  })
  try {
    const key = 'worker-skill-context'
    const canonicalWorkspace = await realpath(workspace)
    const envelope = await workspaceBinding(key, canonicalWorkspace)
    const session = await host.createSession({
      key,
      cwd: canonicalWorkspace,
      binding: host.acceptWorkspaceBinding(envelope, key),
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: '请使用 chinese-teacher Skill，给我讲解一下《静夜思》。' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({ reason: 'completed' })
    expect(provider.calls).toHaveLength(1)
    const headers = (await session.scan({ fromSeq: 1, toSeq: session.lastSeq })).filter(
      (row) => row.type === 'request/header',
    )
    const firstRequest = provider.calls[0]
    if (!firstRequest) throw new Error('missing first Skill request')
    const firstToolSchemaHash = sha256hex(canonicalJson(firstRequest.tools).normalize('NFC'))
    expect(headers.map((row) => (row.data as { tool_schema_hash?: string }).tool_schema_hash)).toEqual([
      firstToolSchemaHash,
    ])
    expect(firstToolSchemaHash).toBe(ACTIVE_SKILL_TOOL_SCHEMA_HASH)
    expect(contextSawPreloadedBody).toBe(false)
    expect(mcpReceivedSkillResources).toBe(false)
    expect(mcpDiscoveryHasRead).toBe(false)

    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Can you find my listed Skill?' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({ reason: 'completed' })
    const genericHeaders = (await session.scan({ fromSeq: 1, toSeq: session.lastSeq })).filter(
      (row) => row.type === 'request/header',
    )
    const lastHeader = genericHeaders.at(-1)
    if (!lastHeader) throw new Error('expected at least one request/header row')
    const genericRequest = provider.calls.at(-1)
    if (!genericRequest) throw new Error('missing generic Skill request')
    const genericToolSchemaHash = sha256hex(canonicalJson(genericRequest.tools).normalize('NFC'))
    expect((lastHeader.data as { tool_schema_hash?: string }).tool_schema_hash).toBe(genericToolSchemaHash)
    expect(genericToolSchemaHash).toBe(TEST_DISCOVERY_TOOL_SCHEMA_HASH)
    const saved = await readFile(snapshot, 'utf8')
    for (const enabled of [false, true]) {
      const next = JSON.parse(saved)
      if (!enabled) next.skills.control.desired = []
      await writeFile(snapshot, JSON.stringify(next))
      const generation = await boot()
      if (!generation) throw new Error('missing replacement generation')
      try {
        // The current session sees the fresh Skill source on its next turn through the Cordis row.
        await host.refreshSkillRow(generation.skillResources)
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Use chinese-teacher Skill.' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).resolves.toMatchObject({ reason: 'completed' })
      } finally {
        await generation.runtime.mcp.close()
      }
    }
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: chinese-teacher\ndescription: Teach Chinese poetry\n---\nUpdated synthetic instructions.',
    )
    const edited = await scanSkills(workspace, undefined, undefined, homeDir)
    const nextCandidate = edited.roots.find((root) => root.rootKey === 'workspace-agnes')?.candidates[0]
    if (!nextCandidate) throw new Error('edited Skill was not discovered')
    expect(nextCandidate.revision).not.toBe(candidate.revision)
    const changed = JSON.parse(saved)
    changed.skills.control.desired = [{ resourceId: nextCandidate.resourceId, state: 'enabled' }]
    changed.skills.control.trust = [
      {
        resourceId: nextCandidate.resourceId,
        revision: nextCandidate.revision,
        capabilityHash: nextCandidate.capabilityHash,
        state: 'trusted',
      },
    ]
    await writeFile(snapshot, JSON.stringify(changed))
    const editedGeneration = await boot()
    if (!editedGeneration) throw new Error('missing edited generation')
    try {
      await host.refreshSkillRow(editedGeneration.skillResources)
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Use the edited chinese-teacher Skill.' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'completed' })
    } finally {
      await editedGeneration.runtime.mcp.close()
    }
    expect(provider.calls).toHaveLength(6)
  } finally {
    await host.close()
    await resources.runtime.mcp.close()
  }
})

it('discovers 45 disk Skills and lets the model page a 100 KiB Skill after preload declines it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agnes-worker-skill-pages-')))
  roots.push(root)
  const dataDir = join(root, 'agnes-home')
  const homeDir = join(root, 'worker-home')
  const workspace = join(dataDir, 'workspace')
  const skillRoot = join(workspace, '.agh', 'skills')
  const largeBody = `PAGE_START\n${'界😀\n'.repeat(12_800)}PAGE_END`
  await Promise.all(
    Array.from({ length: 45 }, async (_, index) => {
      const name = index === 0 ? 'large-review' : `small-${index}`
      const directory = join(skillRoot, name)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${index === 1 ? '界'.repeat(400) : `Synthetic skill ${index}`}\n---\n${index === 0 ? largeBody : 'Short fixture.'}`,
      )
    }),
  )
  const discovered = await scanSkills(workspace, undefined, undefined, homeDir)
  const candidates = discovered.roots.find((item) => item.rootKey === 'workspace-agnes')?.candidates ?? []
  expect(candidates).toHaveLength(45)
  const large = candidates.find((item) => item.name === 'large-review')
  if (!large) throw new Error('large disk Skill was not discovered')
  const snapshot = join(root, 'resource-snapshot.json')
  await writeFile(
    snapshot,
    JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: {
        control: {
          desired: candidates.map((item) => ({ resourceId: item.resourceId, state: 'enabled' })),
          trust: candidates.map((item) => ({
            resourceId: item.resourceId,
            revision: item.revision,
            capabilityHash: item.capabilityHash,
            state: 'trusted',
          })),
        },
      },
      mcp: [],
    }),
  )
  const resources = await bootstrapWorkerResources({
    env: { AGNES_RESOURCE_SNAPSHOT: snapshot, HOME: homeDir },
    cwd: workspace,
    profile: { name: 'local-dev', dataDir, adapters: { secrets: { kind: 'env' } } } as never,
    createBarrier: () => barrier,
    createSecrets: () => ({ resolve: () => '' }),
  })
  if (!resources) throw new Error('worker bootstrap did not return the managed Skill snapshot')
  let requests = 0
  let pages = 0
  const scripts = Array.from({ length: 12 }, () => (request: RequestBody): InferenceEvent[] => {
    requests++
    const names = request.system.match(/^small-\d+\t/gmu) ?? []
    expect(names).toHaveLength(44)
    expect(request.system).toContain('large-review\t')
    const longDescription = /^small-1\t(.*)$/mu.exec(request.system)?.[1]
    expect(longDescription).toBeTruthy()
    expect(longDescription?.length).toBeLessThanOrEqual(250)
    expect(request.system).not.toContain('PAGE_START')
    expect(request.tools.some((tool) => tool.name === 'skill_read')).toBe(true)
    if (requests === 1)
      return [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'skill_read', args: { name: 'large-review' }, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ]
    const latest = request.messages.filter((message) => message.role === 'tool_result').at(-1)
    const result = latest?.content.find((block) => block.type === 'text')?.text ?? ''
    expect(result).toContain('resourceId: ')
    if (pages === 0) expect(result).toContain('PAGE_START')
    const visible = result.slice(result.indexOf('resourceId: '), result.lastIndexOf('</untrusted'))
    expect(new TextEncoder().encode(visible).byteLength).toBeLessThanOrEqual(32768)
    pages++
    const continuation = /call skill_read with (\{[^\n]+\})\]/u.exec(result)?.[1]
    if (continuation)
      return [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'skill_read', args: JSON.parse(continuation), ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ]
    expect(result).toContain('PAGE_END')
    return [
      { type: 'text_delta', delta: 'The complete Skill was read.' },
      { type: 'done', reason: 'stop' },
    ]
  })
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1', contextWindow: 200_000 })],
    scripts,
    onExhausted: 'error',
  })
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    provider,
    disableSessionTitle: true,
    skillResources: resources.skillResources,
  })
  try {
    const key = 'worker-skill-pages'
    const canonicalWorkspace = await realpath(workspace)
    const envelope = await workspaceBinding(key, canonicalWorkspace)
    const session = await host.createSession({
      key,
      cwd: canonicalWorkspace,
      binding: host.acceptWorkspaceBinding(envelope, key),
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Use the large-review Skill.' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      reason: 'completed',
    })
    expect(pages).toBeGreaterThan(2)
    expect(requests).toBe(pages + 1)
  } finally {
    await host.close()
    await resources.runtime.mcp.close()
  }
})
