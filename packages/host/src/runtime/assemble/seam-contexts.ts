import { homedir } from 'node:os'
import type { SeamImplementations, SeamName } from '@agnes/core'
import type { SeamInit, SeamKind } from '@agnes/extension-api/seams'
import type { SeamInitContext, SeamProfileView } from '@agnes/host-extensions/assemble/packages'
import { toSeamAdapters } from '../adapters/index.js'
import { inspectComputerUseArtifacts } from '../computer-use/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import { createStaticSeams } from './seams.js'

/** What a seam factory is handed to initialise, and the two seams that are initialised before any row mounts. */
export type SeamContexts = Readonly<{
  seamProfile: SeamProfileView
  baseContext(owner: string): SeamInitContext
  contextFor(owner: string, seamName: SeamName): { context: SeamInitContext; cleanup(): void }
  /** The `create` input for a provider of `sourcePackage`; only builtin packages see the wider view. */
  initFor(
    sourcePackage: string,
    kind: SeamKind,
    builtin: boolean,
    preset: Readonly<Record<string, unknown>>,
  ): SeamInit
  retention: ReturnType<typeof inspectComputerUseArtifacts>
  staticSeams: Pick<SeamImplementations, 'sandbox' | 'platform'>
}>

/** Step `seams`, first half: the seam init context and the static `sandbox` and `platform` seams. */
export function openSeamContexts(
  ctx: AssemblyContext,
  proc: ProcessServices,
  presets: PresetCatalog,
  pkgs: PackageSet,
): SeamContexts {
  const { deps, dataDir, workspaceRoot, clock } = ctx
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
      ...retention.contextFor(pkgs.grants.seam(owner, seamName, pkgs.modules.get(owner))),
    }
    return { context, cleanup: () => undefined }
  }
  const staticSeams = createStaticSeams(adapters.platform, deps.sandboxSeam)
  // A remote deployment states its posture once, before any workspace is fitted: capability
  // answers read "remote host boundary", and the exec gate lets a remote command past its fourth
  // check. 'none' would deadlock it and 'l1' would claim local isolation nobody measured.
  // `onUnavailable` stays 'deny': a remote deployment never falls back to unconfined local
  // execution, and the dead-channel decision belongs to the remote runner.
  if (adapters.transport) {
    adapters.reportSandboxBackend({ name: 'remote', enforcement: { level: 'none', scope: [] } })
    adapters.declareExecGate({ backend: 'remote', onUnavailable: 'deny' })
  }
  const initFor = (
    sourcePackage: string,
    kind: SeamKind,
    builtin: boolean,
    preset: Readonly<Record<string, unknown>>,
  ): SeamInit => {
    const base = builtin ? contextFor(sourcePackage, kind).context : baseContext(sourcePackage)
    const init: SeamInit = {
      secrets: base.secrets,
      adapters: base.adapters,
      profile: Object.freeze({ ...base.profile, preset: { ...preset } }),
      log: base.log,
      signal: base.signal,
      ...(base.seamTimeoutMs === undefined ? {} : { seamTimeoutMs: base.seamTimeoutMs }),
    }
    // Builtin packages keep the privileged fields the Host attaches per (package, seam); no other
    // package is handed them.
    return builtin ? { ...base, ...init } : init
  }
  return { seamProfile, baseContext, contextFor, initFor, retention, staticSeams }
}
