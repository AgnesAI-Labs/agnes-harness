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

export type ModelAdapterConfig = Readonly<{
  /** Route.api selects the registration id; Route.compat carries adapter-specific options. */
  routes: readonly (RouteDecl & { models: ModelRecord[]; keyless?: boolean })[]
}>

export type ModelAdapterCapabilities = Readonly<{
  imageInput: boolean
  tools: boolean
  streaming: boolean
}>

/** Register through an ordinary Cordis plugin that injects modelAdapters. */
export interface ModelAdapter {
  readonly id: string
  readonly version: string
  readonly api: string
  readonly capabilities: ModelAdapterCapabilities
  create(config: ModelAdapterConfig): ModelAdapterInstance | Promise<ModelAdapterInstance>
  /** Registration-owned resources; instances have their own dispose hook. */
  cleanup?(): void | Promise<void>
}

export type ModelAdapterCatalogEntry = Readonly<{
  id: string
  version: string
  api: string
  sourcePackage: string
  capabilities: ModelAdapterCapabilities
}>

export interface ModelAdapterRegistration {
  /** The disposer is also owned by the calling plugin fiber. Duplicate ids are refused. */
  register(adapter: ModelAdapter): () => Promise<void>
  catalog(): readonly ModelAdapterCatalogEntry[]
}
