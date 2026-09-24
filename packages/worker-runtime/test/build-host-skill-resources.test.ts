import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { scanSkills } from '@agnes/resource-control-worker'
import { afterEach, expect, it } from 'vitest'
import { runWorker, type WorkerHostSkillResources } from '../src/main.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function skillWorkspace(): Promise<{
  dataDir: string
  homeDir: string
  workspace: string
  snapshot: string
  profileFile: string
  candidate: { resourceId: string; revision: string; capabilityHash: string }
  userCandidate: { resourceId: string; revision: string; capabilityHash: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-host-'))
  roots.push(root)
  const dataDir = join(root, 'agnes-home')
  const homeDir = join(root, 'worker-home')
  const workspace = join(dataDir, 'workspace')
  const skillDir = join(workspace, '.agh', 'skills', 'chinese-teacher')
  const userSkillDir = join(dataDir, 'skills', 'user-review')
  const snapshot = join(root, 'resource-snapshot.json')
  const profileFile = join(root, 'profile.json')
  await mkdir(skillDir, { recursive: true })
  await mkdir(userSkillDir, { recursive: true })
  await mkdir(join(dataDir, 'cache'), { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: chinese-teacher\ndescription: Teach Chinese poetry\n---\nSynthetic test instructions only.',
  )
  await writeFile(
    join(userSkillDir, 'SKILL.md'),
    '---\nname: user-review\ndescription: Review for every user workspace\n---\nUser-scoped instructions.',
  )
  const discovered = await scanSkills(workspace, undefined, undefined, homeDir, dataDir)
  const candidate = discovered.roots.find((item) => item.rootKey === 'workspace-agnes')?.candidates[0]
  const userCandidate = discovered.roots.find((item) => item.rootKey === 'user-agnes')?.candidates[0]
  if (!candidate) throw new Error('test Skill was not discovered')
  if (!userCandidate) throw new Error('test user Skill was not discovered')
  await writeFile(
    snapshot,
    JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: {
        control: {
          desired: [
            { resourceId: candidate.resourceId, state: 'enabled' },
            { resourceId: userCandidate.resourceId, state: 'enabled' },
          ],
          trust: [
            {
              resourceId: candidate.resourceId,
              revision: candidate.revision,
              capabilityHash: candidate.capabilityHash,
              state: 'trusted',
            },
            {
              resourceId: userCandidate.resourceId,
              revision: userCandidate.revision,
              capabilityHash: userCandidate.capabilityHash,
              state: 'trusted',
            },
          ],
        },
      },
      mcp: [],
    }),
  )
  await writeFile(
    profileFile,
    JSON.stringify({
      name: 'local-dev',
      dataDir,
      cacheDir: join(dataDir, 'cache'),
      adapters: { secrets: { kind: 'env' } },
      packages: [],
      hash: `sha256-${'0'.repeat(64)}`,
    }),
  )
  return { dataDir, homeDir, workspace, snapshot, profileFile, candidate, userCandidate }
}

function workerEnv(input: {
  profileFile: string
  snapshot?: string
  workspace: string
  dataDir: string
  homeDir: string
}): NodeJS.ProcessEnv {
  return {
    AGNES_WORKER_TOKEN: 'tok',
    AGNES_SUPERVISOR_SOCKET: '/tmp/agnes-worker-skill-host.sock',
    AGNES_WORKER_KEY: '@shared',
    AGNES_PROFILE_FILE: input.profileFile,
    AGNES_WORKER_GENERATION: '1',
    AGNES_WORKER_ROOT: input.workspace,
    AGH_HOME: input.dataDir,
    HOME: input.homeDir,
    ...(input.snapshot ? { AGNES_RESOURCE_SNAPSHOT: input.snapshot } : {}),
  }
}

it('does not expose AGNES_WORKER_ROOT as a shared session worker workspace Skill root', async () => {
  const fixture = await skillWorkspace()
  let received: WorkerHostSkillResources | undefined
  await expect(
    runWorker(
      workerEnv(fixture),
      { connect: async () => new PassThrough(), gate: null },
      {
        buildHost: async (_profile, _prompter, resources) => {
          received = resources
          throw new Error('stop-after-capture')
        },
      },
    ),
  ).rejects.toThrow('stop-after-capture')

  expect(received?.skillResources).toBeDefined()
  expect(received?.requestMedia).toBeDefined()
  expect(received?.skillInstall).toBeDefined()
  expect(received?.skillResources?.list()).toMatchObject([
    {
      resourceId: fixture.userCandidate.resourceId,
      sourceIdentity: { scope: 'user', rootKey: 'user-agnes' },
      actual: 'ready',
    },
  ])
  expect(received?.skillResources?.list().some((skill) => skill.sourceIdentity.scope === 'workspace')).toBe(
    false,
  )
  expect(
    received?.skillResources?.read(fixture.candidate.resourceId, { sessionKey: 'session-key' }),
  ).toMatchObject({
    ok: false,
    code: 'UNAUTHORIZED',
  })
})

it('still calls buildHost when bootstrap produced no Skill resources', async () => {
  const fixture = await skillWorkspace()
  let received: WorkerHostSkillResources | undefined
  await expect(
    runWorker(
      workerEnv({
        profileFile: fixture.profileFile,
        workspace: fixture.workspace,
        dataDir: fixture.dataDir,
        homeDir: fixture.homeDir,
      }),
      { connect: async () => new PassThrough(), gate: null },
      {
        buildHost: async (_profile, _prompter, resources) => {
          received = resources
          throw new Error('stop-after-empty')
        },
      },
    ),
  ).rejects.toThrow('stop-after-empty')
  expect(received).toEqual({
    skillInstall: expect.any(Function),
    requestMedia: expect.any(Object),
    runtimePluginSources: expect.any(Function),
    serviceAuthority: expect.objectContaining({ resolve: expect.any(Function) }),
    mcpManage: expect.any(Function),
    pluginManage: expect.any(Function),
  })
})

it('ignores AGNES_PLUGIN_ASSEMBLY_FILE and does not inject ordinary plugin snapshots', async () => {
  const fixture = await skillWorkspace()
  const assembly = join(fixture.dataDir, 'worker-plugin-assembly.json')
  const snapshotId = `sha256-${'1'.repeat(64)}`
  const inactiveSnapshotId = `sha256-${'4'.repeat(64)}`
  const integrity = `sha256-${'2'.repeat(64)}`
  const treeIntegrity = `sha256-${'3'.repeat(64)}`
  await writeFile(
    assembly,
    JSON.stringify({
      version: 3,
      profile: 'local-dev',
      managedPackageIds: ['@acme/ordinary-plugin'],
      revisions: {
        'pin-ordinary-plugin': {
          trust: 'trusted',
          snapshot: {
            snapshotId,
            profile: 'local-dev',
            packageId: '@acme/ordinary-plugin',
            version: '1.0.0',
            integrity,
            treeIntegrity,
            capabilityHash: 'capability',
            directory: join(fixture.dataDir, 'immutable-plugin-snapshot'),
            contributions: [],
          },
          extensions: [],
        },
        'pin-inactive-plugin': {
          trust: 'trusted',
          snapshot: {
            snapshotId: inactiveSnapshotId,
            profile: 'local-dev',
            packageId: '@acme/inactive-plugin',
            version: '2.0.0',
            integrity,
            treeIntegrity,
            capabilityHash: 'inactive-capability',
            directory: join(fixture.dataDir, 'immutable-inactive-plugin-snapshot'),
            contributions: [],
          },
          extensions: [],
        },
      },
    }),
  )
  await writeFile(
    join(fixture.dataDir, 'active-revisions.json'),
    JSON.stringify({
      version: 1,
      profile: 'local-dev',
      sequence: 0,
      packages: {
        '@acme/ordinary-plugin': {
          packageId: '@acme/ordinary-plugin',
          revision: 'revision-1',
          pinId: 'pin-ordinary-plugin',
          snapshotId,
          version: '1.0.0',
          integrity,
          treeIntegrity,
          trust: 'trusted',
          extensions: [],
        },
      },
    }),
  )
  let received: WorkerHostSkillResources | undefined
  await expect(
    runWorker(
      { ...workerEnv(fixture), AGNES_PLUGIN_ASSEMBLY_FILE: assembly },
      { connect: async () => new PassThrough(), gate: null },
      {
        buildHost: async (_profile, _prompter, resources) => {
          received = resources
          throw new Error('stop-after-plugin-selection-capture')
        },
      },
    ),
  ).rejects.toThrow('stop-after-plugin-selection-capture')

  expect(received?.managedExtensionPackageIds).toBeUndefined()
  expect(received?.runtimePluginSnapshots).toBeUndefined()
  expect(received?.runtimePluginCatalogue).toBeUndefined()
})

for (const empty of [false, true]) {
  it(`preserves managed MCP authority through real bootstrap (empty control: ${empty})`, async () => {
    const fixture = await skillWorkspace()
    if (empty)
      await writeFile(
        fixture.snapshot,
        JSON.stringify({
          version: 1,
          mcpAuthority: 'resource-control',
          skills: { control: { desired: [], trust: [] } },
          mcp: [],
        }),
      )
    let received: WorkerHostSkillResources | undefined
    await expect(
      runWorker(
        workerEnv(fixture),
        { connect: async () => new PassThrough(), gate: null },
        {
          buildHost: async (_profile, _prompter, resources) => {
            received = resources
            throw new Error('captured-managed')
          },
        },
      ),
    ).rejects.toThrow('captured-managed')
    // MCP servers are Host rows now; Host gets no MCP input at all (design §3.9, D124).
    expect(received).not.toHaveProperty('mcpResources')
    expect(received).not.toHaveProperty('mcpResourceAuthority')
  })
}
