import type {
  ContractStamp,
  CountResult,
  InferenceEvent,
  ModelRecord,
  ProbeReport,
  RequestBody,
  RouteDecl,
  ToolCall,
} from '@agnes/protocol'

/** Wire events consumed by the AI facade, before its stamps and recovery tags. */
export type ModelAdapterEvent =
  | Exclude<InferenceEvent, { type: 'sent' } | { type: 'deviation' } | { type: 'toolcall_end' }>
  | { type: 'toolcall_end'; call: ToolCall }

export type ModelAdapterStreamOptions = {
  signal: AbortSignal
  toolNames: string[]
  retry?: false
  sessionKey: string
  timeoutMs: { firstToken: number; total: number }
  /** Optional final serialized JSON; omit authentication and transport options. */
  reportRequest?: (body: unknown, attemptId?: string) => Promise<void>
  reportAttempt?: (event: import('./system-prompt.js').ModelAdapterAttemptObservation) => Promise<void>
  /** Observe actual transport dispatch after any local request capture; absent means unknown. */
  reportDispatch?: () => void
  reportSent?: (report: { sentHash: string; transforms: ContractStamp['transforms'] }) => void
}

/** Structural WireAdapter contract; authors need not inherit from a framework class. */
export interface ModelAdapterInstance {
  readonly id: string
  routes(): RouteDecl[]
  models(route: string): ModelRecord[]
  stream(
    route: string,
    request: RequestBody,
    options: ModelAdapterStreamOptions,
  ): AsyncIterable<ModelAdapterEvent>
  /** Optional non-streaming entry point for direct adapter consumers. */
  complete?(
    route: string,
    request: RequestBody,
    options: ModelAdapterStreamOptions,
  ): Promise<readonly ModelAdapterEvent[]>
  bindCredential?(route: string, value: string | undefined): void
  count?(route: string, request: RequestBody, options: { signal: AbortSignal }): Promise<CountResult>
  refresh?(route: string, signal: AbortSignal): Promise<void>
  probe?(route: string, signal: AbortSignal): Promise<ProbeReport>
  dispose?(): void | Promise<void>
}

export type ModelAdapterCredential = {
  apiKey?: string
  headers?: Record<string, string | null>
  baseUrl?: string
}

export type ModelAdapterConfig = Readonly<{
  /** Instance identity and provider identity, independent of the wire-format registration id. */
  id?: string
  providerId?: string
  /** Live host-owned credentials. Secrets never belong in catalog metadata or checkpoints. */
  credentials?: {
    resolve(route: string, signal: AbortSignal): Promise<string | ModelAdapterCredential>
    recoverRejected?(route: string, rejected: ModelAdapterCredential, signal: AbortSignal): Promise<boolean>
  }
  /** Route.api selects the registration id; Route.compat carries adapter-specific options. */
  routes: readonly (RouteDecl & { models: ModelRecord[]; keyless?: boolean })[]
}>

export type ModelAdapterCapabilities = Readonly<{
  imageInput: boolean
  tools: boolean
  streaming: boolean
  /**
   * The adapter reads `RequestBody.payload`. Default false: the facade rejects a request that
   * carries a payload before sending it.
   */
  payload?: boolean
  /**
   * The adapter accepts only a payload, not messages. Default false; requires `payload: true`.
   * Pickers of the conversation model leave such an adapter out.
   */
  payloadOnly?: boolean
}>

/** Register through an ordinary Cordis plugin that injects providers. */
export interface ModelAdapterDefinition {
  readonly id: string
  readonly version: string
  readonly capabilities: ModelAdapterCapabilities
  create(
    config: ModelAdapterConfig,
    signal?: AbortSignal,
  ): ModelAdapterInstance | Promise<ModelAdapterInstance>
  /** Registration-owned resources; instances have their own dispose hook. */
  cleanup?(): void | Promise<void>
}

/** The wire format name is independent of the adapter registration id. */
export type ModelAdapter = ModelAdapterDefinition & { readonly wireApi: string }

export type ModelAdapterCatalogEntry = Readonly<{
  id: string
  version: string
  wireApi: string
  sourcePackage: string
  capabilities: ModelAdapterCapabilities
}>
