import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeContextConfig } from '@agnes/base'
import type { WorkerResourceBootstrapInput } from '@agnes/resource-control-worker'
import { bootstrapWorkerResources, SkillScanCache, scanSkills } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeWorkspaceSkill, scanWorkspaceSkills } from '../src/commands.js'

// File reads are observable work here: a single-row control request must not load a sibling body.
const reads = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      reads.push(String(args[0]))
      return fs.readFile(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const barrier = {
  quiesce: async <T>(_operationId: string, publish: (permit: unknown) => Promise<T>): Promise<T> =>
    publish({}),
}

/** Builds one isolated deployment (its own Agnes home, snapshot file) with an optional single
 *  workspace-agnes Skill fixture inside `workspaceRoot`. Every scan/remove call in a test reads the
 *  same on-disk snapshot, matching how the daemon's `@shared` always re-reads it live (design §3.5). */
async function deployment(): Promise<{
  root: string
  agnesHomeDir: string
  snapshotPath: string
  input: WorkerResourceBootstrapInput
  writeSnapshot(skillsControl: { desired: unknown[]; trust: unknown[] }): Promise<string>
  addWorkspaceSkill(
    workspaceRoot: string,
    name: string,
    description: string,
  ): Promise<{ resourceId: string; revision: string; capabilityHash: string }>
}> {
  const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-scan-'))
  roots.push(root)
  const agnesHomeDir = join(root, 'agnes-home')
  await mkdir(agnesHomeDir, { recursive: true })
  const snapshotPath = join(root, 'resource-snapshot.json')
  const writeSnapshot = async (skillsControl: { desired: unknown[]; trust: unknown[] }): Promise<string> => {
    const body = JSON.stringify({
      version: 1,
      mcpAuthority: 'resource-control',
      skills: { control: skillsControl },
      mcp: [],
    })
    await writeFile(snapshotPath, body)
    return createHash('sha256').update(body, 'utf8').digest('hex')
  }
  await writeSnapshot({ desired: [], trust: [] })
  const addWorkspaceSkill = async (workspaceRoot: string, name: string, description: string) => {
    const dir = join(workspaceRoot, '.agh', 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.`)
    const discovered = await scanSkills(workspaceRoot, undefined, undefined, agnesHomeDir, agnesHomeDir)
    const candidate = discovered.roots.find((item) => item.rootKey === 'workspace-agnes')?.candidates[0]
    if (!candidate) throw new Error('test Skill was not discovered')
    return candidate
  }
  const input: WorkerResourceBootstrapInput = {
    // HOME must be isolated: without it, scanSkills falls back to the real OS home directory and
    // picks up whatever user-level Skills actually happen to be installed there.
    env: { AGNES_RESOURCE_SNAPSHOT: snapshotPath, HOME: agnesHomeDir },
    profile: { name: 'local-dev', dataDir: root, adapters: { secrets: { kind: 'env' } } },
    agnesHomeDir,
    createBarrier: () => barrier,
    createSecrets: () => {
      throw new Error('a Skill-only scan must never resolve a secret')
    },
  }
  return { root, agnesHomeDir, snapshotPath, input, writeSnapshot, addWorkspaceSkill }
}

describe('scanWorkspaceSkills (worker side of resourceSkillScan)', () => {
  it('observes current custom directories during refresh even when control reuse is offered', async () => {
    const { root, agnesHomeDir, input, writeSnapshot } = await deployment()
    const workspace = join(root, 'workspace')
    const custom = join(root, 'custom')
    await mkdir(custom)
    writeContextConfig({ customSkillRoots: [custom] }, agnesHomeDir)
    const revision = await writeSnapshot({ desired: [], trust: [] })
    const skillScanCache = new SkillScanCache()
    const previous = await bootstrapWorkerResources({
      ...input,
      cwd: workspace,
      mcpRows: true,
      skillScanCache,
    })
    await previous?.runtime.mcp.close()
    await writeFile(join(custom, 'new.md'), '---\nname: new-skill\ndescription: Useful\n---\nprivate body')
    const result = await scanWorkspaceSkills(
      { ...input, skillScanCache, reuseSkillsAt: revision },
      { workspaceRoot: workspace, snapshotRevision: revision },
    )
    expect(result.skillScanObservation).toMatchObject({ complete: true, foundCount: 1 })
    expect(result.candidates).toHaveLength(1)
    const resourceId = result.candidates[0]?.descriptor.resourceId
    if (!resourceId) throw new Error('missing test Skill')
    reads.length = 0
    const targeted = await scanWorkspaceSkills(
      { ...input, skillScanCache, reuseSkillsAt: revision },
      { workspaceRoot: workspace, snapshotRevision: revision, resourceIds: [resourceId] },
    )
    expect(targeted).not.toHaveProperty('skillScanObservation')
    expect(reads.filter((path) => path.endsWith('.md'))).toEqual([])
  })

  it('returns full custom directory observation only for root refreshes that include user-agnes', async () => {
    const { root, agnesHomeDir, input, writeSnapshot } = await deployment()
    const custom = join(root, 'custom')
    await mkdir(custom)
    await writeFile(join(custom, 'review.md'), '---\nname: review\ndescription: Useful\n---\nprivate body')
    writeContextConfig({ customSkillRoots: [custom] }, agnesHomeDir)
    const revision = await writeSnapshot({ desired: [], trust: [] })
    const params = { workspaceRoot: join(root, 'workspace'), snapshotRevision: revision }
    const full = await scanWorkspaceSkills(input, params)
    expect(full.skillScanObservation).toMatchObject({ complete: true, foundCount: 1 })
    expect(await scanWorkspaceSkills(input, { ...params, rootKey: 'user-agnes' })).toHaveProperty(
      'skillScanObservation',
    )
    expect(await scanWorkspaceSkills(input, { ...params, rootKey: 'workspace-agnes' })).not.toHaveProperty(
      'skillScanObservation',
    )
    const id = full.candidates[0]?.descriptor.resourceId
    if (!id) throw new Error('missing test Skill')
    expect(await scanWorkspaceSkills(input, { ...params, resourceIds: [id] })).not.toHaveProperty(
      'skillScanObservation',
    )
    expect(await scanWorkspaceSkills(input, { ...params, resourceIds: [] })).not.toHaveProperty(
      'skillScanObservation',
    )
    expect(JSON.stringify(full.skillScanObservation)).not.toMatch(/private body|review\.md/)
    expect(JSON.stringify(full.skillScanObservation)).not.toContain(root)
  })

  it('discovers a workspace-agnes Skill scoped to the given workspace root, matching the current snapshot revision', async () => {
    const { input, writeSnapshot, addWorkspaceSkill } = await deployment()
    const workspace = await mkdtemp(join(tmpdir(), 'agnes-workspace-'))
    roots.push(workspace)
    const candidate = await addWorkspaceSkill(workspace, 'reviewer', 'Review pull requests')
    const revision = await writeSnapshot({
      desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          capabilityHash: candidate.capabilityHash,
          state: 'trusted',
        },
      ],
    })

    const result = await scanWorkspaceSkills(input, { workspaceRoot: workspace, snapshotRevision: revision })

    expect(result.skills).toMatchObject([{ resourceId: candidate.resourceId, actual: 'ready' }])
    expect(result.candidates.map((row) => row.descriptor.resourceId)).toEqual([candidate.resourceId])
    expect(result.failedRoots).toEqual([])
    const siblingDir = join(workspace, '.agh', 'skills', 'sibling')
    await mkdir(siblingDir, { recursive: true })
    await writeFile(
      join(siblingDir, 'SKILL.md'),
      '---\nname: sibling\ndescription: Unrelated\n---\nDo not reload me.',
    )
    const lkg = join(input.profile.dataDir, 'lkg')
    await scanSkills(workspace, undefined, lkg, input.agnesHomeDir, input.agnesHomeDir)
    const { readdir } = await import('node:fs/promises')
    const caches = await Promise.all(
      (await readdir(lkg)).map(async (name) => ({ name, bytes: await readFile(join(lkg, name), 'utf8') })),
    )
    const cachedInput = { ...input, skillScanCache: new SkillScanCache(), cwd: workspace, mcpRows: true }
    const previous = await bootstrapWorkerResources(cachedInput)
    const disabledRevision = await writeSnapshot({
      desired: [{ resourceId: candidate.resourceId, state: 'disabled' }],
      trust: [
        {
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          capabilityHash: candidate.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    reads.length = 0
    const targeted = await scanWorkspaceSkills(
      { ...cachedInput, env: { ...input.env, AGNES_RESOURCE_SKILL_LKG_DIR: lkg } },
      {
        workspaceRoot: workspace,
        snapshotRevision: disabledRevision,
        resourceIds: [candidate.resourceId],
      },
    )
    expect(targeted.skills).toMatchObject([{ resourceId: candidate.resourceId, actual: 'disabled' }])
    expect(targeted.skills).toHaveLength(1)
    expect(reads.some((path) => path.startsWith(siblingDir))).toBe(false)
    expect(reads).toContain(join(workspace, '.agh', 'skills', 'reviewer', 'SKILL.md'))
    for (const cache of caches) expect(await readFile(join(lkg, cache.name), 'utf8')).toBe(cache.bytes)
    reads.length = 0
    const applied = await bootstrapWorkerResources({ ...cachedInput, reuseSkillsAt: disabledRevision })
    expect(applied?.skills.find((item) => item.resourceId === candidate.resourceId)?.actual).toBe('disabled')
    expect(previous?.skills.find((item) => item.resourceId === candidate.resourceId)?.actual).toBe('ready')
    expect(reads.filter((path) => path.endsWith('SKILL.md'))).toEqual([])
    for (const reuseSkillsAt of [undefined, revision]) {
      reads.length = 0
      const fallback = await bootstrapWorkerResources({
        ...cachedInput,
        ...(reuseSkillsAt ? { reuseSkillsAt } : {}),
      })
      expect(reads).toContain(join(siblingDir, 'SKILL.md'))
      await fallback?.runtime.mcp.close()
    }
    await applied?.runtime.mcp.close()
    await previous?.runtime.mcp.close()

    await expect(
      scanWorkspaceSkills(input, {
        workspaceRoot: workspace,
        snapshotRevision: '0'.repeat(64),
        resourceIds: [candidate.resourceId],
      }),
    ).rejects.toThrow('resource snapshot changed')
  })

  it('scopes strictly to the given workspace root: a second workspace never sees the first one’s Skill', async () => {
    const { input, writeSnapshot, addWorkspaceSkill } = await deployment()
    const workspaceA = await mkdtemp(join(tmpdir(), 'agnes-workspace-a-'))
    roots.push(workspaceA)
    const workspaceB = await mkdtemp(join(tmpdir(), 'agnes-workspace-b-'))
    roots.push(workspaceB)
    const candidateA = await addWorkspaceSkill(workspaceA, 'only-in-a', 'Only in workspace A')
    const revision = await writeSnapshot({
      desired: [{ resourceId: candidateA.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: candidateA.resourceId,
          revision: candidateA.revision,
          capabilityHash: candidateA.capabilityHash,
          state: 'trusted',
        },
      ],
    })

    const resultA = await scanWorkspaceSkills(input, {
      workspaceRoot: workspaceA,
      snapshotRevision: revision,
    })
    const resultB = await scanWorkspaceSkills(input, {
      workspaceRoot: workspaceB,
      snapshotRevision: revision,
    })

    expect(resultA.candidates.map((row) => row.descriptor.resourceId)).toEqual([candidateA.resourceId])
    expect(resultB.candidates).toEqual([])
    expect(resultB.skills).toEqual([])
  })

  it('filters candidates and skippedResourceIds to the given rootKey', async () => {
    const { input, writeSnapshot, addWorkspaceSkill } = await deployment()
    const workspace = await mkdtemp(join(tmpdir(), 'agnes-workspace-'))
    roots.push(workspace)
    const candidate = await addWorkspaceSkill(workspace, 'reviewer', 'Review pull requests')
    const revision = await writeSnapshot({ desired: [], trust: [] })

    const filtered = await scanWorkspaceSkills(input, {
      workspaceRoot: workspace,
      rootKey: 'user-agnes',
      snapshotRevision: revision,
    })
    expect(filtered.candidates).toEqual([])

    const unfiltered = await scanWorkspaceSkills(input, {
      workspaceRoot: workspace,
      rootKey: 'workspace-agnes',
      snapshotRevision: revision,
    })
    expect(unfiltered.candidates.map((row) => row.descriptor.resourceId)).toEqual([candidate.resourceId])
  })

  it('rejects a snapshotRevision that no longer matches what is on disk, rather than answering from a snapshot the daemon does not expect', async () => {
    const { input, writeSnapshot } = await deployment()
    const workspace = await mkdtemp(join(tmpdir(), 'agnes-workspace-'))
    roots.push(workspace)
    await writeSnapshot({ desired: [], trust: [] })

    await expect(
      scanWorkspaceSkills(input, { workspaceRoot: workspace, snapshotRevision: 'f'.repeat(64) }),
    ).rejects.toThrow('resource snapshot changed before this Skill scan completed')
  })
})

describe('removeWorkspaceSkill (worker side of resourceSkillRemove)', () => {
  it('validates without deleting, then deletes the workspace-agnes Skill directory it was pointed at', async () => {
    const { input, writeSnapshot, addWorkspaceSkill } = await deployment()
    const workspace = await mkdtemp(join(tmpdir(), 'agnes-workspace-'))
    roots.push(workspace)
    const candidate = await addWorkspaceSkill(workspace, 'reviewer', 'Review pull requests')
    await writeSnapshot({ desired: [], trust: [] })
    const skillFile = join(workspace, '.agh', 'skills', 'reviewer', 'SKILL.md')
    const workspaceId = (candidate as { workspaceId?: string }).workspaceId
    const descriptor = {
      kind: 'skill' as const,
      resourceId: candidate.resourceId,
      name: 'reviewer',
      revision: candidate.revision,
      sourceIdentity: {
        scope: 'workspace' as const,
        rootKey: 'workspace-agnes' as const,
        sourceId: 'a'.repeat(64),
      },
      priority: 500,
      resolution: { winner: true, shadowed: [] },
      trust: 'trusted' as const,
      desired: 'enabled' as const,
      actual: 'ready' as const,
      stale: false,
      ...(workspaceId ? { workspaceId } : {}),
    }

    await removeWorkspaceSkill(input, { workspaceRoot: workspace, descriptor, validateOnly: true })
    await expect(readFile(skillFile, 'utf8')).resolves.toContain('reviewer')

    await removeWorkspaceSkill(input, { workspaceRoot: workspace, descriptor, validateOnly: false })
    await expect(readFile(skillFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
