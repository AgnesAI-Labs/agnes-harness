import { basename, dirname } from 'node:path'
import type { ContractStore, ManualRoute, Registry } from '@agnes/ai'
import {
  API_KEY_CREDENTIAL_REFS,
  createApiKeyProviderAdapters,
  createProvider,
  getSubscriptionProvider,
  loadContractStore,
  NullContractStore,
  PARSER_VERSION,
  PiAdapter,
  subscriptionAuth,
} from '@agnes/ai'
// Provider is protocol-owned and reaches this file through core's re-export.
import type { Provider } from '@agnes/core'
import type { Logger } from '@agnes/extension-api'
import type { RouteTable } from '@agnes/protocol'
import { subscriptionCredentials } from '../adapters/codex-credentials.js'
import { createCredentialStore, isSubscriptionCredential } from '../adapters/credential-store.js'
import { HostError } from '../errors.js'
import type { ResolvedProfile } from '../profile/types.js'

/**
 * The profile limit that says what one credit is worth. `limits` is the deployment's own numeric
 * map - the same place `shutdown.grace_ms` and `lease.ttl_ms` are read from - so this is a key in an
 * existing field rather than a new one.
 */
export const CREDITS_PER_USD_LIMIT = 'cost.credits_per_usd'

/**
 * The deployment's credit rate, or `undefined` when it declared none. Absence is not an error: a
 * deployment that keeps no books does not have to price anything, and @agnes/ai says so on the log
 * once. A rate that is present but unusable is refused, because a zero or a NaN silently prices
 * every turn at nothing and a budget cap compared against it can never trip.
 */
export function readCreditsPerUsd(profile: ResolvedProfile, snapshot?: unknown): number | undefined {
  const raw = typeof snapshot === 'number' ? snapshot : profile.limits[CREDITS_PER_USD_LIMIT]
  if (raw === undefined) return undefined
  if (!Number.isFinite(raw) || raw <= 0)
    throw new HostError('E_API_RANGE', `limits.${CREDITS_PER_USD_LIMIT} must be a finite number above zero`, {
      detail: { limit: CREDITS_PER_USD_LIMIT, value: String(raw) },
    })
  return raw
}

/**
 * What host resolved for the model layer: the sink @agnes/ai's warnings go to, and the rate it
 * prices a turn at. A replacement provider is handed the same pair the built one gets, so a test
 * host and `AGNES_TEST_PROVIDER=faux` price the way a delivery does instead of defaulting on their
 * own - a double that is laxer than the delivered path passes cases the delivered path fails.
 */
/** Inference refuses until the profile declares provider.routes. Host assembly still proceeds so plugin apply can boot. */
export function unresolvedProviderAssembly(): Awaited<ReturnType<typeof buildProvider>> {
  return {
    provider: {
      // biome-ignore lint/correctness/useYield: fail-closed inference has no events
      async *infer() {
        throw new HostError('E_PRESET_UNRESOLVED', 'no-routes: the profile declares no provider.routes', {
          detail: { reason: 'no-routes' },
        })
      },
      models: () => [],
    },
    contractStore: new NullContractStore(),
    preconfiguredRoutes: [],
  }
}

export type ProviderBuildOptions = {
  log: Logger
  contractStore: ContractStore
  pricing?: { creditsPerUsd: number }
}

export async function buildProvider(
  profile: ResolvedProfile,
  routes: RouteTable,
  deps: {
    secrets: (ref: string) => string
    clock: () => number
    log: Logger
    providerFactory?: (p: ResolvedProfile, opts: ProviderBuildOptions) => Provider
    creditsSnapshot?: () => unknown
  },
): Promise<{
  provider: Provider & { registry?: Registry }
  contractStore: ContractStore
  /** Built-in API-key routes actually fitted during this assembly. */
  preconfiguredRoutes: readonly string[]
}> {
  // Read before the test-provider escape below, so an unusable rate is refused whatever serves the
  // model seam. A profile is configuration; it is wrong in the same way against either provider.
  const creditsPerUsd = () => readCreditsPerUsd(profile, deps.creditsSnapshot?.())
  const initialCredits = creditsPerUsd()
  // Both halves of the same wiring, resolved once and handed to whichever provider is built below.
  // Without `log` the warning ai raises when no rate is declared has no sink at all, and without
  // `pricing` the rate the deployment did declare never arrives - which leaves the ledger's credits
  // column denominated in dollars in every delivered assembly. A live getter lets the next pricing
  // invocation read a later business-limits snapshot without reassembling the provider.
  const built: ProviderBuildOptions = {
    log: deps.log,
    contractStore: profile.provider.contract
      ? loadContractStore(profile.provider.contract)
      : new NullContractStore(),
    ...(initialCredits !== undefined || deps.creditsSnapshot
      ? {
          pricing: {
            get creditsPerUsd() {
              return creditsPerUsd() as number
            },
          },
        }
      : {}),
  }
  // ERRATA B19: a test host, and AGNES_TEST_PROVIDER=faux, replace the whole model seam. Such a
  // provider has no registry, which is why the field is optional on the way out - and why the
  // caller cannot treat a missing registry as "verification passed".
  if (deps.providerFactory)
    return {
      provider: deps.providerFactory(profile, built),
      contractStore: built.contractStore,
      preconfiguredRoutes: [],
    }
  for (const id of profile.provider.adapters)
    if (id !== '@agnes/ai')
      throw new HostError('E_DEP_MISSING', `third-party wire adapter packages are v0.x: ${id}`, {
        detail: { reason: 'adapter-package', id },
      })
  const manualRoutes: ManualRoute[] = (profile.provider.routes ?? []).map((r) => ({
    ...r,
    models: r.models ?? [],
  }))
  // The first-run client has to be able to choose any reviewed API-key provider before it owns a
  // key for one.  Those routes are therefore fitted once, at Host assembly, and their credentials
  // may remain unbound until selected.  A profile-owned route keeps precedence if it deliberately
  // uses one of the same names: do not replace a deployment's endpoint/catalogue with the bundled
  // provider merely because their route labels happen to agree.
  const claimed = new Set(manualRoutes.map((route) => route.route))
  const oauthCandidates = manualRoutes.filter((route) => {
    const provider = route.credentialRef?.split('/')[2]
    return !!provider && !!getSubscriptionProvider(provider) && route.credentialRef?.includes('/account-')
  })
  // API-key accounts use the same reference names as subscription accounts.
  // Resolve the persisted credential kind instead of guessing from the provider ID.
  const secretPath = profile.adapters.secrets.path
  const managedStore =
    profile.adapters.secrets.kind === 'file' && secretPath && basename(secretPath) === 'secrets'
      ? createCredentialStore({ root: dirname(secretPath) })
      : undefined
  const oauthRoutes: ManualRoute[] = []
  for (const route of oauthCandidates) {
    const ref = route.credentialRef as string
    if (managedStore && isSubscriptionCredential(await managedStore.read(ref), ref.split('/')[2]))
      oauthRoutes.push(route)
  }
  const oauthNames = new Set(oauthRoutes.map((route) => route.route))
  const oauthAdapters = oauthRoutes.map((route) => {
    const providerId = route.credentialRef?.split('/')[2] ?? ''
    const entry = getSubscriptionProvider(providerId)
    const path = profile.adapters.secrets.path
    if (
      !entry ||
      route.baseUrl !== entry.baseUrl ||
      !entry.models().some((model) => model.api === route.api) ||
      !path ||
      profile.adapters.secrets.kind !== 'file' ||
      basename(path) !== 'secrets'
    )
      throw new HostError(
        'E_API_RANGE',
        'Subscription OAuth requires the managed store and official endpoint',
      )
    const auth = subscriptionAuth(
      entry.id,
      subscriptionCredentials(dirname(path), route.credentialRef as string, entry.id),
    )
    return new PiAdapter({
      id: `oauth-${route.route}`,
      providerId: entry.id,
      manualRoutes: [route],
      resolveCredential: (_route, signal) => auth.resolve(signal),
      recoverRejectedAuth: (_route, rejected, signal) => auth.recoverRejected(rejected, signal),
    })
  })
  const apiKeyAdapters = (await createApiKeyProviderAdapters()).filter((adapter) =>
    adapter
      .routes()
      .every(
        (route) =>
          !claimed.has(route.route) &&
          (profile.provider.catalog === undefined || profile.provider.catalog.include.includes(route.route)),
      ),
  )
  // Do not make a custom route optional just because it reused an API-key credential spelling.
  // `optionalCredentialRefs` is calculated from the adapters actually installed above, not from
  // the broader built-in set.
  const optionalCredentialRefs = new Set(
    [...API_KEY_CREDENTIAL_REFS].filter((ref) =>
      apiKeyAdapters.some((adapter) => adapter.routes().some((route) => route.credentialRef === ref)),
    ),
  )
  for (const route of oauthRoutes) optionalCredentialRefs.add(route.credentialRef as string)
  // createProvider seals the registry itself, after it binds credentials. Everything the seal
  // publishes - routes(), models(), fingerprint() - is readable only through the registry it
  // returns, so the returned object is passed on whole rather than narrowed to Provider.
  const provider = createProvider({
    adapters: [
      new PiAdapter({ manualRoutes: manualRoutes.filter((route) => !oauthNames.has(route.route)) }),
      ...apiKeyAdapters,
      ...oauthAdapters,
    ],
    routes,
    secrets: deps.secrets,
    clock: deps.clock,
    parserVersion: PARSER_VERSION,
    log: built.log,
    ...(built.pricing ? { pricing: built.pricing } : {}),
    contract: built.contractStore,
    optionalCredentialRefs,
  })
  return {
    provider,
    contractStore: built.contractStore,
    preconfiguredRoutes: Object.freeze(
      apiKeyAdapters.flatMap((adapter) => adapter.routes().map((route) => route.route)),
    ),
  }
}
