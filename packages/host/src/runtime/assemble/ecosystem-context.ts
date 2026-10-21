import { hasChildControl, type SeamImplementations } from '@agnes/core'
import type { SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { bindSkillRuntimeToWorkspace } from '@agnes/host-extensions/resources/skill-preload'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { ComputerUseHost } from '../computer-use/index.js'
import type { AssemblyContext } from './context.js'
import type { ProcessServices } from './process-services.js'
import type { SeamContexts } from './seam-contexts.js'
import type { SkillState } from './skills.js'
import { trustedHookCommands } from './trusted-hooks.js'

/**
 * What a bundled extension's factory is handed: the seam init context plus the few
 * host-held capabilities its id and owner are granted.
 */
export function createEcosystemContexts(
  ctx: AssemblyContext,
  proc: ProcessServices,
  seamContexts: SeamContexts,
  skillState: SkillState,
  computerUse: ComputerUseHost,
  seams: SeamImplementations,
) {
  const { deps, workspaceRoot, workspaceInvocationFor } = ctx
  const { publicationDispatch } = ctx.gates
  const { adapters } = proc
  const { baseContext } = seamContexts
  const sessionTasks: { current?: SeamInitContext['sessionTasks'] } = {}
  const privacyTrajectory: { current?: SeamInitContext['privacyTrajectory'] } = {}
  const storage = adapters.storage
  // Only the two primary-key calls subagent worktree binding needs, never the whole store. It goes
  // to the @agnes/base owner like sessionTasks; Base forwards it only to agnes/subagent.
  const childControl =
    hasChildControl(storage) && storage.updateWorkspace
      ? Object.freeze({
          lookupByKey: storage.lookupByKey.bind(storage),
          updateWorkspace: storage.updateWorkspace.bind(storage),
        })
      : undefined
  const hookCommands =
    adapters.platform.os === 'win32'
      ? trustedHookCommands(ctx.profile.commandHooks, workspaceRoot, adapters.platform.fs())
      : undefined
  const buildEcosystemContext = (
    owner: string,
    extensionId: string,
    resources: Readonly<{ skillResources?: SkillRuntimeInput }> = deps,
    liveResources?: readonly string[],
  ): SeamInitContext => {
    const skills = resources.skillResources
      ? bindSkillRuntimeToWorkspace(resources.skillResources, workspaceInvocationFor, publicationDispatch)
      : undefined
    return {
      ...baseContext(owner),
      sandbox: seams.sandbox,
      ...(owner === '@agnes/base'
        ? {
            ...(sessionTasks.current ? { sessionTasks: sessionTasks.current } : {}),
            ...(childControl ? { childControl } : {}),
          }
        : {}),
      ...(owner === '@agnes/base' && extensionId === 'agnes/tools-web' && deps.searchProvider
        ? { searchProvider: deps.searchProvider }
        : {}),
      ...(owner === '@agnes/base' && extensionId === 'agnes/hooks-runner' && hookCommands
        ? { trustedHookCommands: hookCommands }
        : {}),
      ...(liveResources?.includes('skills') && skills ? { skillResources: skills } : {}),
      ...(owner === '@agnes/base' && extensionId === 'agnes/mcp-search'
        ? { skillDiscovery: skillState.discovery }
        : {}),
      ...(owner === '@agnes/base' && extensionId === 'agnes/privacy' && privacyTrajectory.current
        ? { privacyTrajectory: privacyTrajectory.current }
        : {}),
      ...computerUse.extensionContext(owner, extensionId),
    }
  }
  const ecosystemContext = (owner: string, extensionId: string): SeamInitContext =>
    buildEcosystemContext(owner, extensionId)
  return { buildEcosystemContext, ecosystemContext, privacyTrajectory, sessionTasks }
}
