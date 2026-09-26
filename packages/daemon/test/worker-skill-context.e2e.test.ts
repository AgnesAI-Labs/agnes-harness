import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { ecosystem as baseEcosystem } from '@agnes/base'
import { canonicalJson, sha256hex } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { bootstrapWorkerResources, scanSkills } from '@agnes/resource-control-worker'
import { afterEach, expect, it } from 'vitest'
import { workspaceBinding } from './workspace-authority.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const roots: string[] = []
// Explicit preload now adds one durable tail note. It does not alter the disclosed tool schema:
// discovery and read tools remain available for the loaded and generic turns alike.
const expectedToolNames = [
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
]

const skillNoteCount = (messages: unknown): number =>
  JSON.stringify(messages).split('[skill loaded]').length - 1

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
        expect(request.system).not.toContain(candidate.resourceId)
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(JSON.stringify(request.messages)).toContain(candidate.resourceId)
        expect(JSON.stringify(request.messages)).toContain('Synthetic test instructions only.')
        expect(JSON.stringify(request.messages)).toContain('Host has already loaded it.')
        expect(skillNoteCount(request.messages)).toBe(1)
        expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'find')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'grep')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'ls')).toBeDefined()
        expect(request.tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames)
        return [
          { type: 'text_delta', delta: 'Read the synthetic Skill.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.tools.find((tool) => tool.name === 'tool_search')).toBeDefined()
        expect(request.tools.find((tool) => tool.name === 'skill_read')).toBeDefined()
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(request.tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames)
        expect(skillNoteCount(request.messages)).toBe(1)
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
        expect(skillNoteCount(request.messages)).toBe(1)
        return [
          { type: 'text_delta', delta: 'The Skill instructions are ready.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(request.system).not.toContain(candidate.resourceId)
        expect(skillNoteCount(request.messages)).toBe(1)
        return [
          { type: 'text_delta', delta: 'Skill is disabled.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).not.toContain('Synthetic test instructions only.')
        expect(JSON.stringify(request.messages)).toContain('Synthetic test instructions only.')
        expect(skillNoteCount(request.messages)).toBe(1)
        return [
          { type: 'text_delta', delta: 'Skill is enabled again.' },
          { type: 'done', reason: 'stop' },
        ]
      },
      (request) => {
        expect(request.system).not.toContain('Updated synthetic instructions.')
        expect(JSON.stringify(request.messages)).toContain('Updated synthetic instructions.')
        expect(skillNoteCount(request.messages)).toBe(2)
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
    const firstToolSchemaHash = (headers[0]?.data as { tool_schema_hash?: string } | undefined)
      ?.tool_schema_hash
    expect(firstToolSchemaHash).toMatch(/^[a-f0-9]{64}$/u)
    const firstRequest = provider.calls[0]
    if (!firstRequest) throw new Error('provider received no first request')
    expect(firstToolSchemaHash).toBe(sha256hex(canonicalJson(firstRequest.tools).normalize('NFC')))
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
    expect((lastHeader.data as { tool_schema_hash?: string }).tool_schema_hash).toBe(firstToolSchemaHash)
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
