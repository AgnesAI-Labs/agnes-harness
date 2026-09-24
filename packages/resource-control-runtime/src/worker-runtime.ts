import type { McpStatus } from '@agnes/protocol'
import type { createMcpResourceManager, McpManagedInput, McpRuntimeInput } from './mcp.js'
import type {
  createSkillCandidateRegistry,
  SkillCandidate,
  SkillControlInput,
  SkillRuntimeInput,
  SkillSourceIdentity,
} from './skills.js'

type SkillRegistry = ReturnType<typeof createSkillCandidateRegistry>
type McpManager = ReturnType<typeof createMcpResourceManager>

/** Private worker input. Skill bodies and capability hashes never leave this process. */
export type WorkerResolvedResourceSnapshot = Readonly<{
  /** Durable authority marker, set by the daemon's atomically written control snapshot. */
  mcpAuthority: 'resource-control'
  skills: Readonly<{
    roots: readonly Readonly<{
      rootKey: SkillSourceIdentity['rootKey']
      candidates: readonly SkillCandidate[]
    }>[]
    /** A worker-private LKG body was used because the root could not be rescanned. */
    failedRoots?: readonly SkillSourceIdentity['rootKey'][]
    control: SkillControlInput
  }>
  mcp: readonly McpManagedInput[]
}>

export type WorkerResourceBootstrap = Readonly<{
  skillResources: SkillRuntimeInput
  mcpResources: McpRuntimeInput
  /** Passed through to Base even when `mcpResources.list()` is empty. */
  mcpResourceAuthority: 'resource-control'
  skillActual: ReturnType<SkillRegistry['actual']>
  mcpActual: readonly McpStatus[]
}>

/**
 * The narrow worker-side composition port shared with the Daemon worker bridge. It deliberately
 * has no daemon import, persistence, RPC, or secret export. A worker reads a durable, public
 * control snapshot, resolves private Skills/credentials locally, and hands only immutable runtime
 * snapshots to `createHost`. Resource changes use worker retirement/recreation today: applying a
 * new snapshot to a running Host needs a separate extension-reload contract.
 */
export type WorkerResourceRuntime = Readonly<{
  bootstrap(snapshot: WorkerResolvedResourceSnapshot, signal: AbortSignal): Promise<WorkerResourceBootstrap>
  skillResources(): SkillRuntimeInput
  mcpResources(): McpRuntimeInput
  skills: SkillRegistry
  mcp: McpManager
}>

export function createWorkerResourceRuntime(input: {
  profile: string
  skills: SkillRegistry
  mcp: McpManager
}): WorkerResourceRuntime {
  let skillResources = input.skills.snapshot()
  let mcpResources = input.mcp.snapshot()

  return Object.freeze({
    async bootstrap(snapshot, signal) {
      if (signal.aborted) throw new DOMException('resource bootstrap aborted', 'AbortError')
      for (const root of snapshot.skills.roots) {
        if (root.rootKey === 'package') input.skills.replacePackage(root.candidates)
        else input.skills.replaceRoot(root.rootKey, root.candidates)
      }
      for (const root of snapshot.skills.failedRoots ?? []) {
        if (root !== 'package') input.skills.failRoot(root, new Error('skill root scan failed'))
      }
      input.skills.setControl(snapshot.skills.control)
      // Before `createHost` exists, this barrier publication only publishes the immutable input.
      // The subsequently assembled Base extension registers that exact snapshot once.
      await input.skills.activate('worker-resource-bootstrap:skills', async () => undefined)
      skillResources = input.skills.snapshot()

      for (const managed of snapshot.mcp) input.mcp.stage(managed)
      const mcpActual: McpStatus[] = []
      for (const managed of snapshot.mcp) {
        if (signal.aborted) throw new DOMException('resource bootstrap aborted', 'AbortError')
        const result = await input.mcp.reconcile({
          profile: input.profile,
          serverId: managed.definition.serverId,
          definition: managed.definition,
          enabled: managed.desired === 'enabled',
          signal,
        })
        mcpActual.push(result.status)
      }
      mcpResources = input.mcp.snapshot()
      return Object.freeze({
        skillResources,
        mcpResources,
        mcpResourceAuthority: snapshot.mcpAuthority,
        skillActual: input.skills.actual(),
        mcpActual: Object.freeze(mcpActual),
      })
    },
    skillResources: () => skillResources,
    mcpResources: () => mcpResources,
    skills: input.skills,
    mcp: input.mcp,
  })
}
