import type { SeamImplementations } from '@agnes/core'
import type { PackageModule, SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { bindSkillRuntimeToWorkspace } from '@agnes/host-extensions/resources/skill-preload'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { ComputerUseHost } from '../computer-use/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
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
  pkgs: PackageSet,
) {
  const { deps, workspaceRoot, workspaceInvocationFor } = ctx
  const { publicationDispatch } = ctx.gates
  const { adapters } = proc
  const { baseContext } = seamContexts
  const sessionTasks: { current?: SeamInitContext['sessionTasks'] } = {}
  const privacyTrajectory: { current?: SeamInitContext['privacyTrajectory'] } = {}
  const hookCommands =
    adapters.platform.os === 'win32'
      ? trustedHookCommands(ctx.profile.commandHooks, workspaceRoot, adapters.platform.fs())
      : undefined
  const buildEcosystemContext = (
    owner: string,
    extensionId: string,
    resources: Readonly<{ skillResources?: SkillRuntimeInput }> = deps,
    liveResources?: readonly string[],
    identity?: PackageModule,
  ): SeamInitContext => {
    const grant = pkgs.grants.extension(owner, extensionId, identity)
    const skills = resources.skillResources
      ? bindSkillRuntimeToWorkspace(resources.skillResources, workspaceInvocationFor, publicationDispatch)
      : undefined
    return {
      ...baseContext(owner),
      sandbox: seams.sandbox,
      ...(grant.sessionTasks && sessionTasks.current ? { sessionTasks: sessionTasks.current } : {}),
      ...(grant.searchProvider && deps.searchProvider ? { searchProvider: deps.searchProvider } : {}),
      ...(grant.trustedHookCommands && hookCommands ? { trustedHookCommands: hookCommands } : {}),
      ...(liveResources?.includes('skills') && skills ? { skillResources: skills } : {}),
      ...(grant.skillDiscovery ? { skillDiscovery: skillState.discovery } : {}),
      ...(grant.privacyTrajectory && privacyTrajectory.current
        ? { privacyTrajectory: privacyTrajectory.current }
        : {}),
      ...computerUse.extensionContext(grant),
    }
  }
  const ecosystemContext = (owner: string, extensionId: string): SeamInitContext =>
    buildEcosystemContext(owner, extensionId, deps, undefined, pkgs.modules.get(owner))
  return { buildEcosystemContext, ecosystemContext, privacyTrajectory, sessionTasks }
}
