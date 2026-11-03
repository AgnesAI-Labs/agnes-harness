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
import type { TaskScopeSource } from '@agnes/extension-api'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { JsonValue, RefinementSettingsSnapshot } from '@agnes/protocol'

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
export function createRefinementHost(dataDir: string, profile: string) {
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
  const refinement: RefinementDeps = { settings, planner: () => planner, taskScope }
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
    propose: async (at, proposal) => {
      const session = sessionOf(at.key, at.lane)
      return session ? refinementFacade(session).propose(proposal) : { refused: 'unavailable' as const }
    },
    // The model asks about the work so far: the trigger falls at the last committed row.
    request: async (at, request) => {
      const session = sessionOf(at.key, at.lane)
      if (!session) return { refused: 'unavailable' as const }
      const focus = request.focus === undefined ? {} : { focus: request.focus }
      return refinementFacade(session).request({ kind: 'model', seq: session.lastSeq, ...focus })
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
    /** What the kernel is created with. */
    kernelOptions: { refinementEnabled: () => settings().enabled, refinementTriggers: triggers, refinement },
    bindKernel(k: Kernel) {
      kernel = k
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
