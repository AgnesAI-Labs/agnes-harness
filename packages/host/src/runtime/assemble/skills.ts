import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SkillRuntimeDiscovery } from '@agnes/host-extensions/assemble/packages'
import {
  bindSkillRuntimeToWorkspace,
  createSkillPromptPreloader,
} from '@agnes/host-extensions/resources/skill-preload'
import { safeSkillReadRoots } from '@agnes/host-extensions/resources/skill-read-roots'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { skillRuntimeOwnerMatches } from '@agnes/resource-control-runtime'
import { compositionSkillOwners, compositionSkills } from '../profile/composition-visibility.js'
import type { AssemblyContext } from './context.js'
import type { ProcessServices } from './process-services.js'

/**
 * The Skill generation this assembly serves, which a Skills row refresh replaces. The two
 * mutable fields move together: `refreshSkillRow` swaps them and restores them on failure.
 */
export type SkillState = {
  readonly bind: (input: SkillRuntimeInput | undefined) => SkillRuntimeInput | undefined
  readonly owners: ReturnType<typeof compositionSkillOwners>
  /** What prompts preload and the fence's read roots come from. */
  preload: SkillRuntimeInput | undefined
  /** What the live resource input reads; equal to `preload` outside a refresh. */
  active: SkillRuntimeInput | undefined
  /**
   * Shared workers discover workspace Skills lazily inside a session invocation. Their global
   * list() can stay empty while the workspace catalogue changes, so an unchanged row must still
   * read the newly bootstrapped source on the next turn.
   */
  readonly liveInput: SkillRuntimeInput
  /** Search discovery follows the currently published live Skills source. */
  readonly discovery: SkillRuntimeDiscovery
  readonly promptPreloader: ReturnType<typeof createSkillPromptPreloader> | undefined
}

export function createSkillState(ctx: AssemblyContext, proc: ProcessServices): SkillState {
  const { deps, dataDir, workspaceInvocationFor } = ctx
  const { publicationDispatch } = ctx.gates
  const owners = compositionSkillOwners(deps.runtimePluginCatalogue ?? deps.runtimePluginSnapshots ?? [])
  const bind = (input: SkillRuntimeInput | undefined) => {
    const scoped = deps.skillContribution
      ? (input?.scopeRuntime?.((owner) => {
          const tree = ctx.live.pluginTree.peek()
          return !!tree && skillRuntimeOwnerMatches(owner, tree.root, (rowId) => tree.tree.fiber(rowId))
        }) ?? input)
      : input
    return compositionSkills(scoped, ctx.profile.composition ?? {}, owners, (key) => {
      return key ? ctx.live.kernel.peek()?.get(key)?.roleAuthority?.resources : undefined
    })
  }
  const preload = bind(deps.skillResources)
  const state: SkillState = {
    bind,
    owners,
    preload,
    active: preload,
    liveInput: Object.freeze({
      list: () => state.active?.list() ?? [],
      invocation: (resourceId) => state.active?.invocation?.(resourceId),
      read: (resourceId, session) =>
        state.active?.read(resourceId, session) ?? { ok: false, code: 'NOT_FOUND' },
      readFile: (resourceId, revision, path, session) =>
        state.active?.readFile(resourceId, revision, path, session) ?? {
          ok: false,
          code: 'NOT_FOUND',
        },
      readRoots: () => state.active?.readRoots?.() ?? [],
      scopeWorkspace: (root, sessionKey, invoke) =>
        state.active?.scopeWorkspace?.(root, sessionKey, invoke) ?? invoke(),
    }),
    discovery: Object.freeze({
      list: () => state.preload?.list() ?? [],
      invocation: (resourceId) => state.preload?.invocation?.(resourceId),
      runInWorkspace: <T>(sessionKey: string, invoke: () => Promise<T>): Promise<T> => {
        const current = state.preload
        if (!current) return invoke()
        return bindSkillRuntimeToWorkspace(
          current,
          workspaceInvocationFor,
          publicationDispatch,
        ).runInWorkspace(sessionKey, invoke)
      },
    }),
    promptPreloader: deps.skillResources
      ? createSkillPromptPreloader(() => state.preload, workspaceInvocationFor, publicationDispatch)
      : undefined,
  }
  const readContext = { homeDir: deps.homeDir ?? homedir(), agnesHome: dirname(dataDir), dataDir }
  proc.skillReadRoots.current = (sessionKey) => {
    // The filesystem handle owns this identity; Skill discovery's separate async scope is
    // absent on ordinary read/list/stat calls. Roles use the resource-gated read/readFile APIs.
    if (sessionKey) {
      const session = ctx.live.kernel.peek()?.get(sessionKey)
      if (!session || session.roleAuthority) return []
    }
    return safeSkillReadRoots(state.preload?.readRoots?.() ?? [], {
      ...readContext,
      generationRoot: join(deps.profileDir, '.runtime-generations'),
    })
  }
  return state
}
