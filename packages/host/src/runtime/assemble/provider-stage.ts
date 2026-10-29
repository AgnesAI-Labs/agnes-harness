import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { businessLimit } from '@agnes/host-common/profile-policy'
import type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import { resolveFileSecretsDirectory } from '@agnes/host-infrastructure/adapters/file-secrets-dir'
import {
  composeSecrets,
  createSecretsEnv,
  createSecretsFile,
} from '@agnes/host-infrastructure/adapters/secrets'
import { RequestTraceStore } from '@agnes/host-infrastructure/request-traces'
import { bindModelContracts } from '@agnes/host-providers/assemble/contracts'
import { modelRuntime } from '@agnes/host-providers/assemble/model-runtime'
import {
  buildProvider,
  readCreditsPerUsd,
  unresolvedProviderAssembly,
} from '@agnes/host-providers/assemble/provider'
import {
  applyProviderSelections,
  selectConfiguredProviders,
} from '@agnes/host-providers/assemble/provider-selection'
import {
  materializeRoutes,
  pinPresetRoutes,
  sweepAwsDestination,
  verifyRoutes,
} from '@agnes/host-providers/assemble/routes'
import type { RouteTable } from '@agnes/protocol'
import { limitChildModels } from './child-model-scope.js'
import type { AssemblyContext } from './context.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import { retainedModelView } from './retained-model.js'

/**
 * Step `provider` - route table first, environment second, credentials third. The route table,
 * provider and fingerprint are republished by `applyModelProfile`, so they are read through
 * accessors, never copied.
 */
export async function assembleProvider(
  ctx: AssemblyContext,
  proc: ProcessServices,
  presets: PresetCatalog,
  pluginTree: HostPluginTreeBase,
) {
  const { deps, rollback, clock, env, say, providerSelections } = ctx
  const { hotPolicy } = ctx.gates
  const { secrets } = proc
  // Validate explicit kind selections before fitting operation instances.
  selectConfiguredProviders(pluginTree.root, providerSelections)
  // 6 provider - route table first, environment second, credentials third.
  let routes: RouteTable | undefined
  const bootstrapView = (profile: ResolvedProfile) =>
    deps.retainedModelBootstrap
      ? retainedModelView(presets.defaultPreset.view, profile, pluginTree.root.modelAdapters.catalog())
      : presets.defaultPreset.view
  try {
    routes = materializeRoutes(
      bootstrapView(ctx.profile),
      ctx.profile,
      pluginTree.root.modelAdapters.catalog(),
    )
  } catch (error) {
    if (
      !(error instanceof HostError) ||
      error.detail?.reason !== 'no-routes' ||
      !(deps.allowUnresolvedProvider || process.env.AGNES_WORKER_KIND === 'session')
    )
      throw error
  }
  const swept = sweepAwsDestination(env, ctx.profile)
  say('provider.env_swept', { removed: swept.removed, set: Object.keys(swept.set) })
  const requestTraces = new RequestTraceStore(
    ctx.profile.dataDir,
    ctx.profile.name,
    undefined,
    Date.now,
    (sessionKey) => ({ generationId: deps.sessionGeneration?.(sessionKey) ?? null }),
  )
  rollback.push('request-traces', requestTraces.start())
  const factory = deps.providerFactory ? { providerFactory: deps.providerFactory } : {}
  let {
    provider,
    contractStore,
    preconfiguredRoutes,
    dispose: disposeProvider,
  } = routes
    ? await buildProvider(ctx.profile, routes, {
        secrets,
        clock,
        log: deps.log,
        trace: requestTraces,
        modelAdapters: pluginTree.root.modelAdapters,
        creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
        ...factory,
      })
    : unresolvedProviderAssembly()
  rollback.push('model-adapters', () => disposeProvider())
  const contractForModel = bindModelContracts(
    provider.registry?.models() ?? (ctx.profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
    contractStore,
  )
  // createProvider sealed the registry on its way out, so both of these are readable now and
  // neither would have been before: the fingerprint identifies a reading that can no longer move,
  // and a catalogue refresh after this point cannot change what it names.
  let providerFingerprint: string | null = null
  if (provider.registry && routes) {
    verifyRoutes(routes, provider.registry)
    providerFingerprint = provider.registry.fingerprint()
  }
  const models = modelRuntime({ provider, contractForModel, dispose: disposeProvider }, (error) => {
    say('provider.dispose_failed', { message: error instanceof Error ? error.message : String(error) })
  })
  disposeProvider = () => models.dispose()
  limitChildModels(
    models.provider,
    () => pluginTree.root.modelAdapters.catalog(),
    () => ctx.profile,
  )
  const applyModelProfile = async (next: ResolvedProfile): Promise<void> => {
    next = applyProviderSelections(next)
    const nextRoutes = next.provider.routes?.length
      ? materializeRoutes(bootstrapView(next), next, pluginTree.root.modelAdapters.catalog())
      : undefined
    const nextSecrets =
      next.adapters.secrets.kind === 'file'
        ? composeSecrets(
            createSecretsFile({
              dir: resolveFileSecretsDirectory({
                path: next.adapters.secrets.path,
                dataDir: next.dataDir,
              }),
            }),
            createSecretsEnv(),
          )
        : next.adapters.secrets.kind === 'env'
          ? createSecretsEnv()
          : undefined
    if (!nextSecrets) throw new HostError('E_SEAM_INIT', 'unsupported model credential store')
    const built = nextRoutes
      ? await buildProvider(next, nextRoutes, {
          secrets: (ref) => nextSecrets.resolve(ref),
          clock,
          log: deps.log,
          trace: requestTraces,
          modelAdapters: pluginTree.root.modelAdapters,
          creditsSnapshot: () => businessLimit(hotPolicy, 'cost.credits_per_usd'),
          ...factory,
        })
      : unresolvedProviderAssembly()
    let nextContracts: typeof contractForModel
    try {
      if (built.provider.registry && nextRoutes) verifyRoutes(nextRoutes, built.provider.registry)
      nextContracts = bindModelContracts(
        built.provider.registry?.models() ?? built.provider.models(),
        built.contractStore,
      )
    } catch (error) {
      await built.dispose().catch((cleanupError) => {
        say('provider.dispose_failed', { message: String(cleanupError) })
      })
      throw error
    }
    // Publish atomically; old requests keep their image until counting/inference finishes.
    models.publish({ provider: built.provider, contractForModel: nextContracts, dispose: built.dispose })
    provider = built.provider
    preconfiguredRoutes = built.preconfiguredRoutes
    routes = nextRoutes
    providerFingerprint = built.provider.registry?.fingerprint() ?? null
    ctx.profile = next
  }
  const named = routes ? Object.entries(routes).map(([k, v]) => [k, `${v.route}/${v.model}`]) : []
  // The credit rate goes on the audit row, null included. An assembly that priced nothing is the
  // one whose ledger reads in dollars, and that has to be legible afterwards from the record the
  // deployment keeps, not only from a warning on a log nobody kept.
  const creditsPerUsd =
    readCreditsPerUsd(ctx.profile, businessLimit(hotPolicy, 'cost.credits_per_usd')) ?? null
  say('provider.assembled', {
    routes: Object.fromEntries(named),
    fingerprint: providerFingerprint,
    creditsPerUsd,
    creditUnit: creditsPerUsd === null ? 'usd' : 'credit',
  })
  // The view the sessions run on carries the resolved route and model, not the sentinel: see
  // pinPresetRoutes for what core would otherwise record in request/header.
  const view = routes ? pinPresetRoutes(bootstrapView(ctx.profile), routes) : presets.defaultPreset.view
  return {
    models,
    view,
    applyModelProfile,
    get provider() {
      return provider
    },
    get providerFingerprint() {
      return providerFingerprint
    },
    get routes() {
      return routes
    },
    get preconfiguredRoutes() {
      return preconfiguredRoutes
    },
  }
}

export type ProviderStage = Awaited<ReturnType<typeof assembleProvider>>
