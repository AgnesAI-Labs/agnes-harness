/**
 * Projects locked provider bindings as ScopedDependencies.
 * One fixed Cordis assembly is the root. This module does not open a second
 * container. Host startup is the sole production construction site; release
 * publication uses the same controlled lifecycle.
 */
import type {
  BindingRef,
  BoundService,
  CallContext,
  Outcome,
  RuntimeError,
  ScopedDependencies,
  ServiceRequirement as WireRequirement,
} from '@agnes/extension-api/runtime'
import {
  type AssemblyPlan,
  type AssemblyProvider,
  AssemblyRefusal,
  type ServiceRequirement as AssemblyRequirement,
  type CloseResult,
  type DrainResult,
  FixedCordisAssembly,
  type GenerationView,
  isRuntimeScope,
  type RuntimeScope,
  scopeRank,
} from '@agnes/plugin-runtime/host'

const DIAGNOSTIC_ID = 'host-scoped-dependencies'

export type HostPermissionGrant = {
  readonly authorizationRef: string
  readonly ownerId: string
  readonly permissions: readonly string[]
  readonly scope: RuntimeScope
}

export type HostSelectedProvider = {
  readonly binding: BindingRef
  readonly major: number
  readonly scope: RuntimeScope
  readonly features: readonly string[]
  readonly packageDigest: string
  readonly ownerId: string
  readonly permissions: readonly string[]
  readonly capabilities?: readonly string[]
  readonly requires?: readonly AssemblyRequirement[]
  readonly contractDefinition?: AssemblyProvider['contractDefinition']
  readonly operations?: AssemblyProvider['operations']
  readonly owners?: AssemblyProvider['owners']
  readonly create?: AssemblyProvider['create']
  readonly ready?: AssemblyProvider['ready']
  readonly drain?: AssemblyProvider['drain']
  readonly close?: AssemblyProvider['close']
  readonly query?: BoundService['query']
  readonly compute?: BoundService['compute']
  readonly eventsOutbox?: NonNullable<BoundService['eventsOutbox']>
  readonly artifactAccess?: NonNullable<BoundService['artifactAccess']>
  readonly blobRead?: NonNullable<BoundService['blobRead']>
  readonly clientIngress?: NonNullable<BoundService['clientIngress']>
  readonly clientCommand?: NonNullable<BoundService['clientCommand']>
}

export type HostProviderPublication = {
  readonly generationId: string
  readonly providers: readonly HostSelectedProvider[]
  readonly brokerKeys?: readonly string[]
  readonly contracts?: AssemblyPlan['contracts']
  readonly contributions?: AssemblyPlan['contributions']
  readonly loopFeatures?: readonly string[]
}

export type HostScopedDependencies = {
  readonly dependencies: ScopedDependencies
  prepare(publication: HostProviderPublication, signal?: AbortSignal): Promise<GenerationView>
  activate(generationId: string): GenerationView
  pinRun(runId: string, generationId: string): void
  unpinRun(runId: string): void
  forRun(runId: string): Outcome<ScopedDependencies>
  forBinding(generationId: string, bindingId: string): Outcome<ScopedDependencies>
  publish(publication: HostProviderPublication): Promise<GenerationView>
  drain(generationId: string, deadline: number): Promise<DrainResult>
  close(generationId: string): Promise<CloseResult>
  disable(generationId: string): void
  view(generationId: string): GenerationView
}

type BrokerResource = { readonly key: string; start(): () => void }

type LockedService = {
  readonly binding: BindingRef
  readonly major: number
  readonly scope: RuntimeScope
  readonly features: readonly string[]
  readonly packageDigest: string
  readonly ownerId: string
  readonly permissions: readonly string[]
  readonly query?: BoundService['query']
  readonly compute?: BoundService['compute']
  readonly eventsOutbox?: NonNullable<BoundService['eventsOutbox']>
  readonly artifactAccess?: NonNullable<BoundService['artifactAccess']>
  readonly blobRead?: NonNullable<BoundService['blobRead']>
  readonly clientIngress?: NonNullable<BoundService['clientIngress']>
  readonly clientCommand?: NonNullable<BoundService['clientCommand']>
}

type Gate = { closed: boolean }

function failure(code: RuntimeError['code'], detailCode: string, message: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message,
      retryAdvice: { kind: 'never' },
      diagnosticId: DIAGNOSTIC_ID,
    },
  }
}

function copyGrant(grant: HostPermissionGrant): HostPermissionGrant {
  return Object.freeze({
    authorizationRef: grant.authorizationRef,
    ownerId: grant.ownerId,
    permissions: Object.freeze([...grant.permissions]),
    scope: grant.scope,
  })
}

function assertOwner(provider: HostSelectedProvider): void {
  if (provider.ownerId.length === 0 || provider.ownerId !== provider.binding.providerId) {
    throw new AssemblyRefusal('owner_missing', 'selected provider owner is missing', {
      providerId: provider.binding.providerId,
    })
  }
}

function toAssembly(provider: HostSelectedProvider): AssemblyProvider {
  return {
    providerId: provider.binding.providerId,
    contract: provider.binding.contract,
    major: provider.major,
    logicalName: provider.binding.logicalName,
    scope: provider.scope,
    features: [...provider.features],
    packageDigest: provider.packageDigest,
    capabilities: [...(provider.capabilities ?? [])],
    requires: (provider.requires ?? []).map((requirement) => ({
      ...requirement,
      features: [...requirement.features],
      ...(requirement.contractDefinition
        ? { contractDefinition: structuredClone(requirement.contractDefinition) }
        : {}),
    })),
    ...(provider.contractDefinition !== undefined
      ? { contractDefinition: structuredClone(provider.contractDefinition) }
      : {}),
    ...(provider.operations !== undefined ? { operations: structuredClone(provider.operations) } : {}),
    ...(provider.create !== undefined ? { create: provider.create } : {}),
    ...(provider.ready !== undefined ? { ready: provider.ready } : {}),
    ...(provider.drain !== undefined ? { drain: provider.drain } : {}),
    ...(provider.close !== undefined ? { close: provider.close } : {}),
    ...(provider.owners !== undefined ? { owners: provider.owners } : {}),
  }
}

function lockService(provider: HostSelectedProvider): LockedService {
  return Object.freeze({
    binding: Object.freeze({
      bindingId: provider.binding.bindingId,
      contract: provider.binding.contract,
      logicalName: provider.binding.logicalName,
      providerId: provider.binding.providerId,
    }),
    major: provider.major,
    scope: provider.scope,
    features: Object.freeze([...provider.features]),
    packageDigest: provider.packageDigest,
    ownerId: provider.ownerId,
    permissions: Object.freeze([...provider.permissions]),
    ...(provider.query !== undefined ? { query: provider.query } : {}),
    ...(provider.compute !== undefined ? { compute: provider.compute } : {}),
    ...(provider.eventsOutbox !== undefined ? { eventsOutbox: provider.eventsOutbox } : {}),
    ...(provider.artifactAccess !== undefined ? { artifactAccess: provider.artifactAccess } : {}),
    ...(provider.blobRead !== undefined ? { blobRead: provider.blobRead } : {}),
    ...(provider.clientIngress !== undefined ? { clientIngress: provider.clientIngress } : {}),
    ...(provider.clientCommand !== undefined ? { clientCommand: provider.clientCommand } : {}),
  })
}

function sameIdentity(entry: LockedService, requirement: WireRequirement): boolean {
  return (
    entry.binding.contract === requirement.contract &&
    entry.major === requirement.major &&
    entry.binding.logicalName === requirement.logicalName &&
    entry.scope === requirement.scope
  )
}

function coversFeatures(entry: LockedService, requirement: WireRequirement): boolean {
  return requirement.features.every((feature) => entry.features.includes(feature))
}

function parseContext(value: unknown): Outcome<CallContext> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failure('denied', 'permission_absent', 'call context is not trusted')
  }
  const context = value as Partial<CallContext>
  const scope = context.scope
  if (
    typeof context.authorizationRef !== 'string' ||
    context.authorizationRef.length === 0 ||
    typeof scope !== 'object' ||
    scope === null ||
    !isRuntimeScope(scope.kind) ||
    !(context.signal instanceof AbortSignal)
  ) {
    return failure('denied', 'permission_absent', 'call context is not trusted')
  }
  return { ok: true, value: value as CallContext }
}

function project(
  entry: LockedService,
  generationId: string,
  publishedId: () => string | undefined,
  rootClosed: () => boolean,
  viewOf: (generationId: string) => GenerationView,
  grants: readonly HostPermissionGrant[],
  pinned = false,
): BoundService {
  const unavailable = (method: string) =>
    failure('internal', 'method_unavailable', `${method} is not registered`)
  const authorize = (context: unknown): Outcome<true> => {
    const parsed = parseContext(context)
    if (!parsed.ok) return parsed
    const caller = parsed.value.scope.kind
    if (!isRuntimeScope(caller)) return failure('denied', 'permission_absent', 'call context is not trusted')
    const matches = grants.filter((grant) => grant.authorizationRef === parsed.value.authorizationRef)
    if (matches.length === 0) {
      return failure('denied', 'permission_absent', 'caller is not permitted for this service')
    }
    const owned = matches.filter((grant) => grant.ownerId === entry.ownerId)
    if (owned.length === 0)
      return failure('denied', 'owner_absent', 'service owner does not match the caller')
    const allowed = owned.some(
      (grant) =>
        scopeRank(caller) >= scopeRank(grant.scope) &&
        scopeRank(caller) <= scopeRank(entry.scope) &&
        entry.permissions.every((permission) => grant.permissions.includes(permission)),
    )
    if (!allowed) return failure('denied', 'permission_absent', 'caller is not permitted for this service')
    return { ok: true, value: true }
  }
  const live = (): Outcome<never> | undefined => {
    if (rootClosed() || (!pinned && publishedId() !== generationId)) {
      return failure('denied', 'service_container_closed', 'container is closed')
    }
    const view = viewOf(generationId)
    if ((!pinned && view.disabled) || view.state !== 'ready') {
      return failure('denied', 'closed', 'generation is not accepting work')
    }
    return undefined
  }
  const guard = (context: unknown): Outcome<true> | undefined => {
    const parsed = parseContext(context)
    if (!parsed.ok) return parsed
    const blocked = live()
    if (blocked !== undefined) return blocked
    if (pinned && parsed.value.bindingId !== entry.binding.bindingId)
      return failure('denied', 'binding_mismatch', 'call does not match the pinned binding')
    return authorize(context)
  }
  return {
    binding: entry.binding,
    async query(request, context) {
      const blocked = guard(context)
      if (blocked !== undefined && !blocked.ok) return blocked
      const query = entry.query
      if (query === undefined) return unavailable('query')
      return query(request, context)
    },
    async compute(request, context) {
      const blocked = guard(context)
      if (blocked !== undefined && !blocked.ok) return blocked
      const compute = entry.compute
      if (compute === undefined) return unavailable('compute')
      return compute(request, context)
    },
    ...(entry.eventsOutbox !== undefined ? { eventsOutbox: entry.eventsOutbox } : {}),
    ...(entry.artifactAccess !== undefined ? { artifactAccess: entry.artifactAccess } : {}),
    ...(entry.blobRead !== undefined ? { blobRead: entry.blobRead } : {}),
    ...(entry.clientIngress !== undefined ? { clientIngress: entry.clientIngress } : {}),
    ...(entry.clientCommand !== undefined ? { clientCommand: entry.clientCommand } : {}),
  }
}

export function createHostScopedDependencies(
  grants: readonly HostPermissionGrant[],
  resources: readonly BrokerResource[] = [],
): HostScopedDependencies {
  const assembly = new FixedCordisAssembly(resources)
  const lockedGrants = Object.freeze(grants.map(copyGrant))
  let current: readonly LockedService[] = []
  let publishedId: string | undefined
  const root: Gate = { closed: false }

  const generations = new Map<string, readonly LockedService[]>()
  const activated = new Set<string>()
  const runs = new Map<string, string>()
  const dependencies = createView(root, null)
  const host: HostScopedDependencies = {
    dependencies,
    async prepare(publication, signal) {
      const services = publication.providers.map(lockService)
      for (const provider of publication.providers) assertOwner(provider)
      const loops = publication.providers.filter((provider) => provider.binding.contract === 'agh.loop')
      const loopFeatures = loops[0]?.features ?? []
      if (loops.length > 1 && (publication.contributions?.length ?? 0) > 0)
        throw new AssemblyRefusal('loop_selection_ambiguous', 'effective hooks require one selected Loop')
      if (
        publication.loopFeatures &&
        JSON.stringify([...publication.loopFeatures].sort()) !== JSON.stringify([...loopFeatures].sort())
      )
        throw new AssemblyRefusal('loop_feature_mismatch', 'Loop features must match the selected provider')
      const plan: AssemblyPlan = {
        generationId: publication.generationId,
        providers: publication.providers.map(toAssembly),
        loopFeatures: [...loopFeatures],
        ...(publication.contracts ? { contracts: structuredClone(publication.contracts) } : {}),
        ...(publication.contributions
          ? {
              contributions: publication.contributions.map((row) => ({
                ...row,
                ...(row.operations ? { operations: structuredClone(row.operations) } : {}),
                ...(row.tools ? { tools: structuredClone(row.tools) } : {}),
                ...(row.hooks ? { hooks: structuredClone(row.hooks) } : {}),
                ...(row.requiredCapabilities ? { requiredCapabilities: [...row.requiredCapabilities] } : {}),
              })),
            }
          : {}),
        ...(publication.brokerKeys !== undefined ? { brokerKeys: [...publication.brokerKeys] } : {}),
      }
      const view = await assembly.prepare(plan, signal)
      generations.set(plan.generationId, services)
      return view
    },
    activate(generationId) {
      const services = generations.get(generationId)
      if (!services) throw new AssemblyRefusal('unknown_generation', 'generation has no Host bindings')
      const view = assembly.activate(generationId)
      activated.add(generationId)
      current = services
      publishedId = generationId
      root.closed = false
      return view
    },
    async publish(publication) {
      const generationId = publication.generationId
      await host.prepare(publication)
      return host.activate(generationId)
    },
    pinRun(runId, generationId) {
      const previous = runs.get(runId)
      if (previous && previous !== generationId)
        throw new AssemblyRefusal('run_binding_conflict', 'an existing run keeps its generation')
      if (!activated.has(generationId))
        throw new AssemblyRefusal('unpublished', 'a staged generation cannot accept a run')
      if (previous === generationId) return
      assembly.pinRun(runId, generationId)
      runs.set(runId, generationId)
    },
    unpinRun(runId) {
      runs.delete(runId)
      assembly.unpinRun(runId)
    },
    forRun(runId) {
      const generationId = runs.get(runId)
      if (!generationId) return failure('conflict', 'run_not_pinned', 'run has no in-memory binding')
      return { ok: true, value: createView({ closed: false }, null, { generationId, runId }) }
    },
    forBinding(generationId, bindingId) {
      if (
        !activated.has(generationId) ||
        !generations.get(generationId)?.some((row) => row.binding.bindingId === bindingId)
      )
        return failure('incompatible', 'binding_not_registered', 'binding is not in an activated generation')
      return { ok: true, value: createView({ closed: false }, null, { generationId, bindingId }) }
    },
    drain(generationId, deadline) {
      return assembly.drain(generationId, deadline)
    },
    async close(generationId) {
      const result = await assembly.close(generationId)
      if (generationId === publishedId) {
        publishedId = undefined
        current = []
        root.closed = true
      }
      return result
    },
    disable(generationId) {
      assembly.disable(generationId)
    },
    view(generationId) {
      return assembly.view(generationId)
    },
  }
  return host

  function createView(
    local: Gate,
    limit: RuntimeScope | null,
    pinned?: { generationId: string; bindingId?: string; runId?: string },
  ): ScopedDependencies {
    const blocked = (): Outcome<never> | undefined => {
      if (
        (!pinned && root.closed) ||
        local.closed ||
        (pinned?.runId !== undefined && runs.get(pinned.runId) !== pinned.generationId)
      ) {
        return failure('denied', 'service_container_closed', 'container is closed')
      }
      const id = pinned?.generationId ?? publishedId
      if (id === undefined) return undefined
      const view = assembly.view(id)
      if ((!pinned && view.disabled) || view.state !== 'ready') {
        return failure('denied', 'closed', 'generation is not accepting work')
      }
      return undefined
    }
    return {
      get(requirement) {
        const refusal = blocked()
        if (refusal !== undefined) return refusal
        if (limit !== null && requirement.scope !== limit) {
          return failure(
            'incompatible',
            'service_scope_mismatch',
            'requirement scope is outside the open scope',
          )
        }
        const entries = pinned ? (generations.get(pinned.generationId) ?? []) : current
        const identities = entries.filter(
          (entry) =>
            sameIdentity(entry, requirement) &&
            (pinned?.bindingId === undefined || entry.binding.bindingId === pinned.bindingId),
        )
        if (identities.length === 0) {
          return failure('incompatible', 'service_not_registered', 'service is not registered')
        }
        const matches = identities.filter((entry) => coversFeatures(entry, requirement))
        if (matches.length > 1)
          return failure('conflict', 'service_ambiguous', 'more than one service matches')
        const match = matches[0]
        if (match === undefined) {
          return failure('incompatible', 'feature_missing', 'service is missing a requested feature')
        }
        const generationId = pinned?.generationId ?? publishedId
        if (generationId === undefined) {
          return failure('incompatible', 'service_not_registered', 'service is not registered')
        }
        return {
          ok: true,
          value: project(
            match,
            generationId,
            () => publishedId,
            () =>
              local.closed ||
              (!pinned && root.closed) ||
              (pinned?.runId !== undefined && runs.get(pinned.runId) !== pinned.generationId),
            (id) => assembly.view(id),
            lockedGrants,
            pinned !== undefined,
          ),
        }
      },
      async openScope(scope, context) {
        const parsed = parseContext(context)
        if (!parsed.ok) return parsed
        const refusal = blocked()
        if (refusal !== undefined) return refusal
        if (!isRuntimeScope(scope.kind)) {
          return failure('denied', 'permission_absent', 'call context is not trusted')
        }
        const caller = parsed.value.scope.kind
        if (!isRuntimeScope(caller))
          return failure('denied', 'permission_absent', 'call context is not trusted')
        const permitted = lockedGrants.some(
          (grant) =>
            grant.authorizationRef === parsed.value.authorizationRef &&
            scopeRank(caller) >= scopeRank(grant.scope),
        )
        if (!permitted || scopeRank(scope.kind) < scopeRank(caller)) {
          return failure('denied', 'permission_absent', 'caller is not permitted for this service')
        }
        return { ok: true, value: createView({ closed: false }, scope.kind, pinned) }
      },
      async close() {
        local.closed = true
      },
    }
  }
}
