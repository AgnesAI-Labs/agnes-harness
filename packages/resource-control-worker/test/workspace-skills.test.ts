import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillCandidate, SkillControlInput, SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { afterEach, expect, it } from 'vitest'
import { bootstrapWorkerResources } from '../src/runtime-bootstrap.js'
import { scanSkills } from '../src/skill-bootstrap.js'
import { workspaceSkills } from '../src/workspace-skills.js'

function scope(runtime: SkillRuntimeInput) {
  if (!runtime.scopeWorkspace) throw new Error('missing workspace selection')
  return runtime.scopeWorkspace
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-skills-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const a = join(root, 'a')
  const b = join(root, 'b')
  const empty = join(root, 'empty')
  await mkdir(empty)
  async function skill(base: string, body: string) {
    const dir = join(base, '.agh', 'skills', 'review')
    await mkdir(join(dir, 'references'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: review\ndescription: Review\n---\n${body}`)
    await writeFile(join(dir, 'references', 'details.md'), `${body} attachment`)
    return dir
  }
  const adir = await skill(a, 'A private instructions')
  await skill(b, 'B private instructions')
  await skill(home, 'User instructions')
  const candidates = new Map<string, SkillCandidate>()
  for (const path of [a, b]) {
    const scan = await scanSkills(path, undefined, undefined, home, join(home, '.agh'))
    for (const item of scan.roots.flatMap((entry) => entry.candidates)) candidates.set(item.resourceId, item)
  }
  const all = [...candidates.values()]
  const control: SkillControlInput = {
    desired: all.map((c) => ({ resourceId: c.resourceId, state: 'enabled' })),
    trust: all.map((c) => ({
      resourceId: c.resourceId,
      revision: c.revision,
      capabilityHash: c.capabilityHash,
      state: 'trusted',
    })),
  }
  const snapshot = join(root, 'snapshot.json')
  async function boot(next = control) {
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        skills: { control: next },
        mcp: [],
      }),
    )
    const state = await bootstrapWorkerResources({
      env: { AGNES_RESOURCE_SNAPSHOT: snapshot, HOME: home },
      agnesHomeDir: join(home, '.agh'),
      profile: { name: 'test', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_id, publish) => publish({}) }),
      createSecrets: () => {
        throw new Error('unexpected secrets')
      },
    })
    if (!state) throw new Error('missing runtime')
    cleanup.push(() => state.runtime.mcp.close())
    return state
  }
  const ca = all.find((c) => c.body.includes('A private'))
  const cb = all.find((c) => c.body.includes('B private'))
  if (!ca || !cb) throw new Error('missing workspace candidates')
  return { a, b, empty, adir, ca, cb, control, boot }
}

it('loads trusted workspace Skills concurrently, resolves names locally and isolates bodies and files', async () => {
  const f = await fixture()
  const { skillResources: skills } = await f.boot()
  expect(skills.list().some((s) => s.sourceIdentity.scope === 'workspace')).toBe(false)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const runA = scope(skills)(f.a, 'a', async () => {
    release()
    await Promise.resolve()
    expect(
      skills
        .list()
        .filter((s) => s.actual === 'ready')
        .map((s) => s.resourceId),
    ).toEqual([f.ca.resourceId])
    expect(skills.read(f.ca.resourceId, { sessionKey: 'a' })).toMatchObject({
      ok: true,
      content: expect.stringContaining('A private'),
    })
    expect(skills.read(f.cb.resourceId, { sessionKey: 'a' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(skills.read(f.ca.resourceId, { sessionKey: 'b' })).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED',
    })
    expect(
      skills.readFile(f.ca.resourceId, f.ca.revision, 'references/details.md', { sessionKey: 'a' }),
    ).toMatchObject({ ok: true, content: 'A private instructions attachment' })
    expect(
      skills.readFile(f.cb.resourceId, f.cb.revision, 'references/details.md', { sessionKey: 'a' }),
    ).toMatchObject({ ok: false })
  })
  const runB = scope(skills)(f.b, 'b', async () => {
    await barrier
    expect(
      skills
        .list()
        .filter((s) => s.actual === 'ready')
        .map((s) => s.resourceId),
    ).toEqual([f.cb.resourceId])
    expect(skills.read(f.cb.resourceId, { sessionKey: 'b' })).toMatchObject({
      ok: true,
      content: expect.stringContaining('B private'),
    })
  })
  await Promise.all([runA, runB])
  await scope(skills)(f.empty, 'empty', async () => {
    expect(
      skills
        .list()
        .filter((s) => s.actual === 'ready')
        .map((s) => s.sourceIdentity.scope),
    ).toEqual(['user'])
  })
  expect(skills.read(f.ca.resourceId, { sessionKey: 'a' })).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
})

it('keeps trust, desired and revision gates and refreshes on the next resource generation', async () => {
  const f = await fixture()
  for (const control of [
    { ...f.control, trust: [] },
    { ...f.control, desired: [] },
  ]) {
    const { skillResources: skills } = await f.boot(control)
    await scope(skills)(f.a, 'a', async () => {
      expect(skills.list().some((s) => s.actual === 'ready')).toBe(false)
      expect(skills.read(f.ca.resourceId, { sessionKey: 'a' }).ok).toBe(false)
    })
  }
  const old = await f.boot()
  await scope(old.skillResources)(f.a, 'a', async () => {
    expect(old.skillResources.read(f.ca.resourceId, { sessionKey: 'a' }).ok).toBe(true)
  })
  await writeFile(
    join(f.adir, 'SKILL.md'),
    '---\nname: review\ndescription: Review\n---\nChanged untrusted body',
  )
  const fresh = await f.boot()
  await scope(fresh.skillResources)(f.a, 'a', async () => {
    expect(fresh.skillResources.read(f.ca.resourceId, { sessionKey: 'a' })).toMatchObject({
      ok: false,
      code: 'UNTRUSTED_REVISION',
    })
  })
})

it('retains dynamic runtime contributions in cached workspace views', async () => {
  const f = await fixture()
  const state = await f.boot()
  await scope(state.skillResources)(f.a, 'a', async () => state.skillResources.list())
  const id = 'skill/runtime/runtime/test'
  state.runtime.skills.registerRuntime({
    ...f.ca,
    resourceId: id,
    name: 'runtime-review',
    priority: 450,
    sourceIdentity: { scope: 'runtime', rootKey: 'runtime', sourceId: 'test' },
  })
  await scope(state.skillResources)(f.a, 'a', async () => {
    expect(state.skillResources.list().some((s) => s.resourceId === id && s.actual === 'ready')).toBe(true)
  })
  state.runtime.skills.unregisterRuntime(id)
  await scope(state.skillResources)(f.a, 'a', async () => {
    expect(state.skillResources.list().some((s) => s.resourceId === id)).toBe(false)
  })
})

it('revokes escaped async callbacks and retries failed view construction', async () => {
  const f = await fixture()
  const state = await f.boot()
  let attempts = 0
  const skills = workspaceSkills(state.skillResources, async () => {
    if (++attempts === 1) throw new Error('scan failed')
    return state.skillResources
  })
  await expect(scope(skills)(f.a, 'a', async () => undefined)).rejects.toThrow('scan failed')
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let escaped!: Promise<unknown>
  await scope(skills)(f.a, 'a', async () => {
    escaped = wait.then(() => {
      expect(skills.list()).toEqual([])
      expect(skills.read(f.ca.resourceId, { sessionKey: 'a' })).toMatchObject({
        ok: false,
        code: 'UNAUTHORIZED',
      })
    })
  })
  release()
  await escaped
  expect(attempts).toBe(2)
})

it('forwards the shared user-level read roots, inside a workspace scope or not', async () => {
  const shared = {
    list: () => [],
    read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
    readFile: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
    readRoots: () => ['/skills/pdf'],
  } satisfies SkillRuntimeInput
  const view = { ...shared, readRoots: () => ['/other'] }
  const runtime = workspaceSkills(shared, async () => view)
  expect(runtime.readRoots?.()).toEqual(['/skills/pdf'])
  await scope(runtime)('/work', 's', async () => {
    expect(runtime.readRoots?.()).toEqual(['/skills/pdf'])
  })
})
