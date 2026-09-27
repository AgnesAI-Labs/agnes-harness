import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateResourceControlData } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  createSkillCandidateRegistry,
  MAX_SHADOWED,
  RUNTIME_SKILL_PRIORITY,
  type SkillCandidate,
} from '../src/skills.js'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '../src/skills-cordis.js'

const barrier = {
  quiesce: async <T>(_id: string, publish: (permit: unknown) => Promise<T>) => publish({}),
}
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex')

function disk(root: 'workspace-agnes' | 'user-agnes', name: string, body: string): SkillCandidate {
  const scope = root === 'workspace-agnes' ? ('workspace' as const) : ('user' as const)
  const priority = root === 'workspace-agnes' ? 500 : 400
  const sourceId = hex(`${root}:${name}`)
  return {
    resourceId: `skill/${scope}/${root}/${sourceId}`,
    name,
    description: `${name} description`,
    revision: hex(`${name}:rev`),
    capabilityHash: hex(`${name}:cap`),
    sourceIdentity: { scope, rootKey: root, sourceId },
    priority,
    body,
  }
}

function runtimeSkill(name: string, body = `${name} body`): SkillCandidate {
  const sourceId = hex(`runtime:${name}:${body}`)
  return {
    resourceId: `skill/runtime/runtime/${sourceId}`,
    name,
    description: `${name} description`,
    revision: hex(`${name}:${body}`),
    capabilityHash: hex(`${name}:cap`),
    sourceIdentity: { scope: 'runtime', rootKey: 'runtime', sourceId },
    priority: RUNTIME_SKILL_PRIORITY,
    body,
  }
}

type Registry = ReturnType<typeof createSkillCandidateRegistry>

async function publishDisk(registry: Registry, skills: readonly SkillCandidate[], id = 'disk') {
  for (const skill of skills) registry.replaceRoot(skill.sourceIdentity.rootKey, [skill])
  registry.setControl({
    desired: skills.map((skill) => ({ resourceId: skill.resourceId, state: 'enabled' as const })),
    trust: skills.map((skill) => ({
      resourceId: skill.resourceId,
      revision: skill.revision,
      capabilityHash: skill.capabilityHash,
      state: 'trusted' as const,
    })),
  })
  await registry.activate(id, async () => undefined)
}

describe('runtime skill contributions', () => {
  it('carries a full 1024-unit description in the descriptor', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const body = '# verbose skill\nKeep the full instructions.'
    const description = '😀'.repeat(512)
    const skill = { ...disk('user-agnes', 'verbose-skill', body), description }
    await publishDisk(registry, [skill])

    const descriptor = registry.snapshot().list()[0]
    expect(descriptor).toBeDefined()
    expect(validateResourceControlData('SkillDescriptor', descriptor).ok).toBe(true)
    expect(descriptor?.description).toHaveLength(1024)
    expect(descriptor?.description).toBe(description)
    const runtime = { ...runtimeSkill('long-runtime'), description: `${'a'.repeat(1023)}b` }
    registry.registerRuntime(runtime)
    const runtimeDescriptor = registry
      .snapshot()
      .list()
      .find((item) => item.resourceId === runtime.resourceId)
    expect(validateResourceControlData('SkillDescriptor', runtimeDescriptor).ok).toBe(true)
    expect(runtimeDescriptor?.description).toBe(runtime.description)
    expect(registry.snapshot().read(skill.resourceId, { sessionKey: 's' })).toMatchObject({
      ok: true,
      content: body,
    })
  })

  it('rejects a name or description outside the protocol bounds on every write path', () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const skill = disk('user-agnes', 'bounded', 'body')
    const sourceId = hex('package:bounded')
    const packaged: SkillCandidate = {
      ...skill,
      resourceId: `skill/package/package/${sourceId}`,
      sourceIdentity: { scope: 'package', rootKey: 'package', sourceId },
      priority: 50,
    }
    const invalid = [
      { description: 'a'.repeat(1025) },
      { description: '' },
      { name: 'n'.repeat(129) },
      { name: '' },
    ]
    for (const override of invalid) {
      expect(() => registry.replaceRoot('user-agnes', [{ ...skill, ...override }])).toThrow(TypeError)
      expect(() => registry.replacePackage([{ ...packaged, ...override }])).toThrow(TypeError)
      expect(() => registry.registerRuntime({ ...runtimeSkill('bounded'), ...override })).toThrow(TypeError)
    }
    expect(() =>
      registry.replaceRoot('user-agnes', [
        { ...skill, name: 'n'.repeat(128), description: 'a'.repeat(1024) },
      ]),
    ).not.toThrow()
    expect(() => registry.replacePackage([{ ...packaged, description: '😀'.repeat(512) }])).not.toThrow()
  })

  it('lets a workspace skill beat runtime and runtime beat a user skill at priority 450', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const project = disk('workspace-agnes', 'review', 'from project')
    const user = disk('user-agnes', 'notes', 'from user')
    const review = runtimeSkill('review', 'from plugin')
    const notes = runtimeSkill('notes', 'from plugin')
    await publishDisk(registry, [project, user])
    registry.registerRuntime(review)
    registry.registerRuntime(notes)

    const listed = registry.snapshot().list()
    const reviewWinner = listed.find((item) => item.resourceId === project.resourceId)
    const reviewRuntime = listed.find((item) => item.resourceId === review.resourceId)
    const notesRuntime = listed.find((item) => item.resourceId === notes.resourceId)
    const notesUser = listed.find((item) => item.resourceId === user.resourceId)
    expect(reviewWinner).toMatchObject({
      actual: 'ready',
      priority: 500,
      resolution: { winner: true },
    })
    expect(reviewRuntime).toMatchObject({
      actual: 'unavailable',
      priority: 450,
      trust: 'trusted',
      desired: 'enabled',
      lastSafeError: { code: 'SHADOWED' },
      resolution: { winner: false },
    })
    expect(notesRuntime).toMatchObject({
      actual: 'ready',
      priority: 450,
      trust: 'trusted',
      desired: 'enabled',
      resolution: { winner: true },
    })
    expect(notesUser).toMatchObject({
      actual: 'unavailable',
      priority: 400,
      lastSafeError: { code: 'SHADOWED' },
    })
    expect(registry.snapshot().read(notes.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'from plugin',
      }),
    )
    expect(registry.snapshot().read(review.resourceId, { sessionKey: 's' })).toEqual({
      ok: false,
      code: 'SHADOWED',
    })
  })

  it('keeps a runtime skill ready when trust and desired rows try to disable it', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const skill = runtimeSkill('helper')
    registry.registerRuntime(skill)
    registry.setControl({
      desired: [{ resourceId: skill.resourceId, state: 'disabled' }],
      trust: [
        {
          resourceId: skill.resourceId,
          revision: skill.revision,
          capabilityHash: skill.capabilityHash,
          state: 'rejected',
        },
      ],
    })
    await registry.activate('control', async () => undefined)
    expect(registry.snapshot().list()).toMatchObject([
      {
        resourceId: skill.resourceId,
        actual: 'ready',
        trust: 'trusted',
        desired: 'enabled',
      },
    ])
    expect(registry.actual()).toMatchObject([{ resourceId: skill.resourceId, actual: 'ready' }])
  })

  it('keeps runtime skills when a full activation replaces disk roots', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const skill = runtimeSkill('helper', 'stay')
    registry.registerRuntime(skill)
    const first = disk('user-agnes', 'old', 'old body')
    await publishDisk(registry, [first], 'first')
    const replacement = disk('workspace-agnes', 'fresh', 'fresh body')
    registry.replaceRoot('user-agnes', [])
    registry.replaceRoot('workspace-agnes', [replacement])
    registry.setControl({
      desired: [{ resourceId: replacement.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: replacement.resourceId,
          revision: replacement.revision,
          capabilityHash: replacement.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await registry.activate('replace', async () => undefined)
    const names = registry
      .snapshot()
      .list()
      .map((item) => [item.name, item.actual, item.priority])
    expect(names).toEqual([
      ['fresh', 'ready', 500],
      ['helper', 'ready', 450],
    ])
    expect(registry.snapshot().read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'stay',
      }),
    )
    expect(
      registry
        .snapshot()
        .list()
        .some((item) => item.resourceId === first.resourceId),
    ).toBe(false)
  })

  it('shows a runtime skill on a snapshot taken before the registration', () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const seen = registry.snapshot()
    expect(seen.list()).toEqual([])
    expect(seen.read(`skill/runtime/runtime/${'a'.repeat(64)}`, { sessionKey: 's' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    })
    const skill = runtimeSkill('helper', 'live body')
    registry.registerRuntime(skill)
    expect(seen.list()).toMatchObject([
      { resourceId: skill.resourceId, name: 'helper', actual: 'ready', priority: 450 },
    ])
    expect(seen.read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({ ok: true, content: 'live body' }),
    )
    registry.unregisterRuntime(skill.resourceId)
    registry.unregisterRuntime(skill.resourceId)
    expect(seen.list()).toEqual([])
    expect(seen.read(skill.resourceId, { sessionKey: 's' })).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('rejects a same-layer runtime name without replacing the existing contribution', () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const first = runtimeSkill('helper', 'first')
    registry.registerRuntime(first)
    expect(() => registry.registerRuntime(runtimeSkill('helper', 'second'))).toThrow(
      'runtime skill name already registered',
    )
    expect(registry.snapshot().read(first.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'first',
      }),
    )
    expect(registry.snapshot().list()).toHaveLength(1)
  })

  it('lets the next fiber of a row overlap that name and still rejects a different row', () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const seen = registry.snapshot()
    const first = runtimeSkill('handoff', 'old')
    registry.registerRuntime(first, { scope: 'tree', rowId: 'host:test-seam', fiberId: '1' })
    const next = runtimeSkill('handoff', 'new')
    registry.registerRuntime(next, { scope: 'tree', rowId: 'host:test-seam', fiberId: '2' })
    registry.unregisterRuntime(first.resourceId)
    expect(seen.read(next.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({ ok: true, content: 'new' }),
    )
    const otherTree = runtimeSkill('handoff', 'elsewhere')
    registry.registerRuntime(otherTree, { scope: 'other-tree', rowId: 'host:test-seam', fiberId: '9' })
    expect(() =>
      registry.registerRuntime(runtimeSkill('handoff', 'blocked'), {
        scope: 'tree',
        rowId: 'host:other-seam',
        fiberId: '3',
      }),
    ).toThrow('runtime skill name already registered')
    registry.unregisterRuntime(otherTree.resourceId)
    expect(seen.read(next.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({ ok: true, content: 'new' }),
    )
  })

  it('registers without waiting for the activation barrier', () => {
    let waited = false
    const hanging = {
      quiesce: <T>(_operationId: string, _publish: (permit: unknown) => Promise<T>): Promise<T> => {
        waited = true
        return new Promise<T>(() => undefined)
      },
    }
    const registry = createSkillCandidateRegistry({ barrier: hanging })
    const skill = runtimeSkill('helper', 'immediate')
    registry.registerRuntime(skill)
    expect(waited).toBe(false)
    expect(registry.snapshot().read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'immediate',
      }),
    )
  })

  it('shares the runtime map with a later registry generation and leaves that generation disk roots alone', async () => {
    const first = createSkillCandidateRegistry({ barrier })
    const skill = runtimeSkill('helper', 'shared')
    first.registerRuntime(skill)
    const second = createSkillCandidateRegistry({ barrier })
    const local = disk('user-agnes', 'local', 'local body')
    await publishDisk(second, [local], 'local')
    second.shareRuntimeFrom(first)
    expect(second.snapshot().read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'shared',
      }),
    )
    const added = runtimeSkill('extra', 'also shared')
    first.registerRuntime(added)
    expect(
      second
        .snapshot()
        .list()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['extra', 'helper', 'local'])
    expect(
      first
        .snapshot()
        .list()
        .some((item) => item.name === 'local'),
    ).toBe(false)
  })
})

it('applies persisted same-name priority without bypassing trust, and excludes removed content', async () => {
  const registry = createSkillCandidateRegistry({ barrier })
  const project = disk('workspace-agnes', 'same', 'project')
  const user = disk('user-agnes', 'same', 'user')
  await publishDisk(registry, [project, user])
  const desired = [project, user].map((skill) => ({
    resourceId: skill.resourceId,
    state: 'enabled' as const,
  }))
  registry.setControl({
    desired,
    trust: [],
    priorities: { [project.resourceId]: 50, [user.resourceId]: 500 },
  })
  await registry.activate('priority', async () => undefined)
  expect(registry.actual().find((item) => item.resourceId === user.resourceId)?.resolution.winner).toBe(true)
  expect(registry.read(user.resourceId, { sessionKey: 's' })).toMatchObject({
    ok: false,
    code: 'UNTRUSTED_REVISION',
  })
  registry.setControl({
    desired,
    trust: [],
    priorities: { [project.resourceId]: 50, [user.resourceId]: 500 },
    removed: [user.resourceId],
  })
  await registry.activate('delete', async () => undefined)
  expect(registry.read(user.resourceId, { sessionKey: 's' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  expect(registry.actual().find((item) => item.resourceId === project.resourceId)?.resolution.winner).toBe(
    true,
  )
  registry.setControl({ desired, trust: [] })
  await registry.activate('reset', async () => undefined)
  expect(registry.actual().find((item) => item.resourceId === project.resourceId)?.priority).toBe(500)
})

describe('Skill base directory', () => {
  it('tells the model the base directory of a disk Skill and keeps it out of the listing', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const skill = { ...disk('user-agnes', 'pdf', 'Run scripts/fill.py'), directory: '/skills/pdf' }
    await publishDisk(registry, [skill])
    const read = registry.snapshot().read(skill.resourceId, { sessionKey: 's' })
    expect(read).toMatchObject({ ok: true })
    const content = (read as { content: string }).content
    expect(content.startsWith('Base directory for this Skill: /skills/pdf\n')).toBe(true)
    expect(content.endsWith('Run scripts/fill.py')).toBe(true)
    expect(JSON.stringify(registry.snapshot().list())).not.toContain('/skills/pdf')
  })
  it('opens only ready user-level Skill directories for reading', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const user = { ...disk('user-agnes', 'pdf', 'b'), directory: '/skills/pdf' }
    const off = { ...disk('user-agnes', 'off', 'b'), directory: '/skills/off' }
    const project = { ...disk('workspace-agnes', 'lint', 'b'), directory: '/work/.agh/skills/lint' }
    await publishDisk(registry, [user, project])
    expect(registry.snapshot().readRoots?.()).toEqual(['/skills/pdf'])
    registry.replaceRoot('user-agnes', [user, off])
    registry.setControl({
      desired: [{ resourceId: user.resourceId, state: 'disabled' }],
      trust: [],
    })
    await registry.activate('closed', async () => undefined)
    expect(registry.snapshot().readRoots?.()).toEqual([])
  })
})

describe('skill bounds agree with the protocol schema', () => {
  const defs = JSON.parse(
    readFileSync(new URL('../../protocol/schema/resource-control.json', import.meta.url), 'utf8'),
  ).$defs

  it('uses the protocol name and description limits for runtime registration', () => {
    expect(defs.SkillDescriptor.properties.description.maxLength).toBe(1024)
    expect(MAX_DESCRIPTION_LENGTH).toBe(defs.SkillDescriptor.properties.description.maxLength)
    expect(defs.SkillDescriptor.properties.name.maxLength).toBe(128)
    expect(MAX_NAME_LENGTH).toBe(defs.SkillDescriptor.properties.name.maxLength)
  })

  it('caps the shadowed list at the protocol limit', () => {
    expect(MAX_SHADOWED).toBe(defs.SkillResolution.properties.shadowed.maxItems)
  })
})
