import { homedir } from 'node:os'
import type { SeamImplementations, SeamName } from '@agnes/core'
import type { SeamInitContext, SeamProfileView } from '@agnes/host-extensions/assemble/packages'
import { sandboxHostServices, toSeamAdapters } from '../adapters/index.js'
import { inspectComputerUseArtifacts } from '../computer-use/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import { initStaticSeams } from './seams.js'

/** What a seam factory is handed to initialise, and the two seams that are initialised before any row mounts. */
export type SeamContexts = Readonly<{
  seamProfile: SeamProfileView
  baseContext(owner: string): SeamInitContext
  contextFor(owner: string, seamName: SeamName): { context: SeamInitContext; cleanup(): void }
  retention: ReturnType<typeof inspectComputerUseArtifacts>
  staticSeams: Pick<SeamImplementations, 'sandbox' | 'platform'>
}>

/** Step `seams`, first half: the seam init context and the static `sandbox` and `platform` seams. */
export async function openSeamContexts(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  proc: ProcessServices,
  presets: PresetCatalog,
): Promise<SeamContexts> {
  const { deps, dataDir, workspaceRoot, rollback, clock } = ctx
  const { modules } = pkgs
  const { adapters, secrets, nativePlatform } = proc
  const seamProfile: SeamProfileView = {
    name: ctx.profile.name,
    resolvedProfileHash: ctx.profile.hash,
    dataDir,
    workspaceRoot,
    homeDir: deps.homeDir ?? homedir(),
    limits: ctx.profile.limits,
    preset: presets.defaultPreset.doc,
  }
  const baseContext = (owner: string): SeamInitContext => ({
    secrets,
    adapters: toSeamAdapters(adapters, { owner, ...(deps.prompter ? { prompter: deps.prompter } : {}) }),
    profile: seamProfile,
    log: deps.log,
    signal: ctx.abort.signal,
    seamTimeoutMs: deps.seamTimeoutMs ?? 30_000,
  })
  const retention = inspectComputerUseArtifacts({
    profile: ctx.profile,
    dataDir,
    platform: adapters.platform,
    nativePlatform,
    clock,
    log: deps.log,
  })
  const contextFor = (owner: string, seamName: SeamName): { context: SeamInitContext; cleanup(): void } => {
    const context = {
      ...baseContext(owner),
      ...retention.contextFor(owner, seamName),
    }
    // Only the sandbox factory is handed the path-policy canonicalizer and a probe exec, and the
    // probe dies with the factory. Every other seam gets the plain context - and the
    // policy-bound exec inside it.
    if (seamName !== 'sandbox') return { context, cleanup: () => undefined }
    const { services, revoke } = sandboxHostServices(adapters)
    return { context: { ...context, sandboxHost: services }, cleanup: revoke }
  }
  const staticSeams = await initStaticSeams(ctx.profile, modules, contextFor, {
    timeoutMs: deps.seamTimeoutMs ?? 30_000,
    platform: adapters.platform,
    rollback,
  })
  return { seamProfile, baseContext, contextFor, retention, staticSeams }
}
