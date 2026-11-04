import { dirname } from 'node:path'
import {
  type Kernel,
  type RefinementDeps,
  type RefinementPlanner,
  type RefinementSettingsView,
  type RefinementTriggerSink,
  refinementFacade,
} from '@agnes/core'
import type { MemorySession } from '@agnes/extension-api'
import type { SeamInitContext, SkillRuntimeDiscovery } from '@agnes/host-extensions/assemble/packages'
import type { HostDecisionOwner } from '@agnes/host-extensions/profile/runtime'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { RefinementSettingsSnapshot } from '@agnes/protocol'
import { createRefinementApprovals, REFINEMENT_DECISION_OWNER } from '../refinement/approvals.js'
import { offeredSources } from '../refinement/offered-sources.js'
import { createRefinementReferences } from '../refinement/references.js'
import { savedParagraphs } from '../refinement/saved-paragraphs.js'
import { createSkillDraftStore } from '../refinement/skill-drafts.js'
import { savedSkillFolderGone } from '../refinement/skill-folders.js'
import { type RefinementSaveTransport, skillSender } from '../refinement/skill-sender.js'
import { userMemory } from '../refinement/user-memory.js'
import { workspaceMemory } from '../refinement/workspace-memory.js'
import { createWorkspaceRefs } from '../refinement/workspace-refs.js'
import { createWorkspaceSave } from '../refinement/workspace-save.js'

type RefinementRunsPort = ReturnType<NonNullable<SeamInitContext['refinementRuns']>>

const OFF: RefinementSettingsSnapshot = { settings: { enabled: false, mode: 'manual' }, revision: '' }

/**
 * The profile's refinement switch as one container sees it, and the bridge between Core's
 * refinement facade and the refine plugin.
 *
 * The switch is read live. Core decides per session, as it opens, whether the session runs task
 * experience at all (`@agnes/core` refinement/capture): the refine plugin's tools are registered
 * for the container's life and offered only to sessions opened while the switch was on, so a
 * running session never gains or loses tools. What such a session reads (experience delivery,
 * triggers, planning, applying) is this live switch: switching refinement off stops all of it at
 * once, switching it on reaches the sessions opened from then on. Every read is cheap and never
 * throws; a failed read is off.
 */
export function createRefinementHost(
  dataDir: string,
  profile: string,
  clock: () => number = Date.now,
  sources: {
    skills?: () => SkillRuntimeDiscovery | undefined
    /** Where saved skills are installed: the process that holds resource control. Absent: none are. */
    refinementSave?: RefinementSaveTransport
    /** The installation home memory is opened with; absent, the standard layout's (`<home>/data`). */
    home?: string
  } = {},
) {
  const store = new RefinementSettingsStore(dataDir, profile)
  const read = (): RefinementSettingsSnapshot => {
    try {
      return store.current()
    } catch {
      return OFF
    }
  }
  let kernel: Kernel | undefined
  let planner: RefinementPlanner | undefined
  const settings = (): RefinementSettingsView => {
    const now = read()
    return { enabled: now.settings.enabled, mode: now.settings.mode, revision: now.revision }
  }
  const sessionOf = (key: string, lane: string) => {
    const session = kernel?.sessions.get(key)
    return session && session.lane === lane ? session : undefined
  }
  // A session's memory note changed: recorded only for a session that runs task experience now (one
  // opened before the switch went on runs as if it were off).
  const prefixChanged = (key: string, data: Record<string, unknown>) => {
    const session = kernel?.sessions.get(key)
    if (session?.d.refinementEnabled?.() === true)
      void session.diag('refinement-prefix-change', data).catch(() => undefined)
  }
  // What the plugins that own tasks and workflow runs offer, read for one session at a time.
  const offered = offeredSources({ kernel: () => kernel, session: sessionOf })
  const { taskScope, workflowRuns } = offered
  // A session's memory note changed because saved paragraphs came into force or went past their review
  // date: recorded like a rebuilt experience snapshot, as an expected change of what the request carries.
  const memory = workspaceMemory({
    dataDir,
    clock,
    enabled: () => settings().enabled,
    viewChanged: (key, change) => prefixChanged(key, { reason: 'workspace-memory', ...change }),
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
  // Skill entries become workspace skills through the installer where resource control lives.
  const transport = sources.refinementSave
  const skills = transport && {
    request: skillSender(transport, { enabled: () => settings().enabled }),
    drafts: createSkillDraftStore(dataDir),
    gone: (root: string, name: string) => savedSkillFolderGone(dataDir, root, name),
  }
  // The one save-to-workspace path: memory and prompt entries become managed workspace memory
  // paragraphs, skill entries workspace skills.
  const saves = createWorkspaceSave({
    registry: memory.registry,
    settings,
    memory: memory.openWorkspaceMemory,
    approvals,
    ...(skills ? { skills } : {}),
    workflowRuns,
    clock,
  })
  // Lessons that hold in every workspace are promoted to user memory; every save goes through `user.saves`.
  const user = userMemory({
    home: sources.home ?? dirname(dataDir),
    clock,
    settings,
    saves,
    registry: memory.registry,
    memory: memory.openWorkspaceMemory,
    workspaceParagraphs: savedParagraphs({ registry: memory.registry, clock }),
    viewChanged: (key, change) => prefixChanged(key, { reason: 'user-memory', ...change }),
  })
  const routed = user.saves
  const workspace = {
    ...memory,
    saves: routed,
    userValidity: user.userValidity,
    userRegistry: user.userRegistry,
    /**
     * A person's management of saved paragraphs on the memory page: list, renew, withdraw, convert; with
     * `layer: 'user'`, of the sections promoted to user memory (no convert).
     */
    paragraphs: user.paragraphs,
    /** A session's memory has just been opened: settle interrupted saves and reconcile, in the background. */
    opened<T extends MemorySession | undefined>(workspaceRoot: string, opened: T): T {
      void saves.resume(workspaceRoot)
      void user.resume(workspaceRoot)
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
  // Skills and roles a skill or subagent entry is bound to, as the session can use them now.
  const references = createRefinementReferences({ session: sessionOf, skills: () => sources.skills?.() })
  const refinement: RefinementDeps = {
    settings,
    planner: () => planner,
    taskScope,
    workspace: routed,
    workspaceRefs,
    references,
    workflowRuns,
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
      return refinementFacade(session).propose(proposal, options?.saveTo ? { saveTo: options.saveTo } : {})
    },
    // The model asks about the work so far: the trigger falls at the last committed row.
    request: async (at, request) => {
      const session = sessionOf(at.key, at.lane)
      if (!session) return { refused: 'unavailable' as const }
      const focus = request.focus === undefined ? {} : { focus: request.focus }
      const saveTo = request.saveTo ? { saveTo: request.saveTo } : {}
      return refinementFacade(session).request({ kind: 'model', seq: session.lastSeq, ...focus, ...saveTo })
    },
    // Read-only, and only ever the session the tool ran in: Core reads that session's own entries.
    inspect: async (at, request) => {
      const session = sessionOf(at.key, at.lane)
      return session ? refinementFacade(session).inspect(request) : { refused: 'unavailable' as const }
    },
  })

  return {
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
    provideTaskScope: offered.provideTaskScope,
    /** The plugin that runs workflows offers its run records; the returned function withdraws the offer. */
    provideWorkflowRuns: offered.provideWorkflowRuns,
  }
}

export type RefinementHost = ReturnType<typeof createRefinementHost>
