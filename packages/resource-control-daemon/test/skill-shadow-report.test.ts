import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  McpLifecycleAdapter,
  ResourceControlStore,
  SkillCatalogAdapter,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSkillCandidateRegistry,
  type SkillCandidate,
} from '../../resource-control-runtime/src/skills.js'
import { installResourceServiceAdapters, type ResourceAdapterOptions } from '../src/service-adapters.js'
import { resourceWorkerObservation } from '../src/worker-bridge.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex')
const barrier = {
  quiesce: async <T>(_id: string, publish: (permit: unknown) => Promise<T>) => publish({}),
}
const fileRoots = [
  ['workspace-agnes', 'workspace', 500],
  ['user-agnes', 'user', 400],
  ['user-agents', 'user', 300],
  ['user-claude', 'user', 200],
  ['user-codex', 'user', 100],
] as const

function candidate(
  rootKey: SkillCandidate['sourceIdentity']['rootKey'],
  scope: SkillCandidate['sourceIdentity']['scope'],
  priority: number,
  seed: string,
  description = `${seed} description`,
): SkillCandidate {
  const sourceId = hex(seed)
  return {
    resourceId: `skill/${scope}/${rootKey}/${sourceId}`,
    name: 'shared-name',
    description,
    revision: hex(`${seed}:revision`),
    capabilityHash: hex(`${seed}:capability`),
    sourceIdentity: { scope, rootKey, sourceId },
    priority,
    body: `${seed} body`,
  }
}

/** Five file roots and thirty package Skills share one name: the winner shadows 34 candidates. */
async function crowdedReport() {
  const registry = createSkillCandidateRegistry({ barrier })
  const longDescription = '😀'.repeat(512)
  for (const [rootKey, scope, priority] of fileRoots)
    registry.replaceRoot(rootKey, [
      candidate(
        rootKey,
        scope,
        priority,
        rootKey,
        rootKey === 'workspace-agnes' ? longDescription : undefined,
      ),
    ])
  registry.replacePackage(
    Array.from({ length: 30 }, (_, index) => candidate('package', 'package', 50, `package-${index}`)),
  )
  await registry.activate('crowded', async () => undefined)
  return { skills: registry.actual(), longDescription }
}

function scanAdapters(reply: unknown): SkillCatalogAdapter {
  const home = mkdtempSync(join(tmpdir(), 'agnes-skill-shadow-report-'))
  dirs.push(home)
  const snapshotPath = join(home, 'snapshot.json')
  writeFileSync(snapshotPath, '{"skills":[],"mcp":[]}', 'utf8')
  let captured: { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter } | undefined
  const store = {
    snapshotPath: () => snapshotPath,
    setAdapters: (adapters: { skills: SkillCatalogAdapter; mcp: McpLifecycleAdapter }) => {
      captured = adapters
    },
    mcp: { observeWorker: async () => undefined, observedStatus: async () => undefined },
  } as unknown as ResourceControlStore
  const acquireSharedWorker = vi.fn(async () => ({
    hello: Promise.resolve({}),
    command: async () => reply,
    close: () => undefined,
    alive: true,
  }))
  installResourceServiceAdapters({
    store,
    pool: { acquire: vi.fn(), acquireSharedWorker } as unknown as ResourceAdapterOptions['pool'],
    profile: { name: 'local-dev', hash: 'a'.repeat(64) },
    workspaceRoot: '/ws/default',
    refreshPackageSkills: async () => undefined,
  })
  if (!captured) throw new Error('setAdapters was never called')
  return captured.skills
}

describe('a crowded Skill name does not drop the whole report', () => {
  it('keeps the worker observation with 34 shadows and a 1024-unit description', async () => {
    const { skills, longDescription } = await crowdedReport()
    const observation = resourceWorkerObservation({
      workerKind: 'session',
      resources: { snapshotRevision: 'b'.repeat(64), skills, mcp: [] },
    })
    expect(observation).toBeDefined()
    expect(observation?.report.skills).toHaveLength(35)

    const winner = skills.find((skill) => skill.resolution.winner)
    expect(winner?.sourceIdentity.rootKey).toBe('workspace-agnes')
    expect(winner?.description).toBe(longDescription)
    expect(winner?.resolution.shadowed).toHaveLength(32)
    expect(winner?.resolution.shadowed[0]?.sourceIdentity.rootKey).toBe('user-agnes')
  })

  it('accepts the same report as a Skill scan reply', async () => {
    const { skills } = await crowdedReport()
    const adapters = scanAdapters({
      skills,
      candidates: skills.map((descriptor) => ({ descriptor, capabilityHash: 'c'.repeat(64) })),
      failedRoots: [],
      skippedResourceIds: [],
      roots: [],
    })
    const result = await adapters.refresh({ profile: 'local-dev', signal: new AbortController().signal })
    expect(result).toMatchObject({ failedRoots: [] })
    expect((result as { candidates: readonly unknown[] }).candidates).toHaveLength(35)
  })
})
