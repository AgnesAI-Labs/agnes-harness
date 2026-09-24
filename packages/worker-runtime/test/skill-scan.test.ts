import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkerResourceBootstrapInput } from '@agnes/resource-control-worker'
import { scanSkills } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it } from 'vitest'
import { removeWorkspaceSkill, scanWorkspaceSkills } from '../src/commands.js'

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
