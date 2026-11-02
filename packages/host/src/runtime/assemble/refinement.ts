import {
  type Kernel,
  type RefinementDeps,
  type RefinementPlanner,
  type RefinementSettingsView,
  type RefinementTriggerSink,
  refinementFacade,
} from '@agnes/core'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { RefinementSettingsSnapshot } from '@agnes/protocol'

type RefinementRunsPort = ReturnType<NonNullable<SeamInitContext['refinementRuns']>>

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

  const settings = (): RefinementSettingsView => {
    const now = atAssembly.settings.enabled ? read() : OFF
    return { enabled: now.settings.enabled, mode: now.settings.mode, revision: now.revision }
  }
  const sessionOf = (key: string, lane: string) => {
    const session = kernel?.sessions.get(key)
    return session && session.lane === lane ? session : undefined
  }
  const refinement: RefinementDeps = { settings, planner: () => planner }
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
  }
}

export type RefinementHost = ReturnType<typeof createRefinementHost>
