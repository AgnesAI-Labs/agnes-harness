// generated from schema/runtime by tools/gen-runtime.ts — do not edit
import type * as Wire from '@agnes/protocol/runtime'

export type Outcome<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: Wire.RuntimeError
    }

export type CallContext = Readonly<
  Wire.CallContextWire & {
    signal: AbortSignal
  }
>

export type TrustedIngressContext = Readonly<{
  ingressId: Wire.Id
  installationId: Wire.Id
  runtimeId: Wire.Id
  tenantRoute: Wire.Id
  transport: 'local' | 'http' | 'websocket' | 'sse' | 'rpc'
  transportEvidence: Wire.DataRef
  receivedAt: Wire.Timestamp
  deadline: Wire.Timestamp
  traceRef: Wire.Id
  signal: AbortSignal
}>

export interface ProviderLifecycle {
  ready(context: CallContext): Promise<Outcome<void>>
  health(context: CallContext): Promise<Outcome<Wire.Health>>
  drain(deadline: Wire.Timestamp, context: CallContext): Promise<Outcome<Wire.DrainResult>>
  close(reason: Wire.CloseReason): Promise<void>
}

export interface ScopedDependencies {
  get(requirement: Wire.ServiceRequirement): Outcome<BoundService>
  openScope(scope: Wire.ScopeRef, context: CallContext): Promise<Outcome<ScopedDependencies>>
  close(): Promise<void>
}

export type FactoryContext = {
  instanceId: Wire.Id
  scope: Wire.ScopeRef
  bindingId: Wire.Id
  signal: AbortSignal
}

export interface ProviderFactory<T extends ProviderLifecycle> {
  descriptor: Wire.ProviderDescriptor
  create(config: Wire.DataRef, dependencies: ScopedDependencies, context: FactoryContext): Promise<T>
}

export type RuntimePluginDefinition = {
  id: Wire.Id
  version: string
  runtimeApiMajor: Wire.UInt53
  providers: readonly ProviderFactory<PublicProviderInstance>[]
  schemas: readonly Wire.SchemaRef[]
  contracts?: readonly Wire.CommunityContractDefinition[]
  interceptors?: readonly Wire.InterceptorRegistration[]
  author?: Wire.PluginAuthorMetadata
}

export interface BoundService {
  readonly binding: Wire.BindingRef
  query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>>
  compute(request: Wire.ServiceOperation, context: CallContext): Promise<Outcome<Wire.DataRef>>
}

export type QueryHandler = (
  request: Wire.ServiceQuery,
  context: CallContext,
) => Promise<Outcome<Wire.QueryReply>>

export type MethodHandler = (
  request: Wire.ServiceOperation,
  context: CallContext,
) => Promise<Outcome<Wire.DataRef>>

export type ActionHandlerScope = {
  instanceId: Wire.Id
  actionId: Wire.Id
  runId: Wire.Id
  bindingId: Wire.Id
  scope: Wire.ScopeRef
  signal: AbortSignal
}

export type ActionProviderFactory = {
  kind: 'leaf' | 'composite'
  recovery: Wire.RecoveryLevel
  stateCodec: Wire.StateCodecRef | null
  create(scope: ActionHandlerScope): Promise<ActionProvider>
}

export interface ServiceProvider extends ProviderLifecycle {
  query?: (request: Wire.ServiceQuery, context: CallContext) => Promise<Outcome<Wire.QueryReply>>
  actions?: Readonly<Record<string, ActionProviderFactory>>
  compute?: MethodHandler
  control?: MethodHandler
  maintenance?: MethodHandler
  observe?: MethodHandler
  ingress?: (request: Wire.ServiceOperation, context: TrustedIngressContext) => Promise<Outcome<Wire.DataRef>>
}

export type PublicProviderInstance = LoopProvider | ActionProvider | ServiceProvider

export interface LoopReadPorts {
  query(request: Wire.ServiceQuery): Promise<Outcome<Wire.QueryReply>>
  compute(request: Wire.ServiceOperation): Promise<Outcome<Wire.DataRef>>
  resolveData(ref: Wire.DataRef): Promise<Outcome<Wire.JsonValue>>
  prepare(spec: Wire.ActionSpec): Outcome<Wire.PreparedAction>
}

export interface LoopProvider extends ProviderLifecycle {
  start(frame: Wire.RunFrame, ports: LoopReadPorts): Promise<Wire.LoopTransition>
  resume(frame: Wire.RunFrame, ports: LoopReadPorts): Promise<Wire.LoopTransition>
}

export interface EffectPorts {
  invoke(request: Wire.EffectPortsInvokeRequest, context: CallContext): Promise<Outcome<Wire.DataRef>>
  stream(request: Wire.EffectPortsInvokeRequest, context: CallContext): Promise<Outcome<EffectStreamHandle>>
  upload(
    request: Wire.EffectPortsInvokeRequest,
    source: AsyncIterable<Uint8Array>,
    context: CallContext,
  ): Promise<Outcome<Wire.DataRef>>
}

export type ActionContext = {
  call: CallContext
  effects: EffectPorts
  progress(chunk: Wire.StreamChunkInput): Promise<Outcome<void>>
}

export interface LeafActionProvider extends ProviderLifecycle {
  kind: 'leaf'
  effectSemantics: 'idempotent' | 'receipt-query' | 'non-idempotent'
  executionUnit?: 'single-effect' | 'opaque-call'
  execute(frame: Wire.ActionFrame, context: ActionContext): Promise<Wire.EffectResult>
  reconcile(
    frame: Wire.ActionFrame,
    evidence: readonly Wire.DataRef[],
    context: ActionContext,
  ): Promise<Wire.ReconcileResult>
}

export interface CompositeActionProvider extends ProviderLifecycle {
  kind: 'composite'
  start(frame: Wire.ActionFrame, children: LoopReadPorts): Promise<Wire.ProviderTransition>
  resume(frame: Wire.ActionFrame, children: LoopReadPorts): Promise<Wire.ProviderTransition>
}

export type ActionProvider = LeafActionProvider | CompositeActionProvider

export interface EffectStreamHandle {
  readonly streamId: Wire.Id
  readonly chunks: AsyncIterable<Wire.StreamChunk>
  readonly ended: Promise<Wire.TransportEnd>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}
