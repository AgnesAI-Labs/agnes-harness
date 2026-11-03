import { dirname } from 'node:path'
import { hasChildControl, type SeamImplementations } from '@agnes/core'
import type { PackageModule, SeamInitContext } from '@agnes/host-extensions/assemble/packages'
import { bindSkillRuntimeToWorkspace } from '@agnes/host-extensions/resources/skill-preload'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { ComputerUseHost } from '../computer-use/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { ProcessServices } from './process-services.js'
import { createRefinementHost } from './refinement.js'
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
  const storage = adapters.storage
  // Only the two primary-key calls subagent worktree binding needs, never the whole store. Like
  // sessionTasks it goes to every @agnes/base-owned context; Base's ecosystem map strips it from
  // every factory but agnes/subagent, while the MCP server rows and the isolated hooks-runner
  // preparation receive it unnarrowed and do not read it.
  const childControl =
    hasChildControl(storage) && storage.updateWorkspace
      ? Object.freeze({
          lookupByKey: storage.lookupByKey.bind(storage),
          updateWorkspace: storage.updateWorkspace.bind(storage),
        })
      : undefined
  // The profile's refinement switch (the file the settings RPC writes), read once per container
  // assembly and fixed for the container's life: a factory runs again on every row load, and a
  // value read then would let a running session gain or lose tools mid-conversation. A new process,
  // worker or generation assembles again and reads it fresh. This view decides tool registration
  // only; what Core reads is live as well (see createRefinementHost).
  const refinement = createRefinementHost(ctx.dataDir, ctx.profile.name, ctx.clock, {
    // The home memory is opened with (kernel-stage): user memory and its registry live there.
    home: dirname(dirname(deps.profileDir)),
    skills: () => skillState.discovery,
    ...(deps.refinementSave ? { refinementSave: deps.refinementSave } : {}),
  })
  const refinementView: SeamInitContext['refinementSettings'] = refinement.view
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
      ...(grant.childControl && childControl ? { childControl } : {}),
      ...(grant.searchProvider && deps.searchProvider ? { searchProvider: deps.searchProvider } : {}),
      ...(grant.trustedHookCommands && hookCommands ? { trustedHookCommands: hookCommands } : {}),
      ...(liveResources?.includes('skills') && skills ? { skillResources: skills } : {}),
      ...(grant.skillDiscovery ? { skillDiscovery: skillState.discovery } : {}),
      ...(grant.refinementSettings
        ? { refinementSettings: refinementView, refinementRuns: (planner) => refinement.connect(planner) }
        : {}),
      ...(grant.taskScope
        ? { provideTaskScope: (source) => refinement.provideTaskScope(extensionId, source) }
        : {}),
      ...(grant.privacyTrajectory && privacyTrajectory.current
        ? { privacyTrajectory: privacyTrajectory.current }
        : {}),
      ...computerUse.extensionContext(grant),
    }
  }
  const ecosystemContext = (owner: string, extensionId: string): SeamInitContext =>
    buildEcosystemContext(owner, extensionId, deps, undefined, pkgs.modules.get(owner))
  return { buildEcosystemContext, ecosystemContext, privacyTrajectory, sessionTasks, refinement }
}
