import type * as Wire from '@agnes/protocol/runtime'
import {
  RuntimeAuthorCapabilities,
  RuntimeInterceptorPolicy,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { HOOK_TABLE } from '../generated/hook-table.js'
import type { HookPayloadMap, HookReturnMap } from '../hooks.js'
import { assertAuthorSchema } from './authoring-schemas.js'
import {
  assertEntry,
  assertFields,
  assertFunction,
  assertId,
  assertSynchronous,
  copyJson,
  copyLocalArray,
  declarationError,
  uniqueStrings,
  validName,
} from './authoring-validation.js'
import type * as Local from './public-api.js'

export { canonicalJsonDigest } from '@agnes/protocol/runtime'
export { runtimeAuthorSchemas } from './authoring-schemas.js'

export const standardHookCapabilities = Object.freeze({
  rawToolResult: RuntimeAuthorCapabilities.rawToolResult,
  toolResultDisplay: RuntimeAuthorCapabilities.toolResultDisplay,
  networkRequest: RuntimeAuthorCapabilities.networkRequest,
})
export const simpleLoopCapabilities = Object.freeze({
  modelInference: RuntimeAuthorCapabilities.modelInference,
})

export type MaybePromise<T> = T | Promise<T>
export type EmptyAuthorConfig = Readonly<Record<string, never>>
export interface AuthorSchema<T> {
  readonly ref: Wire.SchemaRef
  readonly parse: (value: unknown) => Local.Outcome<T>
  readonly encode: (value: T) => Local.Outcome<Wire.DataRef>
}
export type AuthorConfig<C> = { schema: AuthorSchema<C>; defaults: C }
export type AuthorCall<C> = { readonly signal: AbortSignal; readonly config: Readonly<C> }
const authorProviderDeclarationBrand: unique symbol = Symbol('author provider declaration')
export type AuthorProviderDeclaration<D = unknown> = {
  readonly kind: 'algorithm' | 'simple-loop'
  readonly definition: D
  readonly [authorProviderDeclarationBrand]: true
}
const providerDeclarations = new WeakSet<object>()
export type ContributionExport = Wire.ContributionExport
export type AuthorContribution = InterceptorReadonly<Wire.AuthorContribution>
export type ToolContribution = InterceptorReadonly<Wire.ToolContribution>
export type RoutingContribution = InterceptorReadonly<Wire.RoutingContribution>
export type ArtifactContribution = InterceptorReadonly<Wire.ArtifactContribution>
export type WorkflowContribution = InterceptorReadonly<Wire.WorkflowContribution>
export type ObserverContribution = InterceptorReadonly<Wire.ObserverContribution>
export type RendererContribution = InterceptorReadonly<Wire.RendererContribution>
export type InterceptorContribution = InterceptorReadonly<Wire.InterceptorContribution>
export type PluginAuthorDefinition = {
  id: Wire.Id
  version: string
  runtimeApiMajor?: 1
  contributions?: readonly AuthorContribution[]
  providers?: readonly (Local.ProviderFactory<Local.PublicProviderInstance> | AuthorProviderDeclaration)[]
  contracts?: readonly Wire.CommunityContractDefinition[]
  schemas?: readonly Wire.SchemaRef[]
  author?: Wire.PluginAuthorMetadata
}
export type StandardToolOutput = InterceptorReadonly<Wire.StandardToolOutput>
export type TypedEffectOperation<I, O> = {
  contract: string
  logicalName: string
  method: string
  input: AuthorSchema<I>
  output: AuthorSchema<O>
}
export interface AuthorEffects {
  invoke<I, O>(operation: TypedEffectOperation<I, O>, input: I): Promise<Local.Outcome<O>>
}
export type AuthorCapabilityRequirement = InterceptorReadonly<Wire.CapabilityRequirement>
export type AuthorEffectReference = { contract: string; logicalName: string; method: string }
export type PureToolDefinition<I, C = EmptyAuthorConfig> = {
  id: string
  description: string
  execution: 'pure'
  input: AuthorSchema<I>
  config?: AuthorConfig<C>
  execute(input: I, context: AuthorCall<C>): MaybePromise<StandardToolOutput>
}
export type OpaqueToolDefinition<I, C = EmptyAuthorConfig> = {
  id: string
  description: string
  execution: 'opaque'
  input: AuthorSchema<I>
  config?: AuthorConfig<C>
  effects: readonly AuthorEffectReference[]
  permissions: readonly AuthorCapabilityRequirement[]
  execute(
    input: I,
    context: AuthorCall<C> & { readonly effects: AuthorEffects },
  ): MaybePromise<StandardToolOutput>
}
export type RoutingStrategyDefinition<C = EmptyAuthorConfig> = {
  id: string
  config?: AuthorConfig<C>
  select(
    input: Readonly<Wire.RoutingSelectInput>,
    context: AuthorCall<C>,
  ): MaybePromise<Wire.RoutingSelectResult>
}
export type AlgorithmImplementationMap = {
  'agh.context': { view: Local.QueryHandler; refresh: Local.ActionProviderFactory }
  'agh.compaction': {
    plan: Local.MethodHandler
    expand: Local.QueryHandler
    execute: Local.ActionProviderFactory
    apply: Local.ActionProviderFactory
  }
  'agh.loop': Pick<Local.LoopProvider, 'start' | 'resume'>
  'agh.routing': {
    select(
      input: Readonly<Wire.RoutingSelectInput>,
      context: AuthorCall<EmptyAuthorConfig>,
    ): MaybePromise<Wire.RoutingSelectResult>
  }
  'agh.pricing': {
    quote(
      input: Readonly<Wire.PricingQuoteInput>,
      context: AuthorCall<EmptyAuthorConfig>,
    ): MaybePromise<Wire.PriceQuote>
  }
}
export type AlgorithmAdapterDefinition<K extends keyof AlgorithmImplementationMap, C = EmptyAuthorConfig> = {
  id: string
  contract: K
  config?: AuthorConfig<C>
  requires: readonly Wire.ServiceRequirement[]
  permissions: readonly AuthorCapabilityRequirement[]
  stateCodecs?: readonly Wire.StateCodecRef[]
  make(
    config: Readonly<C>,
    dependencies: Local.ScopedDependencies,
    context: Local.FactoryContext,
  ): MaybePromise<AlgorithmImplementationMap[K]>
}
export type InterceptorEvent = Wire.InterceptorEvent
export type InterceptorCategory<E extends InterceptorEvent> = E extends
  | 'before_step'
  | 'tool_call'
  | 'turn_stopping'
  ? 'directive'
  : 'transform'
export type InterceptorPhase = Wire.InterceptorPhase
export type InterceptorReadonly<T> = T extends readonly (infer V)[]
  ? readonly InterceptorReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: InterceptorReadonly<T[K]> }
    : T
export type InterceptorInput<E extends InterceptorEvent> = InterceptorReadonly<
  Partial<Omit<HookPayloadMap[E], 'getSurface'>>
>
export type InterceptorContext<C> = AuthorCall<C> & {
  readonly invocation: InterceptorReadonly<Wire.InterceptorInvocation>
  log(message: string): void
}
export type InterceptorOptions<E extends InterceptorEvent, C> = {
  id: string
  event: E
  config?: AuthorConfig<C>
  priority?: number
  before?: readonly Wire.Id[]
  after?: readonly Wire.Id[]
  mandatory?: boolean
  failPolicy?: 'open' | 'closed'
  timeoutMs?: Wire.UInt53
  readFields: readonly string[]
  writeFields: readonly string[]
  permissions: readonly AuthorCapabilityRequirement[]
}
export type InterceptorDefinition<E extends InterceptorEvent, C = EmptyAuthorConfig> = InterceptorOptions<
  E,
  C
> &
  (
    | {
        execution: 'pure'
        handle(input: InterceptorInput<E>, context: InterceptorContext<C>): MaybePromise<HookReturnMap[E]>
      }
    | {
        execution: 'opaque'
        effects: readonly AuthorEffectReference[]
        handle(
          input: InterceptorInput<E>,
          context: InterceptorContext<C> & { readonly effects: AuthorEffects },
        ): MaybePromise<HookReturnMap[E]>
      }
  )
export type SimpleReadonly<T> = T extends readonly (infer U)[]
  ? readonly SimpleReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: SimpleReadonly<T[K]> }
    : T
export type SimpleStepView<C = EmptyAuthorConfig> = SimpleReadonly<
  Omit<Wire.SimpleStepView, 'config'> & { config: C }
>
export type SimpleLoopDefinition<C = EmptyAuthorConfig> = {
  id: string
  config?: AuthorConfig<C>
  permissions: readonly AuthorCapabilityRequirement[]
  ask?(view: SimpleStepView<C>): SimpleReadonly<Wire.SimpleModelRequest> | null
  next(
    view: SimpleStepView<C>,
    decision: SimpleReadonly<Wire.SimpleDecisionObservation>,
  ): SimpleReadonly<Wire.SimpleStepDecision>
}
export type ArtifactDraft = { title: string; mediaType: string; bytes: Uint8Array }
export type ArtifactToolDefinition<I, C = EmptyAuthorConfig> = {
  id: string
  description: string
  input: AuthorSchema<I>
  config?: AuthorConfig<C>
  render(input: I, context: AuthorCall<C>): MaybePromise<ArtifactDraft>
}
export type WorkflowFrame<I, S> = {
  input: I
  state: S | null
  runtime: Omit<Wire.ActionFrame, 'input' | 'continuation'>
}
export type WorkflowTransition<S> = {
  state: S
  references: readonly Wire.RetentionRef[]
  consumeSignals?: readonly Wire.Id[]
  children?: readonly Wire.PreparedAction[]
  next: Wire.NextStep
}
export interface WorkflowPorts extends Local.LoopReadPorts {
  prepareTyped<I, O>(request: {
    key: string
    operation: TypedEffectOperation<I, O>
    input: I
    dependencies: readonly Wire.ActionDependency[]
    retry: Wire.RetryPolicy
    obligation: 'mandatory'
    deadline: Wire.Timestamp
    references: readonly Wire.RetentionRef[]
  }): Local.Outcome<Wire.PreparedAction>
}
export type DurableWorkflowDefinition<I, S, O = Wire.JsonValue, C = EmptyAuthorConfig> = {
  id: string
  input: AuthorSchema<I>
  output: AuthorSchema<O>
  config?: AuthorConfig<C>
  state: { schema: AuthorSchema<S>; codecVersion: string }
  requires: readonly Wire.ServiceRequirement[]
  permissions: readonly AuthorCapabilityRequirement[]
  start(
    frame: WorkflowFrame<I, S>,
    ports: WorkflowPorts,
    context: AuthorCall<C>,
  ): Promise<WorkflowTransition<S>>
  resume(
    frame: WorkflowFrame<I, S>,
    ports: WorkflowPorts,
    context: AuthorCall<C>,
  ): Promise<WorkflowTransition<S>>
}
export type ObserverDefinition<T> = {
  id: string
  event: { typeId: string; schema: AuthorSchema<T> }
  handle(
    notification: { eventId: Wire.Id; data: T },
    context: {
      signal: AbortSignal
      log(message: string): void
    },
  ): MaybePromise<void>
}

function schema<T>(value: AuthorSchema<T>): AuthorSchema<T> {
  assertFields(value, ['ref', 'parse', 'encode'])
  assertFunction(value.parse)
  assertFunction(value.encode)
  assertAuthorSchema(value)
  return value
}

function config<C>(value: AuthorConfig<C> | undefined): AuthorConfig<C> | undefined {
  if (value === undefined) return undefined
  assertFields(value, ['schema', 'defaults'])
  schema(value.schema)
  const defaults = copyJson(value.defaults)
  const parsed = value.schema.parse(defaults)
  if (!parsed.ok) declarationError('configuration defaults do not match their schema')
  return Object.freeze({ schema: value.schema, defaults })
}

function base<C>(value: { id: string; config?: AuthorConfig<C> }): { id: string; config?: AuthorConfig<C> } {
  assertId(value.id)
  const normalized = config(value.config)
  return normalized === undefined ? { id: value.id } : { id: value.id, config: normalized }
}

function effectReferences(values: readonly AuthorEffectReference[]): readonly AuthorEffectReference[] {
  if (!Array.isArray(values)) declarationError('expected an effect operation array')
  const safeValues = copyJson(values)
  const seen = new Set<string>()
  return Object.freeze(
    safeValues.map((value) => {
      assertFields(value, ['contract', 'logicalName', 'method'])
      const key = `${value.contract}/${value.logicalName}/${value.method}`
      if (seen.has(key)) declarationError('duplicate effect operation')
      seen.add(key)
      for (const name of [value.contract, value.logicalName, value.method]) uniqueStrings([name])
      const catalog: Readonly<
        Record<
          string,
          {
            readonly methods: Readonly<
              Record<
                string,
                {
                  readonly kind?: string
                  readonly local?: boolean
                  readonly sameAttemptBrokerAllowed?: boolean
                }
              >
            >
          }
        >
      > = RuntimeServiceCatalog
      const operation = catalog[value.contract]?.methods[value.method]
      if (
        operation?.local === true ||
        operation?.kind !== 'action' ||
        operation.sameAttemptBrokerAllowed !== true
      )
        declarationError('effect operation is not registered for an opaque broker attempt')
      return Object.freeze({ ...value })
    }),
  )
}

function permissions(values: readonly AuthorCapabilityRequirement[]): readonly AuthorCapabilityRequirement[] {
  if (!Array.isArray(values)) declarationError('expected a permissions array')
  const safeValues = copyJson(values)
  for (const value of safeValues)
    if (!validateRuntime('CapabilityRequirement', value).ok)
      declarationError('invalid capability requirement')
  return safeValues
}

type InterceptionPolicy = {
  readonly readFields: readonly string[]
  readonly writeFields: readonly string[]
  readonly readCapabilities?: Readonly<Record<string, readonly (keyof typeof RuntimeAuthorCapabilities)[]>>
  readonly writeCapabilities?: Readonly<Record<string, readonly (keyof typeof RuntimeAuthorCapabilities)[]>>
}

function fieldCapabilities(
  fields: readonly string[],
  rules: InterceptionPolicy['readCapabilities'],
  requested: readonly AuthorCapabilityRequirement[],
): void {
  for (const field of fields)
    for (const name of rules?.[field] ?? []) {
      const required = RuntimeAuthorCapabilities[name]
      if (
        !requested.some(
          (actual) =>
            actual.capability === required.capability &&
            required.resourceTypes.every((type) => actual.resourceTypes.includes(type)) &&
            required.operations.every((operation) => actual.operations.includes(operation)),
        )
      )
        declarationError('interception field requires an explicit capability request')
    }
}

function requirements(values: readonly Wire.ServiceRequirement[]): readonly Wire.ServiceRequirement[] {
  if (!Array.isArray(values)) declarationError('expected a service requirements array')
  const safeValues = copyJson(values)
  for (const value of safeValues)
    if (!validateRuntime('ServiceRequirement', value).ok) declarationError('invalid service requirement')
  return safeValues
}

function providerDeclaration<D>(
  kind: AuthorProviderDeclaration['kind'],
  definition: D,
): AuthorProviderDeclaration<D> {
  const declaration = Object.freeze({ kind, definition, [authorProviderDeclarationBrand]: true as const })
  providerDeclarations.add(declaration)
  return declaration
}

export function adaptProvider<K extends keyof AlgorithmImplementationMap, C = EmptyAuthorConfig>(
  definition: AlgorithmAdapterDefinition<K, C>,
): AuthorProviderDeclaration<AlgorithmAdapterDefinition<K, C>> {
  assertFields(definition, ['id', 'contract', 'config', 'requires', 'permissions', 'stateCodecs', 'make'])
  if (
    !['agh.context', 'agh.compaction', 'agh.loop', 'agh.routing', 'agh.pricing'].includes(definition.contract)
  )
    declarationError('contract has no complete algorithm adapter')
  assertFunction(definition.make)
  const codecs = copyJson(definition.stateCodecs ?? [])
  if (!Array.isArray(codecs)) declarationError('expected a state codec array')
  for (const codec of codecs)
    if (!validateRuntime('StateCodecRef', codec).ok) declarationError('invalid state codec reference')
  if ((definition.contract === 'agh.routing' || definition.contract === 'agh.pricing') && codecs.length > 0)
    declarationError('stateless algorithm adapters cannot declare persistent codecs')
  const normalized = Object.freeze({
    ...definition,
    ...base(definition),
    requires: requirements(definition.requires),
    permissions: permissions(definition.permissions),
    stateCodecs: copyJson(codecs),
  })
  return providerDeclaration('algorithm', normalized)
}

export function defineSimpleLoop<C = EmptyAuthorConfig>(
  definition: SimpleLoopDefinition<C>,
): AuthorProviderDeclaration<SimpleLoopDefinition<C>> {
  assertFields(definition, ['id', 'config', 'permissions', 'ask', 'next'])
  assertSynchronous(definition.next)
  if (definition.ask !== undefined) assertSynchronous(definition.ask)
  const normalized = Object.freeze({
    ...definition,
    ...base(definition),
    permissions: permissions(definition.permissions),
  })
  return providerDeclaration('simple-loop', normalized)
}

export function defineTool<I, C = EmptyAuthorConfig>(
  definition: PureToolDefinition<I, C>,
): PureToolDefinition<I, C>
export function defineTool<I, C = EmptyAuthorConfig>(
  definition: OpaqueToolDefinition<I, C>,
): OpaqueToolDefinition<I, C>
export function defineTool<I, C = EmptyAuthorConfig>(
  definition: PureToolDefinition<I, C> | OpaqueToolDefinition<I, C>,
): PureToolDefinition<I, C> | OpaqueToolDefinition<I, C> {
  assertFields(definition, [
    'id',
    'description',
    'execution',
    'input',
    'config',
    'effects',
    'permissions',
    'execute',
  ])
  assertFields(
    definition,
    definition.execution === 'opaque'
      ? ['id', 'description', 'execution', 'input', 'config', 'effects', 'permissions', 'execute']
      : ['id', 'description', 'execution', 'input', 'config', 'execute'],
  )
  assertFunction(definition.execute)
  schema(definition.input)
  if (typeof definition.description !== 'string' || definition.description.length === 0)
    declarationError('a tool description is required')
  const common = { ...definition, ...base(definition) }
  if (definition.execution === 'pure') return Object.freeze(common as PureToolDefinition<I, C>)
  if (definition.execution !== 'opaque') declarationError('unsupported tool execution mode')
  return Object.freeze({
    ...common,
    execution: 'opaque',
    effects: effectReferences(definition.effects),
    permissions: permissions(definition.permissions),
  })
}

export function defineRoutingStrategy<C = EmptyAuthorConfig>(
  definition: RoutingStrategyDefinition<C>,
): RoutingStrategyDefinition<C> {
  assertFields(definition, ['id', 'config', 'select'])
  assertFunction(definition.select)
  return Object.freeze({ ...definition, ...base(definition) })
}

export function defineArtifactTool<I, C = EmptyAuthorConfig>(
  definition: ArtifactToolDefinition<I, C>,
): ArtifactToolDefinition<I, C> {
  assertFields(definition, ['id', 'description', 'input', 'config', 'render'])
  assertFunction(definition.render)
  schema(definition.input)
  if (typeof definition.description !== 'string' || definition.description.length === 0)
    declarationError('an artifact description is required')
  return Object.freeze({ ...definition, ...base(definition) })
}

export function defineDurableWorkflow<I, S, O = Wire.JsonValue, C = EmptyAuthorConfig>(
  definition: DurableWorkflowDefinition<I, S, O, C>,
): DurableWorkflowDefinition<I, S, O, C> {
  assertFields(definition, [
    'id',
    'input',
    'output',
    'config',
    'state',
    'requires',
    'permissions',
    'start',
    'resume',
  ])
  assertFunction(definition.start)
  assertFunction(definition.resume)
  schema(definition.input)
  schema(definition.output)
  assertFields(definition.state, ['schema', 'codecVersion'])
  schema(definition.state.schema)
  if (!validName(definition.state.codecVersion)) declarationError('workflow codec version is required')
  return Object.freeze({
    ...definition,
    ...base(definition),
    state: Object.freeze({ ...definition.state }),
    requires: requirements(definition.requires),
    permissions: permissions(definition.permissions),
  })
}

export function defineObserver<T>(definition: ObserverDefinition<T>): ObserverDefinition<T> {
  assertFields(definition, ['id', 'event', 'handle'])
  assertId(definition.id)
  assertFunction(definition.handle)
  assertFields(definition.event, ['typeId', 'schema'])
  schema(definition.event.schema)
  if (definition.event.typeId !== definition.event.schema.ref.typeId)
    declarationError('observer event schema does not match its type')
  return Object.freeze({ ...definition, event: Object.freeze({ ...definition.event }) })
}

export function defineInterceptor<E extends InterceptorEvent, C = EmptyAuthorConfig>(
  definition: InterceptorDefinition<E, C>,
): InterceptorDefinition<E, C> {
  const fields = [
    'id',
    'event',
    'config',
    'priority',
    'before',
    'after',
    'mandatory',
    'failPolicy',
    'timeoutMs',
    'readFields',
    'writeFields',
    'permissions',
    'execution',
    'effects',
    'handle',
  ]
  assertFields(definition, fields)
  const policy: InterceptionPolicy = RuntimeInterceptorPolicy[definition.event]
  if (!policy) declarationError('event is not an interception point')
  const event = HOOK_TABLE[definition.event]
  const failPolicy = definition.failPolicy ?? event.failPolicy
  if (failPolicy !== 'open' && failPolicy !== 'closed')
    declarationError('invalid interception failure policy')
  if (event.failPolicy === 'closed' && failPolicy === 'open')
    declarationError('a closed event cannot be opened')
  const mandatory = definition.mandatory ?? failPolicy === 'closed'
  if (typeof mandatory !== 'boolean' || (mandatory && failPolicy !== 'closed'))
    declarationError('mandatory interception requires a closed failure policy')
  const timeoutMs = definition.timeoutMs ?? event.timeoutMs
  if (
    !Number.isSafeInteger(timeoutMs) ||
    Object.is(timeoutMs, -0) ||
    timeoutMs < 0 ||
    timeoutMs > event.timeoutMs
  )
    declarationError('interception timeout exceeds the event limit')
  const priority = definition.priority ?? 0
  if (!Number.isFinite(priority)) declarationError('invalid interception priority')
  const before = uniqueStrings(definition.before ?? [])
  const after = uniqueStrings(definition.after ?? [])
  if (before.includes(definition.id) || after.includes(definition.id))
    declarationError('interception ordering cannot reference itself')
  const readFields = uniqueStrings(definition.readFields)
  const writeFields = uniqueStrings(definition.writeFields)
  for (const field of readFields)
    if (!(policy.readFields as readonly string[]).includes(field))
      declarationError('unknown interception read field')
  for (const field of writeFields)
    if (!(policy.writeFields as readonly string[]).includes(field))
      declarationError('unknown interception write field')
  const requested = permissions(definition.permissions)
  fieldCapabilities(readFields, policy.readCapabilities, requested)
  fieldCapabilities(writeFields, policy.writeCapabilities, requested)
  assertFunction(definition.handle)
  const common = {
    ...definition,
    ...base(definition),
    failPolicy,
    mandatory,
    timeoutMs,
    priority,
    before,
    after,
    readFields,
    writeFields,
    permissions: requested,
  }
  if (definition.execution === 'pure') {
    if (Object.hasOwn(definition, 'effects')) declarationError('a pure interceptor cannot request effects')
    return Object.freeze(common) as InterceptorDefinition<E, C>
  }
  if (definition.execution !== 'opaque') declarationError('unsupported interceptor execution mode')
  return Object.freeze({ ...common, effects: effectReferences(definition.effects) }) as InterceptorDefinition<
    E,
    C
  >
}

export function defineRuntimePlugin(input: PluginAuthorDefinition): PluginAuthorDefinition {
  assertFields(input, [
    'id',
    'version',
    'runtimeApiMajor',
    'contributions',
    'providers',
    'contracts',
    'schemas',
    'author',
  ])
  if (!validName(input.id)) declarationError('invalid package ID')
  if (
    typeof input.version !== 'string' ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(
      input.version,
    )
  )
    declarationError('invalid package version')
  if (input.runtimeApiMajor !== undefined && input.runtimeApiMajor !== 1)
    declarationError('unsupported runtime API major')
  const ids = new Set<string>()
  const exports = new Set<string>()
  const contributions = copyJson(input.contributions ?? []).map((contribution) => {
    assertFields(contribution, ['kind', 'id', 'implementation'])
    assertId(contribution.id)
    if (
      !['tool', 'routing', 'artifact-tool', 'workflow', 'observer', 'renderer', 'interceptor'].includes(
        contribution.kind,
      )
    )
      declarationError('unknown contribution kind')
    if (ids.has(contribution.id)) declarationError('duplicate contribution ID')
    ids.add(contribution.id)
    assertFields(contribution.implementation, ['entry', 'export'])
    assertEntry(contribution.implementation.entry)
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(contribution.implementation.export))
      declarationError('expected a named source export')
    const key = `${contribution.implementation.entry}#${contribution.implementation.export}`
    if (exports.has(key)) declarationError('duplicate contribution export')
    exports.add(key)
    return Object.freeze({
      ...contribution,
      implementation: Object.freeze({ ...contribution.implementation }),
    })
  })
  const contractCells = new Set<string>()
  const contracts = copyJson(input.contracts ?? [])
  for (const contract of contracts) {
    if (!validateRuntime('CommunityContractDefinition', contract).ok)
      declarationError('invalid community contract definition')
    const prefix = `${input.id}/`
    if (
      contract.ownerPackageId !== input.id ||
      !contract.contract.startsWith(prefix) ||
      !/^[a-z][a-z0-9-]*$/.test(contract.contract.slice(prefix.length)) ||
      /^agh(?:[./]|$)/.test(contract.contract)
    )
      declarationError('community contract owner does not match its package')
    const cell = `${contract.contract}@${contract.major}`
    if (contractCells.has(cell)) declarationError('duplicate community contract definition')
    contractCells.add(cell)
    uniqueStrings(contract.operations.map((operation) => operation.method))
  }
  const schemaCells = new Set<string>()
  const schemas = copyJson(input.schemas ?? [])
  for (const reference of schemas) {
    if (!validateRuntime('SchemaRef', reference).ok) declarationError('invalid schema reference')
    const cell = `${reference.typeId}@${reference.revision}`
    if (schemaCells.has(cell)) declarationError('duplicate schema reference')
    schemaCells.add(cell)
  }
  const providerIds = new Set<string>()
  const providers = copyLocalArray(input.providers ?? []).map((provider) => {
    let providerId: string
    let normalized = provider
    if (providerDeclarations.has(provider)) {
      const declaration = provider as AuthorProviderDeclaration<{ id: string }>
      providerId = `${input.id}/contribution/${declaration.definition.id}`
    } else {
      if (Object.hasOwn(provider, 'kind') || Object.hasOwn(provider, 'definition'))
        declarationError('provider declarations must come from their SDK constructor')
      assertFields(provider, ['descriptor', 'create'])
      const factory = provider as Local.ProviderFactory<Local.PublicProviderInstance>
      assertFunction(factory.create)
      const descriptor = copyJson(factory.descriptor)
      if (!validateRuntime('ProviderDescriptor', descriptor).ok)
        declarationError('invalid complete provider descriptor')
      providerId = descriptor.providerId
      normalized = Object.freeze({ descriptor, create: factory.create })
    }
    if (providerIds.has(providerId) || [...ids].some((id) => `${input.id}/contribution/${id}` === providerId))
      declarationError('duplicate provider or contribution ID')
    providerIds.add(providerId)
    return normalized
  })
  const author = input.author === undefined ? undefined : copyJson(input.author)
  if (author !== undefined && !validateRuntime('PluginAuthorMetadata', author).ok)
    declarationError('invalid advanced author metadata')
  return Object.freeze({
    ...input,
    runtimeApiMajor: 1,
    contributions: Object.freeze(contributions),
    providers: Object.freeze(providers),
    contracts,
    schemas,
    ...(author === undefined ? {} : { author }),
  })
}

export { standardHookOperations } from './authoring-hook-operations.js'
export type { GeneratedAuthorSchemaSource } from './authoring-source.js'
export { defineGeneratedAuthorSchema } from './authoring-source.js'
