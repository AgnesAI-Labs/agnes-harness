import {
  type Kernel,
  type ProjectionRegistry,
  type RefinementDeps,
  type RefinementPlanner,
  type RefinementSettingsView,
  type RefinementTriggerSink,
  refinementFacade,
  type SessionImpl,
  scanAll,
  type TaskScope,
} from '@agnes/core'
import type { MemorySession, TaskScopeSource } from '@agnes/extension-api'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import type { HostDecisionOwner } from '@agnes/host-extensions/profile/runtime'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { JsonValue, RefinementSettingsSnapshot } from '@agnes/protocol'
import { createRefinementApprovals, REFINEMENT_DECISION_OWNER } from '../refinement/approvals.js'
import { savedParagraphs } from '../refinement/saved-paragraphs.js'
import { workspaceMemory } from '../refinement/workspace-memory.js'
import { createWorkspaceRefs } from '../refinement/workspace-refs.js'
import { createWorkspaceSave } from '../refinement/workspace-save.js'

type RefinementRunsPort = ReturnType<NonNullable<SeamInitContext['refinementRuns']>>

type ProjectedSession = Pick<SessionImpl, 'key' | 'lastSeq' | 'scan' | 'diag'>

/**
 * One projection's state for a session as of its last committed row, folded the way an extension's
 * own read folds it: only the rows after the registry's cached line when that line still stands,
 * else every row. Undefined when the projection is not registered or cannot be folded; a fold that
 * fails is recorded as a `projection-failed` diagnostic, as an extension's own read records it.
 */
async function readProjection(
  registry: ProjectionRegistry,
  session: ProjectedSession,
  key: string,
): Promise<JsonValue | undefined> {
  const asOfSeq = session.lastSeq
  const scan = (fromSeq?: number) =>
    scanAll((q) => session.scan(q), { ...(fromSeq === undefined ? {} : { fromSeq }), toSeq: asOfSeq })
  const failures = registry.failures().length
  const after = registry.cacheLine(session.key, key)?.seq
  const resumed =
    after === undefined
      ? undefined
      : registry.snapshotOneAfter(
          session.key,
          key,
          after,
          after < asOfSeq ? await scan(after + 1) : [],
          asOfSeq,
        )
  const unit = resumed ?? registry.snapshotOne(session.key, key, await scan(), asOfSeq)
  if (registry.failures().length > failures) await session.diag('projection-failed', { key, asOfSeq })
  return 'error' in unit ? undefined : (unit.state as JsonValue)
}

const OFF: RefinementSettingsSnapshot = { settings: { enabled: false, mode: 'manual' }, revision: '' }

/**
 * The profile's refinement switch as one container sees it, and the bridge between Core's
 * refinement facade and the refine plugin.
 *
 * Two reads, on purpose. The tools are registered from the value read once at assembly and keep it
 * for the container's life, so a running session never gains or loses tools. What Core reads
 * (experience delivery, triggers, planning, applying) is live and also needs the assembly value:
 * switching refinement off stops all of it at once, while switching it on waits for the next
 * assembly, when the tools are registered too. Every read is cheap and never throws; a failed read
 * is off.
 */
export function createRefinementHost(dataDir: string, profile: string, clock: () => number = Date.now) {
  const store = new RefinementSettingsStore(dataDir, profile)
  const read = (): RefinementSettingsSnapshot => {
    try {
      return store.current()
    } catch {
      return OFF
    }
  }
  const atAssembly = read()
  let kernel: Kernel | undefined
  let planner: RefinementPlanner | undefined
  /** The task source the plugin that owns tasks offered, under its projection's registry key. */
  let tasks: { key: string; source: TaskScopeSource } | undefined

  const settings = (): RefinementSettingsView => {
    const now = atAssembly.settings.enabled ? read() : OFF
    return { enabled: now.settings.enabled, mode: now.settings.mode, revision: now.revision }
  }
  const sessionOf = (key: string, lane: string) => {
    const session = kernel?.sessions.get(key)
    return session && session.lane === lane ? session : undefined
  }
  // A session's current task: the offering plugin's projection, folded for the session, as its reader
  // reports it (null: no goal). Undefined when it cannot be read now: nothing offered (the plugin is
  // off or being reloaded), the session is not open here, or the projection cannot be folded.
  const taskScope = async (at: { key: string; lane: string }): Promise<TaskScope | null | undefined> => {
    const offered = tasks
    const session = sessionOf(at.key, at.lane)
    if (!offered || !session || !kernel) return undefined
    const state = await readProjection(kernel.projections, session, offered.key)
    return state === undefined ? undefined : offered.source.reader(state).current()
  }
  // A session's memory note changed because saved paragraphs came into force or went past their review
  // date: recorded like a rebuilt experience snapshot, as an expected change of what the request carries.
  const memory = workspaceMemory({
    dataDir,
    clock,
    enabled: () => settings().enabled,
    viewChanged: (key, change) =>
      void kernel?.sessions
        .get(key)
        ?.diag('refinement-prefix-change', { reason: 'workspace-memory', ...change })
        .catch(() => undefined),
  })
  // Saves under ask wait in the profile decision journal, once the profile services hand it over.
  let decisions: Parameters<typeof createRefinementApprovals>[0]['decisions'] | undefined
  const approvals = createRefinementApprovals({
    decisions: () =>
      decisions ? decisions() : Promise.reject(new Error('profile decision journal unavailable')),
    registry: memory.registry,
    memory: memory.openWorkspaceMemory,
    settings,
    commit: (input) => saves.commitApproved(input),
    clock,
  })
  // The one save-to-workspace path: memory and prompt entries become managed workspace memory paragraphs.
  const saves = createWorkspaceSave({
    registry: memory.registry,
    settings,
    memory: memory.openWorkspaceMemory,
    approvals,
    clock,
  })
  const workspace = {
    ...memory,
    saves,
    /** A person's management of saved paragraphs on the memory page: list, renew, withdraw, convert. */
    paragraphs: savedParagraphs({ registry: memory.registry, clock }),
    /** A session's memory has just been opened: settle interrupted saves and reconcile, in the background. */
    opened<T extends MemorySession | undefined>(workspaceRoot: string, opened: T): T {
      void saves.resume(workspaceRoot)
      return memory.opened(workspaceRoot, opened)
    },
  }
  // Entries saved to the session's workspace, read for a plan and renewed when one confirms them.
  const workspaceRefs = createWorkspaceRefs({
    dataDir,
    session: (at) => {
      const session = sessionOf(at.key, at.lane)
      return (
        session && {
          workspaceRoot: session.workspaceRoot,
          ...(session.d.memory ? { memory: session.d.memory } : {}),
        }
      )
    },
    clock,
  })
  const refinement: RefinementDeps = {
    settings,
    planner: () => planner,
    taskScope,
    workspace: saves,
    workspaceRefs,
  }
  // Automatic candidates are wanted only in auto mode; Core drops child sessions before asking.
  const triggers: RefinementTriggerSink = {
    accepts: () => {
      const view = settings()
      return view.enabled && view.mode === 'auto'
    },
    offer: ({ sessionKey, lane, trigger }) => {
      const session = sessionOf(sessionKey, lane)
      if (session)
        void refinementFacade(session)
          .request(trigger)
          .catch(() => undefined)
    },
  }
  const runs: RefinementRunsPort = Object.freeze({
    // The tools speak for the model only: a save they ask for is always the model's (a `model` trigger).
    propose: async (at, proposal, options) => {
      const session = sessionOf(at.key, at.lane)
      if (!session) return { refused: 'unavailable' as const }
      const saveTo = options?.saveTo === 'workspace' ? { saveTo: 'workspace' as const } : {}
      return refinementFacade(session).propose(proposal, saveTo)
    },
    // The model asks about the work so far: the trigger falls at the last committed row.
    request: async (at, request) => {
      const session = sessionOf(at.key, at.lane)
      if (!session) return { refused: 'unavailable' as const }
      const focus = request.focus === undefined ? {} : { focus: request.focus }
      const saveTo = request.saveTo === 'workspace' ? { saveTo: 'workspace' as const } : {}
      return refinementFacade(session).request({ kind: 'model', seq: session.lastSeq, ...focus, ...saveTo })
    },
    // Read-only, and only ever the session the tool ran in: Core reads that session's own entries.
    inspect: async (at, request) => {
      const session = sessionOf(at.key, at.lane)
      return session ? refinementFacade(session).inspect(request) : { refused: 'unavailable' as const }
    },
  })

  return {
    /** The switch as the tools see it: fixed at this assembly. */
    view: Object.freeze({ current: () => atAssembly }),
    /** Saved task experience per workspace: registry, memory validity view, reconciliation, saves. */
    workspace,
    /** What the kernel is created with. */
    kernelOptions: { refinementEnabled: () => settings().enabled, refinementTriggers: triggers, refinement },
    bindKernel(k: Kernel) {
      kernel = k
    },
    /** The Host parts that keep decisions in the profile decision journal, by owner name. */
    decisionOwners: new Map<string, HostDecisionOwner>([[REFINEMENT_DECISION_OWNER, approvals.owner]]),
    /** The profile decision journal, and the person its decisions are asked of, for saves under ask. */
    bindDecisions(source: NonNullable<typeof decisions>) {
      decisions = source
    },
    /** The refine plugin hands over its planner and gets the session runs its tools call. */
    connect(p: RefinementPlanner): RefinementRunsPort {
      planner = p
      return runs
    },
    /** The plugin that owns tasks offers its task scope; the returned function withdraws the offer. */
    provideTaskScope(owner: string, source: TaskScopeSource): () => void {
      const offered = { key: `${owner}/${source.projection}`, source }
      tasks = offered
      return () => {
        if (tasks === offered) tasks = undefined
      }
    },
  }
}

export type RefinementHost = ReturnType<typeof createRefinementHost>
