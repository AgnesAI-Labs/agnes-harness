import type { ContentBlock, InferenceEvent, JsonValue, RequestBody } from '@agnes/protocol'
import type { ToolResult } from './tool.js'

/** A session pins this identity; reopening never substitutes a different loop. */
export interface LoopSelection {
  id: string
  version: string
}

/** JSON state owned by the loop, independent of the default loop phase union. */
export interface LoopCheckpoint {
  codecVersion: number
  state: JsonValue
}

/** A factory must reject unsupported versions before executing resumed work. */
export interface LoopCheckpointCodec<S = JsonValue> {
  version: number
  encode(state: S): LoopCheckpoint
  decode(checkpoint: LoopCheckpoint): S
}

export function loopCheckpointCodec<S extends JsonValue>(
  version: number,
  parse: (state: JsonValue) => S,
): LoopCheckpointCodec<S> {
  return {
    version,
    encode: (state) => ({ codecVersion: version, state: structuredClone(state) }),
    decode(checkpoint) {
      if (checkpoint.codecVersion !== version)
        throw new Error(
          `Loop checkpoint codec version ${checkpoint.codecVersion} is unsupported; expected ${version}`,
        )
      return parse(structuredClone(checkpoint.state))
    },
  }
}

export type LoopEndReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'parked'
  | 'blocked'
  | 'budget'
  | 'max_steps'
  | 'interrupted'

/** One scheduling edge. Custom phase names are deliberately open. */
export interface LoopStepOutcome {
  phase: string
  reason?: LoopEndReason
}

export interface LoopToolCall {
  name: string
  args: JsonValue
}

export interface LoopContext {
  readonly sessionKey: string
  readonly lane: string
  readonly model: {
    /** RequestBody accepts text, images and other protocol content blocks. */
    stream(request: RequestBody, signal: AbortSignal): AsyncIterable<InferenceEvent>
    complete(request: RequestBody, signal: AbortSignal): Promise<readonly InferenceEvent[]>
  }
  readonly tools: {
    /** Execution goes through the session's approval and tool policy path. */
    execute(call: LoopToolCall, signal: AbortSignal): Promise<ToolResult>
    /** Independent calls may overlap; results preserve input order and policy still controls concurrency. */
    batch(calls: readonly LoopToolCall[], signal: AbortSignal): Promise<readonly ToolResult[]>
  }
  readonly input: {
    /** Claims the next input and opens its observable turn, or returns null. */
    accept(): Promise<{ content: readonly ContentBlock[]; id?: string } | null>
    pending(): boolean
  }
  readonly events: {
    emit(type: string, data: JsonValue): Promise<void>
    finish(reason: LoopEndReason, error?: { code: string; message: string }): Promise<void>
  }
  readonly checkpoints: {
    read(): LoopCheckpoint | null
    write(checkpoint: LoopCheckpoint): Promise<void>
  }
  readonly wait: {
    /** Wait for input, wake or cancellation without busy polling. */
    park(signal: AbortSignal): Promise<void>
    wake(): void
  }
  readonly compaction?: { run(signal: AbortSignal): Promise<LoopStepOutcome> }
  readonly children?: { run(input: JsonValue, signal: AbortSignal): Promise<JsonValue> }
}

export interface LoopDriver {
  step(signal: AbortSignal): Promise<LoopStepOutcome>
  cancel(): void | Promise<void>
  dispose(): void | Promise<void>
  checkpoint(): LoopCheckpoint
}

export interface LoopFactory extends LoopSelection {
  readonly capabilities: readonly string[]
  readonly codec: LoopCheckpointCodec
  create(ctx: LoopContext): LoopDriver
  resume(ctx: LoopContext, checkpoint: LoopCheckpoint): LoopDriver
}

export interface LoopCatalogEntry extends LoopSelection {
  capabilities: readonly string[]
  sourcePackage: string
}

/** The Cordis `loops` service. Registration returns an owner cleanup callback. */
export interface LoopRegistryPort {
  register(sourcePackage: string, factory: LoopFactory): () => void
  resolve(selection: LoopSelection): LoopFactory
  catalog(): readonly LoopCatalogEntry[]
}
