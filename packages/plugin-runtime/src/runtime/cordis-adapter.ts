import { Context, type Fiber } from '@agnes/cordis'
import { detectDependencyCycle, missingDependencies } from '../dependency-graph.js'
import { AssemblyRefusal } from './assembly-refusal.js'
import {
  assertCommunityContracts,
  type CommunityContractDefinition,
  type CommunityContractRef,
  type CommunityOperation,
  isCommunityContractName,
} from './community-contract.js'
import { isRuntimeScope, longScopeCapturesShort, type RuntimeScope, scopeRank } from './scope-tree.js'

export { AssemblyRefusal } from './assembly-refusal.js'

const DIGEST = /^[a-f0-9]{64}$/u

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
const LOOP_FEATURES = Object.freeze({
  before_step: 'loop-hook:before_step',
  turn_stopping: 'loop-hook:turn_stopping',
} as const)

/** Public hook defaults. The acceptance script checks this against the generated hook table. */
export const PUBLIC_HOOK_EVENTS = Object.freeze({
  session_start: Object.freeze({
    mode: 'parallel',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 500,
    replayOnResume: true,
  }),
  resources_discover: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'open',
    timeoutMs: 1000,
    replayOnResume: true,
  }),
  before_step: Object.freeze({
    mode: 'serial',
    category: 'directive',
    failPolicy: 'closed',
    timeoutMs: 1000,
    replayOnResume: false,
  }),
  context: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'closed',
    timeoutMs: 1500,
    replayOnResume: false,
  }),
  before_request: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'closed',
    timeoutMs: 1500,
    replayOnResume: false,
  }),
  request_error: Object.freeze({
    mode: 'parallel',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 500,
    replayOnResume: false,
  }),
  tool_call: Object.freeze({
    mode: 'serial',
    category: 'directive',
    failPolicy: 'closed',
    timeoutMs: 2000,
    replayOnResume: false,
  }),
  tool_result: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'open',
    timeoutMs: 2000,
    replayOnResume: false,
  }),
  turn_stopping: Object.freeze({
    mode: 'serial',
    category: 'directive',
    failPolicy: 'open',
    timeoutMs: 1000,
    replayOnResume: false,
  }),
  approval_request: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'closed',
    timeoutMs: 1000,
    replayOnResume: false,
  }),
  before_compact: Object.freeze({
    mode: 'waterfall',
    category: 'transform',
    failPolicy: 'closed',
    timeoutMs: 3000,
    replayOnResume: false,
  }),
  compact: Object.freeze({
    mode: 'parallel',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 1000,
    replayOnResume: false,
  }),
  subagent_start: Object.freeze({
    mode: 'emit',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 200,
    replayOnResume: false,
  }),
  subagent_end: Object.freeze({
    mode: 'emit',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 200,
    replayOnResume: false,
  }),
  format_deviation: Object.freeze({
    mode: 'parallel',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 500,
    replayOnResume: false,
  }),
  shutdown: Object.freeze({
    mode: 'parallel',
    category: 'observe',
    failPolicy: 'open',
    timeoutMs: 1000,
    replayOnResume: false,
  }),
} as const)

export type PublicHookEvent = keyof typeof PUBLIC_HOOK_EVENTS
export type HookFailPolicy = 'open' | 'closed'

export const TOOL_CONTROL_METHODS = Object.freeze(['admission', 'receipt', 'cancel'] as const)
export const OBSERVER_LOG_LIMIT = 256
export const OBSERVER_LOG_COUNT = 8
export const HOOKS_RUNNER_ROW_ID = 'ext:agnes/hooks-runner'
export const HOOKS_RUNNER_EVENTS = Object.freeze([
  'session_start',
  'shutdown',
  'before_step',
  'context',
  'tool_call',
  'tool_result',
  'turn_stopping',
  'subagent_start',
  'subagent_end',
  'before_compact',
  'compact',
  'approval_request',
] as const)

export type ServiceRequirement = {
  readonly contract: string
  readonly major: number
  readonly logicalName: string
  readonly scope: RuntimeScope
  readonly features: readonly string[]
  readonly optional: boolean
  readonly capture: 'instance' | 'factory'
  readonly contractDefinition?: CommunityContractRef
}

export type ResourceOwner = {
  readonly id: string
  release(): void | Promise<void>
}

export type AuthorizedPorts = {
  readonly generationId: string
  readonly providerId: string
  get(requirement: Pick<ServiceRequirement, 'contract' | 'logicalName' | 'scope'>): unknown
}

export type AssemblyProvider = {
  readonly providerId: string
  readonly contract: string
  readonly major: number
  readonly logicalName: string
  readonly scope: RuntimeScope
  readonly features: readonly string[]
  readonly packageDigest: string
  readonly capabilities: readonly string[]
  readonly requires: readonly ServiceRequirement[]
  readonly owners?: readonly ResourceOwner[]
  readonly contractDefinition?: CommunityContractRef
  readonly operations?: readonly CommunityOperation[]
  create?(ports: AuthorizedPorts): void | Promise<void>
  ready?(ports: AuthorizedPorts): void | Promise<void>
  drain?(ports: AuthorizedPorts): void | Promise<void>
  close?(ports: AuthorizedPorts): void | Promise<void>
  token?(): string
}

export type LegacyHookInput = {
  readonly event: PublicHookEvent
  readonly bound?: boolean
  readonly mandatory?: boolean
  readonly failPolicy?: HookFailPolicy
}

export type LegacyContributionInput = {
  readonly providerId: string
  readonly source: 'legacy-apply' | 'author'
  readonly operations?: readonly { readonly method: string; readonly kind: 'query' | 'action' | 'control' }[]
  readonly tools?: readonly { readonly name: string }[]
  readonly hooks?: readonly LegacyHookInput[]
  readonly requiredCapabilities?: readonly string[]
  apply?(ports: AuthorizedPorts): void | Promise<void>
}

export type NormalizedHook = {
  readonly event: PublicHookEvent
  readonly bound: boolean
  readonly mandatory: boolean
  readonly failPolicy: HookFailPolicy
}

export type NormalizedLegacy = {
  readonly providerId: string
  readonly source: 'legacy-apply' | 'author'
  readonly operations: readonly { readonly method: string; readonly kind: 'query' | 'action' | 'control' }[]
  readonly hooks: readonly NormalizedHook[]
  readonly controlMethods: readonly string[]
  readonly requiredCapabilities: readonly string[]
  apply?(ports: AuthorizedPorts): void | Promise<void>
}

export type HookDiagnostic = { readonly code: 'loop_feature_absent'; readonly event: PublicHookEvent }

export type ObserverContext = {
  readonly signal: AbortSignal
  log(message: string): void
}

export type ObserverMount = {
  readonly id: string
  readonly scope: RuntimeScope
  readonly event: { readonly typeId: string; readonly schemaTypeId: string }
  readonly owners?: readonly ResourceOwner[]
  handle(
    notification: { readonly eventId: string; readonly data: unknown },
    context: ObserverContext,
  ): void | Promise<void>
}

export type ObserverDelivery = {
  readonly typeId: string
  readonly scope: RuntimeScope
  readonly eventId: string
  readonly data: unknown
  readonly signal?: AbortSignal
}

export type ObserverResult = {
  readonly status: 'completed' | 'cancelled' | 'refused' | 'closed'
  readonly logs: readonly string[]
  readonly acceptedEffects: readonly never[]
}

export type AssemblyPlan = {
  readonly generationId: string
  readonly providers: readonly AssemblyProvider[]
  readonly loopFeatures?: readonly string[]
  readonly contributions?: readonly LegacyContributionInput[]
  readonly observers?: readonly ObserverMount[]
  readonly renderers?: readonly { readonly id: string }[]
  readonly brokerKeys?: readonly string[]
  readonly contracts?: readonly CommunityContractDefinition[]
}

export type GenerationView = {
  readonly generationId: string
  readonly state: 'ready' | 'draining' | 'closed' | 'cold' | 'residual'
  readonly published: boolean
  readonly bindings: readonly {
    readonly providerId: string
    readonly packageDigest: string
    readonly contract: string
  }[]
  readonly diagnostics: readonly HookDiagnostic[]
  readonly installedHooks: readonly string[]
  readonly residualOwnerIds: readonly string[]
  readonly clientOnlyIds: readonly string[]
  readonly controlMethods: readonly string[]
  readonly unknownActionIds: readonly string[]
  readonly resentActionIds: readonly string[]
  readonly disabled: boolean
}

export type DrainResult = {
  readonly state: 'drained' | 'blocked'
  readonly activeInvocationIds: readonly string[]
  readonly residualOwnerIds: readonly string[]
  readonly repeated: boolean
}

export type CloseResult = {
  readonly repeated: boolean
  readonly forced: boolean
  readonly drained: boolean
  readonly activeInvocationIds: readonly string[]
  readonly residualOwnerIds: readonly string[]
  readonly resentActionIds: readonly string[]
}

export type HooksRunnerReport = { readonly event: string; readonly unsupportedFields: readonly string[] }

export type HooksRunnerAttachment = {
  readonly rowId: string
  readonly events: readonly string[]
  readonly mappingReports?: readonly HooksRunnerReport[]
}

export type HooksRunnerStatus = {
  readonly mode: 'builtin' | 'takeover'
  readonly rowId: string
  readonly rank: number
  readonly events: readonly string[]
  readonly execution: 'delegated'
  readonly mappingReports: readonly HooksRunnerReport[]
}

type LockedProvider = {
  readonly provider: AssemblyProvider
  readonly providerId: string
  readonly packageDigest: string
  readonly contract: string
  readonly major: number
  readonly logicalName: string
  readonly scope: RuntimeScope
  readonly cell: string
  readonly serviceName: string
}

type TrackedOwner = {
  readonly id: string
  readonly release: () => void | Promise<void>
  attempted: boolean
  residual: boolean
}

type Mounted = {
  readonly locked: LockedProvider
  fiber: Fiber | undefined
  ports: AuthorizedPorts | undefined
  owners: TrackedOwner[]
  readied: boolean
}

type MountedObserver = {
  readonly mount: ObserverMount
  readonly owners: TrackedOwner[]
}

type Generation = {
  readonly id: string
  readonly locked: readonly LockedProvider[]
  readonly brokerKeys: readonly string[]
  readonly contributions: readonly NormalizedLegacy[]
  readonly observers: MountedObserver[]
  readonly clientOnlyIds: readonly string[]
  readonly controlMethods: readonly string[]
  readonly diagnostics: readonly HookDiagnostic[]
  readonly installedHooks: readonly string[]
  readonly unknownActionIds: Set<string>
  state: GenerationView['state']
  context: Context | undefined
  instances: Mounted[]
  controller: AbortController
  invocations: Set<string>
  idleWaiters: (() => void)[]
  closeStarted: boolean
  drained: boolean
  forced: boolean
  disabled: boolean
  byProvider: Map<string, Mounted>
  byCell: Map<string, LockedProvider>
}

type LiveResource = {
  readonly start: () => () => void
  stop: (() => void) | undefined
  readonly holders: Set<string>
  starts: number
  running: boolean
}

function cellOf(input: Pick<ServiceRequirement, 'scope' | 'contract' | 'major' | 'logicalName'>): string {
  return `${input.scope}\u0000${input.contract}\u0000${input.major}\u0000${input.logicalName}`
}

function isContainerContract(contract: string): boolean {
  return (
    contract === 'agh.container' ||
    contract.startsWith('agh.container.') ||
    contract.startsWith('agh.container/')
  )
}

function freezeReports(reports: readonly HooksRunnerReport[] | undefined): readonly HooksRunnerReport[] {
  return Object.freeze(
    (reports ?? []).map((report) =>
      Object.freeze({
        event: report.event,
        unsupportedFields: Object.freeze([...report.unsupportedFields]),
      }),
    ),
  )
}

export function normalizeLegacyContribution(input: LegacyContributionInput): NormalizedLegacy {
  if ('runtimeInternals' in input) {
    throw new AssemblyRefusal('author_runtime_list', 'tool authors do not maintain the runtime control list')
  }
  const operations = [...(input.operations ?? [])]
  for (const tool of input.tools ?? []) {
    operations.push({ method: tool.name, kind: 'action' })
  }
  for (const method of TOOL_CONTROL_METHODS) {
    if (!operations.some((operation) => operation.method === method)) {
      operations.push({ method, kind: 'control' })
    }
  }
  const hooks = (input.hooks ?? []).map((hook) => {
    const event = PUBLIC_HOOK_EVENTS[hook.event]
    if (!event) throw new AssemblyRefusal('unknown_hook', `unknown hook event: ${hook.event}`)
    if (event.failPolicy === 'closed' && hook.failPolicy === 'open') {
      throw new AssemblyRefusal('policy_widened', `hook ${hook.event} cannot widen a closed failure policy`, {
        event: hook.event,
      })
    }
    const failPolicy = hook.failPolicy ?? event.failPolicy
    const mandatory = hook.mandatory ?? failPolicy === 'closed'
    if (mandatory && failPolicy !== 'closed') {
      throw new AssemblyRefusal(
        'policy_widened',
        `mandatory hook ${hook.event} requires a closed failure policy`,
        {
          event: hook.event,
        },
      )
    }
    return Object.freeze({
      event: hook.event,
      bound: hook.bound ?? true,
      mandatory,
      failPolicy,
    })
  })
  const normalized: NormalizedLegacy = {
    providerId: input.providerId,
    source: input.source,
    operations: Object.freeze(operations),
    hooks: Object.freeze(hooks),
    controlMethods: TOOL_CONTROL_METHODS,
    requiredCapabilities: Object.freeze([...(input.requiredCapabilities ?? [])]),
  }
  if (input.apply) return { ...normalized, apply: input.apply }
  return normalized
}

export function admitLoopHooks(
  hooks: readonly NormalizedHook[],
  loopFeatures: readonly string[],
): { readonly installed: readonly string[]; readonly diagnostics: readonly HookDiagnostic[] } {
  const installed: string[] = []
  const diagnostics: HookDiagnostic[] = []
  const features = new Set(loopFeatures)
  for (const hook of hooks) {
    if (!hook.bound) continue
    const feature = LOOP_FEATURES[hook.event as keyof typeof LOOP_FEATURES]
    if (feature && !features.has(feature)) {
      if (hook.mandatory || hook.failPolicy === 'closed') {
        throw new AssemblyRefusal('feature_missing', `selected loop does not provide ${feature}`, {
          event: hook.event,
          feature,
        })
      }
      diagnostics.push(Object.freeze({ code: 'loop_feature_absent', event: hook.event }))
      continue
    }
    installed.push(hook.event)
  }
  return { installed: Object.freeze(installed), diagnostics: Object.freeze(diagnostics) }
}

function sameEvents(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(left)
  return right.every((event) => seen.has(event))
}

function track(owners: readonly ResourceOwner[] | undefined): TrackedOwner[] {
  return (owners ?? []).map((owner) => ({
    id: owner.id,
    release: () => owner.release(),
    attempted: false,
    residual: false,
  }))
}

export class SharedResourceBroker {
  readonly #catalog: ReadonlyMap<string, () => () => void>
  readonly #live = new Map<string, LiveResource>()

  constructor(resources: readonly { readonly key: string; start(): () => void }[]) {
    this.#catalog = new Map(resources.map((resource) => [resource.key, resource.start]))
  }

  known(key: string): boolean {
    return this.#catalog.has(key)
  }

  hold(generationId: string, key: string): void {
    const start = this.#catalog.get(key)
    if (!start) throw new AssemblyRefusal('unknown_resource', `unknown broker resource: ${key}`, { key })
    let live = this.#live.get(key)
    if (!live?.running) {
      const stop = start()
      live = { start, stop, holders: new Set(), starts: (live?.starts ?? 0) + 1, running: true }
      this.#live.set(key, live)
    }
    live.holders.add(generationId)
  }

  release(generationId: string, key: string): void {
    const live = this.#live.get(key)
    if (!live?.holders.delete(generationId) || live.holders.size > 0 || !live.running) return
    live.running = false
    const stop = live.stop
    live.stop = undefined
    stop?.()
  }

  releaseGeneration(generationId: string, keys: readonly string[]): void {
    for (const key of keys) this.release(generationId, key)
  }

  running(key: string): boolean {
    return this.#live.get(key)?.running === true
  }

  starts(key: string): number {
    return this.#live.get(key)?.starts ?? 0
  }
}

export class FixedCordisAssembly {
  readonly #broker: SharedResourceBroker
  readonly #generations = new Map<string, Generation>()
  readonly #runs = new Map<string, string>()
  readonly #hooksRank: number
  #published: Generation | undefined
  #hooksMode: HooksRunnerStatus['mode'] = 'builtin'
  #hooksReports: readonly HooksRunnerReport[] = Object.freeze([])

  constructor(
    resources: readonly { readonly key: string; start(): () => void }[] = [],
    options: { readonly hooksRunnerRank?: number } = {},
  ) {
    this.#broker = new SharedResourceBroker(resources)
    this.#hooksRank = options.hooksRunnerRank ?? 0
  }

  async open(plan: AssemblyPlan): Promise<GenerationView> {
    this.#rejectContainer(plan)
    if (this.#generations.has(plan.generationId)) {
      throw new AssemblyRefusal('duplicate_generation', `generation already exists: ${plan.generationId}`)
    }
    const locked = this.#validateProviders(plan.providers)
    const contributions = (plan.contributions ?? []).map((input) => normalizeLegacyContribution(input))
    for (const contribution of contributions) {
      const provider = plan.providers.find((item) => item.providerId === contribution.providerId)
      if (!provider) {
        throw new AssemblyRefusal(
          'missing_dependency',
          `legacy contribution has no provider: ${contribution.providerId}`,
        )
      }
      for (const capability of contribution.requiredCapabilities) {
        if (!provider.capabilities.includes(capability)) {
          throw new AssemblyRefusal(
            'capability_undeclared',
            `required capability is not declared: ${capability}`,
            {
              capability,
              providerId: provider.providerId,
            },
          )
        }
      }
    }
    const admission = admitLoopHooks(
      contributions.flatMap((contribution) => contribution.hooks),
      plan.loopFeatures ?? [],
    )
    for (const observer of plan.observers ?? []) {
      if (!isRuntimeScope(observer.scope))
        throw new AssemblyRefusal('invalid_provider', 'unknown observer scope')
      if (observer.event.typeId !== observer.event.schemaTypeId) {
        throw new AssemblyRefusal('schema_mismatch', 'observer event schema does not match its type', {
          observerId: observer.id,
        })
      }
    }
    const brokerKeys = Object.freeze([...(plan.brokerKeys ?? [])])
    for (const key of brokerKeys) {
      if (!this.#broker.known(key))
        throw new AssemblyRefusal('unknown_resource', `unknown broker resource: ${key}`, { key })
    }
    assertCommunityContracts(plan.contracts ?? [], plan.providers)
    const generation = this.#createGeneration(plan, locked, contributions, admission, brokerKeys)
    this.#generations.set(generation.id, generation)
    try {
      await this.#mount(generation)
      await this.#ready(generation)
      for (const key of generation.brokerKeys) this.#broker.hold(generation.id, key)
    } catch (error) {
      this.#broker.releaseGeneration(generation.id, generation.brokerKeys)
      await this.#rollback(generation)
      generation.state =
        generation.instances.some((instance) => instance.owners.some((owner) => owner.residual)) ||
        generation.observers.some((observer) => observer.owners.some((owner) => owner.residual))
          ? 'residual'
          : 'closed'
      throw error
    }
    generation.state = 'ready'
    this.#published = generation
    return this.view(generation.id)
  }

  view(generationId: string): GenerationView {
    const generation = this.#require(generationId)
    return Object.freeze({
      generationId: generation.id,
      state: generation.state,
      published: this.#published === generation && generation.state === 'ready',
      bindings: Object.freeze(
        generation.locked.map((item) =>
          Object.freeze({
            providerId: item.providerId,
            packageDigest: item.packageDigest,
            contract: item.contract,
          }),
        ),
      ),
      diagnostics: generation.diagnostics,
      installedHooks: generation.installedHooks,
      residualOwnerIds: Object.freeze(this.#residualIds(generation)),
      clientOnlyIds: generation.clientOnlyIds,
      controlMethods: generation.controlMethods,
      unknownActionIds: Object.freeze([...generation.unknownActionIds]),
      resentActionIds: Object.freeze([]),
      disabled: generation.disabled,
    })
  }

  disable(generationId: string): void {
    const generation = this.#require(generationId)
    if (generation.state !== 'ready') {
      throw new AssemblyRefusal('closed', 'only a ready generation can be disabled', { generationId })
    }
    generation.disabled = true
  }

  pinRun(runId: string, generationId?: string): void {
    const id = generationId ?? this.#published?.id
    if (!id) throw new AssemblyRefusal('unpublished', 'no published generation')
    const generation = this.#require(id)
    if (generation.state !== 'ready')
      throw new AssemblyRefusal('closed', 'run cannot pin a generation that is not ready')
    if (generation.disabled) {
      throw new AssemblyRefusal('disabled', 'a disabled generation cannot accept a new binding', {
        generationId: id,
      })
    }
    this.#runs.set(runId, id)
  }

  unpinRun(runId: string): void {
    this.#runs.delete(runId)
  }

  invoke(runId: string, providerId: string): { generationId: string; packageDigest: string; token: string } {
    const pinned = this.#runs.get(runId)
    const id = pinned ?? this.#published?.id
    if (!id) throw new AssemblyRefusal('unpublished', 'no generation for this run')
    const generation = this.#require(id)
    if (!pinned && generation.disabled) {
      throw new AssemblyRefusal('disabled', 'a disabled generation cannot accept a new binding', {
        generationId: id,
      })
    }
    if (generation.state !== 'ready')
      throw new AssemblyRefusal('closed', 'generation is not accepting work', { generationId: id })
    const mounted = generation.byProvider.get(providerId)
    if (!mounted)
      throw new AssemblyRefusal('missing_dependency', `provider is not in this generation: ${providerId}`)
    return {
      generationId: generation.id,
      packageDigest: mounted.locked.packageDigest,
      token: mounted.locked.provider.token?.() ?? mounted.locked.providerId,
    }
  }

  beginInvocation(generationId: string, invocationId: string): void {
    const generation = this.#require(generationId)
    if (generation.state !== 'ready') {
      throw new AssemblyRefusal(
        generation.state === 'draining' ? 'draining' : 'closed',
        'generation is not accepting work',
      )
    }
    if (generation.invocations.has(invocationId)) {
      throw new AssemblyRefusal('duplicate_invocation', `invocation already exists: ${invocationId}`)
    }
    generation.invocations.add(invocationId)
  }

  finishInvocation(generationId: string, invocationId: string): void {
    const generation = this.#require(generationId)
    if (!generation.invocations.delete(invocationId)) {
      throw new AssemblyRefusal('unknown_invocation', `unknown invocation: ${invocationId}`)
    }
    if (generation.invocations.size === 0) {
      for (const waiter of generation.idleWaiters.splice(0)) waiter()
    }
  }

  signal(generationId: string): AbortSignal {
    return this.#require(generationId).controller.signal
  }

  noteUnknown(generationId: string, actionId: string): void {
    this.#require(generationId).unknownActionIds.add(actionId)
  }

  async drain(generationId: string, deadline: number): Promise<DrainResult> {
    const generation = this.#require(generationId)
    if (generation.state !== 'ready' && generation.state !== 'draining') {
      return Object.freeze({
        state: generation.invocations.size === 0 ? 'drained' : 'blocked',
        activeInvocationIds: Object.freeze([...generation.invocations]),
        residualOwnerIds: Object.freeze(this.#residualIds(generation)),
        repeated: true,
      })
    }
    generation.state = 'draining'
    generation.controller.abort()
    for (const instance of generation.instances) {
      if (instance.ports) await instance.locked.provider.drain?.(instance.ports)
    }
    await this.#waitIdle(generation, deadline)
    const active = Object.freeze([...generation.invocations])
    generation.drained = active.length === 0
    return Object.freeze({
      state: generation.drained ? 'drained' : 'blocked',
      activeInvocationIds: active,
      residualOwnerIds: Object.freeze(this.#residualIds(generation)),
      repeated: false,
    })
  }

  async close(generationId: string): Promise<CloseResult> {
    const generation = this.#require(generationId)
    if (generation.closeStarted) {
      return Object.freeze({
        repeated: true,
        forced: generation.forced,
        drained: generation.drained && generation.invocations.size === 0,
        activeInvocationIds: Object.freeze([...generation.invocations]),
        residualOwnerIds: Object.freeze(this.#residualIds(generation)),
        resentActionIds: Object.freeze([]),
      })
    }
    generation.closeStarted = true
    const active = [...generation.invocations]
    generation.forced = active.length > 0
    await this.#releaseMounted(generation)
    this.#broker.releaseGeneration(generation.id, generation.brokerKeys)
    generation.state = this.#residualIds(generation).length > 0 ? 'residual' : 'closed'
    if (this.#published === generation) this.#published = undefined
    await this.#disposeFibers(generation)
    return Object.freeze({
      repeated: false,
      forced: generation.forced,
      drained: !generation.forced && generation.state !== 'residual',
      activeInvocationIds: Object.freeze(active),
      residualOwnerIds: Object.freeze(this.#residualIds(generation)),
      resentActionIds: Object.freeze([]),
    })
  }

  async coldStop(generationId: string): Promise<void> {
    const generation = this.#require(generationId)
    if (generation.state !== 'ready')
      throw new AssemblyRefusal('busy', 'only a ready generation can cold-stop')
    if (generation.invocations.size > 0 || this.#pinned(generation.id)) {
      throw new AssemblyRefusal('busy', 'generation still has a run or invocation')
    }
    generation.closeStarted = true
    await this.#releaseMounted(generation)
    this.#broker.releaseGeneration(generation.id, generation.brokerKeys)
    await this.#disposeFibers(generation)
    if (this.#residualIds(generation).length > 0) {
      generation.state = 'residual'
      throw new AssemblyRefusal('residual_owner', 'cold stop left an owner behind')
    }
    generation.state = 'cold'
    generation.drained = true
    if (this.#published === generation) this.#published = undefined
  }

  async recover(generationId: string): Promise<GenerationView> {
    const generation = this.#require(generationId)
    if (generation.state !== 'cold')
      throw new AssemblyRefusal('busy', 'only a cold generation can be rebuilt')
    generation.closeStarted = false
    generation.disabled = false
    generation.context = new Context()
    generation.controller = new AbortController()
    generation.instances = []
    generation.byProvider = new Map()
    for (const observer of generation.observers) {
      for (const owner of observer.owners) {
        owner.attempted = false
        owner.residual = false
      }
    }
    await this.#mount(generation)
    await this.#ready(generation)
    for (const key of generation.brokerKeys) this.#broker.hold(generation.id, key)
    generation.state = 'ready'
    this.#published = generation
    return this.view(generation.id)
  }

  residualOwners(): readonly { readonly generationId: string; readonly ownerId: string }[] {
    const owners = []
    for (const generation of this.#generations.values()) {
      for (const ownerId of this.#residualIds(generation)) {
        owners.push(Object.freeze({ generationId: generation.id, ownerId }))
      }
    }
    return Object.freeze(owners)
  }

  resourceRunning(key: string): boolean {
    return this.#broker.running(key)
  }

  resourceStarts(key: string): number {
    return this.#broker.starts(key)
  }

  attachHooksRunner(input: HooksRunnerAttachment): HooksRunnerStatus {
    if ('execution' in input && (input as { execution?: string }).execution !== 'delegated') {
      throw new AssemblyRefusal('delegated_execution', 'hook execution stays on the existing runner')
    }
    if (input.rowId !== HOOKS_RUNNER_ROW_ID) {
      throw new AssemblyRefusal('row_identity', 'hook runner takeover must use the built-in row identity', {
        rowId: input.rowId,
      })
    }
    if (!sameEvents(input.events, HOOKS_RUNNER_EVENTS)) {
      throw new AssemblyRefusal(
        'incomplete_row',
        'hook runner takeover must register the whole required event set',
      )
    }
    this.#hooksMode = 'takeover'
    this.#hooksReports = freezeReports(input.mappingReports)
    return this.hooksRunnerStatus()
  }

  disableHooksRunnerTakeover(): HooksRunnerStatus {
    this.#hooksMode = 'builtin'
    this.#hooksReports = Object.freeze([])
    return this.hooksRunnerStatus()
  }

  hooksRunnerStatus(): HooksRunnerStatus {
    return Object.freeze({
      mode: this.#hooksMode,
      rowId: HOOKS_RUNNER_ROW_ID,
      rank: this.#hooksRank,
      events: HOOKS_RUNNER_EVENTS,
      execution: 'delegated',
      mappingReports: this.#hooksReports,
    })
  }

  async deliver(generationId: string, delivery: ObserverDelivery): Promise<ObserverResult> {
    const generation = this.#require(generationId)
    const none = Object.freeze([]) as readonly never[]
    if (generation.state !== 'ready') {
      return Object.freeze({ status: 'closed', logs: Object.freeze([]), acceptedEffects: none })
    }
    const matches = generation.observers.filter((item) => item.mount.event.typeId === delivery.typeId)
    const visible = matches.filter((item) => scopeRank(delivery.scope) >= scopeRank(item.mount.scope))
    if (matches.length === 0 || visible.length === 0) {
      return Object.freeze({ status: 'refused', logs: Object.freeze([]), acceptedEffects: none })
    }
    const observer = visible[0]
    if (!observer) return Object.freeze({ status: 'refused', logs: Object.freeze([]), acceptedEffects: none })
    const signal = delivery.signal
      ? AbortSignal.any([delivery.signal, generation.controller.signal])
      : generation.controller.signal
    if (signal.aborted) {
      return Object.freeze({ status: 'cancelled', logs: Object.freeze([]), acceptedEffects: none })
    }
    const logs: string[] = []
    const context = Object.freeze({
      signal,
      log(message: string) {
        if (logs.length >= OBSERVER_LOG_COUNT) return
        logs.push(String(message).slice(0, OBSERVER_LOG_LIMIT))
      },
    })
    const data =
      delivery.data !== null && typeof delivery.data === 'object'
        ? Object.freeze(Array.isArray(delivery.data) ? [...delivery.data] : { ...delivery.data })
        : delivery.data
    try {
      await observer.mount.handle({ eventId: delivery.eventId, data }, context)
    } catch {
      return Object.freeze({ status: 'refused', logs: Object.freeze(logs), acceptedEffects: none })
    }
    return Object.freeze({ status: 'completed', logs: Object.freeze(logs), acceptedEffects: none })
  }

  #rejectContainer(plan: AssemblyPlan): void {
    const record = plan as AssemblyPlan & Record<string, unknown>
    for (const key of ['container', 'containerChoice', 'agh.container']) {
      if (key in record)
        throw new AssemblyRefusal('container_forbidden', 'container selection is not a deployment surface')
    }
  }

  #validateProviders(providers: readonly AssemblyProvider[]): readonly LockedProvider[] {
    const locked: LockedProvider[] = []
    const cells = new Set<string>()
    for (const provider of providers) {
      this.#validateIdentity(provider)
      const cell = cellOf(provider)
      if (cells.has(cell)) {
        throw new AssemblyRefusal('duplicate_cell', `scope already has a provider for ${provider.contract}`, {
          contract: provider.contract,
          logicalName: provider.logicalName,
          scope: provider.scope,
        })
      }
      cells.add(cell)
      locked.push({
        provider,
        providerId: provider.providerId,
        packageDigest: provider.packageDigest,
        contract: provider.contract,
        major: provider.major,
        logicalName: provider.logicalName,
        scope: provider.scope,
        cell,
        serviceName: `s${locked.length}`,
      })
    }
    const byCell = new Map(locked.map((item) => [item.cell, item]))
    const nodes = locked.map((item) => item.cell)
    const edges: { from: string; to: string }[] = []
    for (const item of locked) {
      for (const requirement of item.provider.requires) {
        if (!isRuntimeScope(requirement.scope))
          throw new AssemblyRefusal('invalid_provider', 'unknown requirement scope')
        const target = byCell.get(cellOf(requirement))
        if (!target) {
          if (requirement.optional) continue
          throw new AssemblyRefusal(
            'missing_dependency',
            `missing required provider: ${requirement.contract}`,
            {
              contract: requirement.contract,
              logicalName: requirement.logicalName,
            },
          )
        }
        for (const feature of requirement.features) {
          if (!target.provider.features.includes(feature) && !isCommunityContractName(requirement.contract)) {
            throw new AssemblyRefusal('feature_missing', `provider is missing feature ${feature}`, {
              feature,
              providerId: target.providerId,
            })
          }
        }
        if (longScopeCapturesShort(item.scope, target.scope, requirement.capture)) {
          throw new AssemblyRefusal(
            'scope_capture',
            'a longer-lived provider cannot capture a shorter-lived instance',
            {
              holder: item.scope,
              captured: target.scope,
            },
          )
        }
        edges.push({ from: item.cell, to: target.cell })
      }
    }
    const missing = missingDependencies(nodes, edges)
    if (missing.length > 0)
      throw new AssemblyRefusal('missing_dependency', `missing dependency: ${missing.join(',')}`)
    const cycle = detectDependencyCycle(nodes, edges)
    if (cycle)
      throw new AssemblyRefusal('dependency_cycle', `provider dependencies cycle: ${cycle.join(' -> ')}`)
    return Object.freeze(this.#order(locked, edges))
  }

  #validateIdentity(provider: AssemblyProvider): void {
    if (!isRuntimeScope(provider.scope))
      throw new AssemblyRefusal('invalid_provider', 'unknown provider scope')
    if (isContainerContract(provider.contract)) {
      throw new AssemblyRefusal('container_forbidden', 'agh.container is not a provider contract', {
        contract: provider.contract,
      })
    }
    if (provider.providerId.length === 0 || hasControlCharacter(provider.providerId)) {
      throw new AssemblyRefusal('invalid_provider', 'provider id is empty or contains a control character')
    }
    if (!Number.isSafeInteger(provider.major) || provider.major < 1) {
      throw new AssemblyRefusal('invalid_provider', 'provider major must be a positive integer')
    }
    if (!DIGEST.test(provider.packageDigest)) {
      throw new AssemblyRefusal(
        'invalid_provider',
        'provider package digest must be 64 hexadecimal characters',
      )
    }
  }

  #order(
    locked: readonly LockedProvider[],
    edges: readonly { from: string; to: string }[],
  ): LockedProvider[] {
    const byCell = new Map(locked.map((item) => [item.cell, item]))
    const waiting = new Map(locked.map((item) => [item.cell, 0]))
    const after = new Map<string, string[]>(locked.map((item) => [item.cell, []]))
    for (const edge of edges) {
      waiting.set(edge.from, (waiting.get(edge.from) ?? 0) + 1)
      after.get(edge.to)?.push(edge.from)
    }
    const ready = locked
      .map((item) => item.cell)
      .filter((cell) => waiting.get(cell) === 0)
      .sort()
    const ordered: LockedProvider[] = []
    while (ready.length > 0) {
      const cell = ready.shift()
      if (!cell) break
      const item = byCell.get(cell)
      if (!item) break
      ordered.push(item)
      for (const next of after.get(cell) ?? []) {
        const left = (waiting.get(next) ?? 1) - 1
        waiting.set(next, left)
        if (left === 0) {
          ready.push(next)
          ready.sort()
        }
      }
    }
    if (ordered.length !== locked.length) {
      throw new AssemblyRefusal('dependency_cycle', 'provider dependency order is incomplete')
    }
    return ordered
  }

  #createGeneration(
    plan: AssemblyPlan,
    locked: readonly LockedProvider[],
    contributions: readonly NormalizedLegacy[],
    admission: { readonly installed: readonly string[]; readonly diagnostics: readonly HookDiagnostic[] },
    brokerKeys: readonly string[],
  ): Generation {
    const controls = new Set<string>()
    for (const contribution of contributions) {
      for (const method of contribution.controlMethods) controls.add(method)
    }
    return {
      id: plan.generationId,
      locked,
      brokerKeys,
      contributions,
      observers: (plan.observers ?? []).map((mount) => ({ mount, owners: track(mount.owners) })),
      clientOnlyIds: Object.freeze((plan.renderers ?? []).map((renderer) => renderer.id)),
      controlMethods: Object.freeze([...controls]),
      diagnostics: admission.diagnostics,
      installedHooks: admission.installed,
      unknownActionIds: new Set(),
      state: 'closed',
      context: new Context(),
      instances: [],
      controller: new AbortController(),
      invocations: new Set(),
      idleWaiters: [],
      closeStarted: false,
      drained: false,
      forced: false,
      disabled: false,
      byProvider: new Map(),
      byCell: new Map(locked.map((item) => [item.cell, item])),
    }
  }

  async #mount(generation: Generation): Promise<void> {
    const root = generation.context
    if (!root) throw new AssemblyRefusal('closed', 'generation has no container')
    for (const locked of generation.locked) {
      const dependencyNames = locked.provider.requires.flatMap((requirement) => {
        const target = generation.byCell.get(cellOf(requirement))
        return target ? [target.serviceName] : []
      })
      const mounted: Mounted = {
        locked,
        fiber: undefined,
        ports: undefined,
        owners: track(locked.provider.owners),
        readied: false,
      }
      const plugin = {
        name: locked.serviceName,
        inject: dependencyNames,
        apply: (ctx: Context) => {
          const ports = this.#ports(generation, locked, ctx)
          mounted.ports = ports
          this.#provide(ctx, generation, locked)
        },
      }
      const fiber = root.plugin(plugin)
      mounted.fiber = fiber
      generation.instances.push(mounted)
      generation.byProvider.set(locked.providerId, mounted)
      await this.#awaitFiber(fiber, locked.providerId)
      const ports = mounted.ports
      if (!ports) throw new AssemblyRefusal('closed', `provider did not mount: ${locked.providerId}`)
      await locked.provider.create?.(ports)
      for (const contribution of generation.contributions) {
        if (contribution.providerId === locked.providerId) await contribution.apply?.(ports)
      }
    }
  }

  async #awaitFiber(fiber: Fiber & PromiseLike<Fiber>, providerId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        fiber,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new AssemblyRefusal('dependency_timeout', `provider did not mount: ${providerId}`, {
                providerId,
              }),
            )
          }, 2000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #provide(ctx: Context, generation: Generation, locked: LockedProvider): void {
    ctx.provide(locked.serviceName, {
      providerId: locked.providerId,
      packageDigest: locked.packageDigest,
      generationId: generation.id,
      token: () => locked.provider.token?.() ?? locked.providerId,
    })
  }

  #ports(generation: Generation, locked: LockedProvider, ctx: Context): AuthorizedPorts {
    const requirements = new Map(
      locked.provider.requires.map((requirement) => [
        `${requirement.scope}\u0000${requirement.contract}\u0000${requirement.logicalName}`,
        requirement,
      ]),
    )
    return Object.freeze({
      generationId: generation.id,
      providerId: locked.providerId,
      get: (requirement: Pick<ServiceRequirement, 'contract' | 'logicalName' | 'scope'>) => {
        const declared = requirements.get(
          `${requirement.scope}\u0000${requirement.contract}\u0000${requirement.logicalName}`,
        )
        if (!declared) return Object.freeze({ ok: false, code: 'denied' })
        const target = generation.byCell.get(cellOf({ ...declared, major: declared.major }))
        if (!target) return Object.freeze({ ok: false, code: 'unavailable' })
        if (declared.capture === 'factory') {
          return Object.freeze({
            read: () => {
              const service = ctx.get(target.serviceName) as { token?: () => string } | undefined
              return service?.token?.()
            },
          })
        }
        return ctx.get(target.serviceName)
      },
    })
  }

  async #ready(generation: Generation): Promise<void> {
    for (const instance of generation.instances) {
      if (instance.ports) await instance.locked.provider.ready?.(instance.ports)
      instance.readied = true
    }
  }

  async #rollback(generation: Generation): Promise<void> {
    for (const instance of [...generation.instances].reverse()) {
      await this.#releaseOne(instance)
    }
    for (const observer of [...generation.observers].reverse()) {
      await this.#releaseOwners(observer.owners)
    }
    await this.#disposeFibers(generation)
    generation.controller.abort()
  }

  async #releaseMounted(generation: Generation): Promise<void> {
    for (const instance of [...generation.instances].reverse()) await this.#releaseOne(instance)
    for (const observer of [...generation.observers].reverse()) await this.#releaseOwners(observer.owners)
  }

  async #releaseOne(instance: Mounted): Promise<void> {
    if (instance.ports && !instance.owners.some((owner) => owner.id === instance.locked.providerId)) {
      const close = instance.locked.provider.close
      if (close) {
        instance.owners.push({
          id: instance.locked.providerId,
          release: () => close(instance.ports as AuthorizedPorts),
          attempted: false,
          residual: false,
        })
      }
    }
    await this.#releaseOwners(instance.owners)
  }

  async #releaseOwners(owners: readonly TrackedOwner[]): Promise<void> {
    for (const owner of owners) {
      if (owner.attempted) continue
      owner.attempted = true
      try {
        await owner.release()
      } catch {
        owner.residual = true
      }
    }
  }

  async #disposeFibers(generation: Generation): Promise<void> {
    for (const instance of generation.instances) {
      const fiber = instance.fiber
      instance.fiber = undefined
      if (fiber) await fiber.dispose()
    }
    generation.context = undefined
  }

  async #waitIdle(generation: Generation, deadline: number): Promise<void> {
    if (generation.invocations.size === 0) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining)
      generation.idleWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  #residualIds(generation: Generation): string[] {
    const ids: string[] = []
    for (const instance of generation.instances) {
      for (const owner of instance.owners) if (owner.residual) ids.push(owner.id)
    }
    for (const observer of generation.observers) {
      for (const owner of observer.owners) if (owner.residual) ids.push(owner.id)
    }
    return ids
  }

  #pinned(generationId: string): boolean {
    for (const id of this.#runs.values()) if (id === generationId) return true
    return false
  }

  #require(generationId: string): Generation {
    const generation = this.#generations.get(generationId)
    if (!generation) throw new AssemblyRefusal('unknown_generation', `unknown generation: ${generationId}`)
    return generation
  }
}
