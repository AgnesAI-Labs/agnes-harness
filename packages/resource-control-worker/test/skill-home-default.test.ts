import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapWorkerResources } from '../src/runtime-bootstrap.js'
import { scanSkills } from '../src/skill-bootstrap.js'

const systemHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => systemHome.path,
}))
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('uses the system home when HOME is absent and preserves an explicit home override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-home-'))
  roots.push(root)
  systemHome.path = join(root, '中文 home')
  const skills = join(systemHome.path, '.agents', 'skills', 'review')
  await mkdir(skills, { recursive: true })
  await writeFile(
    join(skills, 'SKILL.md'),
    '---\nname: review\ndescription: Review changes\n---\nreview body',
  )
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  vi.stubEnv('HOME', undefined)
  const scanned = await scanSkills(workspace)
  expect(scanned.roots.find((entry) => entry.rootKey === 'user-agents')?.candidates).toHaveLength(1)
  const overridden = await scanSkills(workspace, undefined, undefined, join(root, 'other-home'))
  expect(overridden.roots.find((entry) => entry.rootKey === 'user-agents')?.candidates ?? []).toHaveLength(0)
  const snapshot = join(root, 'resources.json')
  await writeFile(
    snapshot,
    JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: { control: { desired: [], trust: [] } },
      mcp: [],
    }),
  )
  const state = await bootstrapWorkerResources({
    env: { AGNES_RESOURCE_SNAPSHOT: snapshot, USERPROFILE: systemHome.path },
    cwd: workspace,
    profile: { name: 'local-dev', dataDir: root, adapters: { secrets: { kind: 'env' } } },
    createBarrier: () => ({ quiesce: async (_id, publish) => publish({} as never) }),
    createSecrets: () => {
      throw new Error('No secrets are required')
    },
  })
  try {
    expect(state?.discovery.roots.find((entry) => entry.rootKey === 'user-agents')?.state).toBe('ready')
  } finally {
    await state?.runtime.mcp.close()
  }
})

it('omits workspace Skills when a shared worker has no explicit workspace root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-no-workspace-'))
  roots.push(root)
  const home = join(root, 'home')
  const userSkill = join(home, '.agents', 'skills', 'user-review')
  const ambientSkill = join(root, '.agh', 'skills', 'ambient-review')
  await mkdir(userSkill, { recursive: true })
  await mkdir(ambientSkill, { recursive: true })
  await writeFile(
    join(userSkill, 'SKILL.md'),
    '---\nname: user-review\ndescription: User Skill\n---\nuser body',
  )
  await writeFile(
    join(ambientSkill, 'SKILL.md'),
    '---\nname: ambient-review\ndescription: Ambient Skill\n---\nambient body',
  )

  const scanned = await scanSkills(undefined, undefined, undefined, home, join(home, '.agh'))

  expect(scanned.roots.some((entry) => entry.rootKey === 'workspace-agnes')).toBe(false)
  expect(scanned.rootStatuses.some((entry) => entry.rootKey === 'workspace-agnes')).toBe(false)
  expect(scanned.roots.flatMap((entry) => entry.candidates).map((candidate) => candidate.name)).toContain(
    'user-review',
  )
  expect(scanned.roots.flatMap((entry) => entry.candidates).map((candidate) => candidate.name)).not.toContain(
    'ambient-review',
  )
})

it('defaults the user Agnes Skill root to <osHome>/.agh/skills and no longer reads <osHome>/.agnes/skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-skill-agh-default-'))
  roots.push(root)
  const home = join(root, 'home')
  for (const [dir, name] of [
    ['.agh', 'current'],
    ['.agnes', 'legacy'],
  ] as const) {
    const skill = join(home, dir, 'skills', name)
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill\n---\nbody`)
  }

  const scanned = await scanSkills(undefined, undefined, undefined, home)

  const userAgnes = scanned.roots.find((entry) => entry.rootKey === 'user-agnes')
  expect(userAgnes?.candidates.map((candidate) => candidate.name)).toEqual(['current'])
  expect(scanned.roots.flatMap((entry) => entry.candidates).map((candidate) => candidate.name)).not.toContain(
    'legacy',
  )
})
