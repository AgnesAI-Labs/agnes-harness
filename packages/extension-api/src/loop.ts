import type {
  Actor,
  ContentBlock,
  InferenceEvent,
  JsonValue,
  ModelRecord,
  RequestBody,
} from '@agnes/protocol'
import type { AssistantMessage } from '@agnes/protocol/gen/session-v1'
import type {
  ChildAgentHandle,
  ChildAgentSessionService,
  ChildAgentSessionStartOptions,
} from './child-agent.js'
import type { LoopEventPort } from './loop-events.js'
import type { ToolResult } from './tool.js'

/** A session pins this identity; reopening never substitutes a different loop. */
export const DEFAULT_LOOP = Object.freeze({ id: 'agnes.default', version: '1.0.0' })

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

/** Scheduling is determined by outcome alone; phase is optional display metadata. */
export interface LoopStepOutcome {
  outcome: 'running' | 'idle' | 'turn-ended' | 'parked'
  phase?: string
  reason?: LoopEndReason
}

/** Core resolves route, contracts, media and hashes. A prepared request is session/turn bound. */
declare const preparedLoopRequest: unique symbol
export type LoopRequest = Readonly<RequestBody> & { readonly [preparedLoopRequest]: true }
export interface LoopRequestOptions {
  slot?: RequestBody['slot']
  system?: string
  /** Omitted uses the visible post-compaction history. */
  messages?: RequestBody['messages']
  /** Exact names from the turn's frozen catalog; omitted uses current disclosure. */
  tools?: readonly string[]
  sampling?: RequestBody['sampling']
  invocationId?: string
}
/** Advisory estimates of the prepared wire; never a send permit or a token upper bound. */
export interface LoopRequestEstimate {
  inputTokens: number | null
  source: 'estimate' | 'unknown'
  projectedCredits: number | null
  contextWindow: number
  reserveTokens: number
  remainingTokens: number | null
  shouldCompact: boolean | null
}
export type LoopChildStartStatus =
  | { status: 'not-sent'; invocationId: string }
  | { status: 'may-have-sent'; invocationId: string }
  | { status: 'responded'; invocationId: string; childId: string; providerId: string }
export interface LoopChildrenPort extends ChildAgentSessionService {
  start(
    task: string,
    options?: ChildAgentSessionStartOptions & { invocationId?: string },
  ): Promise<ChildAgentHandle>
  status(invocationId: string): Promise<LoopChildStartStatus>
  /** Reconnect only the original start. Unsupported/absent adoption refuses replay. */
  adopt(invocationId: string, signal: AbortSignal): Promise<ChildAgentHandle>
}
export interface LoopJobStatus {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  result?: ToolResult
}
export interface LoopInput {
  id: string
  turnId: number
  kind: 'prompt' | 'steer' | 'follow_up'
  trust: 'trusted' | 'untrusted'
  actor: Actor
  content: readonly ContentBlock[]
}
export interface LoopTurnView {
  readonly turnId: number
  readonly step: number
  readonly cancelled: boolean
  readonly history: readonly {
    seq: number
    kind: 'user' | 'assistant' | 'tool_result' | 'summary'
    trust: 'trusted' | 'untrusted'
    data: JsonValue
  }[]
  readonly tools: readonly RequestBody['tools'][number][]
  readonly model: {
    slot: string
    id: string
    capabilities: Pick<
      ModelRecord,
      'input' | 'reasoning' | 'toolCallFormats' | 'contextWindow' | 'maxTokens'
    > | null
  }
  readonly prompt: {
    sections: readonly { id: string; order: number; source: string; text: string }[]
    runtime: Readonly<Record<string, unknown>>
  }
  readonly budget: {
    maxSteps: number | null
    stepsUsed: number
    creditsUsed: number
    perRequestCap: number | null
    onExceed: 'quote' | 'deny'
  }
}
/** Durable dispatch uncertainty; responded is not a promise of successful execution. */
export type LoopEffectStatus =
  | { status: 'not-sent'; invocationId: string }
  | { status: 'may-have-sent'; invocationId: string; checkpoint: LoopCheckpoint | null }
  | {
      status: 'responded'
      invocationId: string
      checkpoint: LoopCheckpoint | null
      result: ToolResult | readonly InferenceEvent[]
    }

/**
 * Controlled ledger operations shared by all drivers. Core binds approvals, media and recovery;
 * these do not expose or accept its private program counter. The driver selects the next edge.
 */
export type LoopContinuation = 'checkpoint' | 'model' | 'tools' | 'compaction' | 'deferred' | 'failure'

export interface LoopToolCall {
  /** Stable across retries/reopen, unique within this session and lane. */
  invocationId?: string
  name: string
  args: JsonValue
}

export interface LoopContext {
  readonly sessionKey: string
  readonly lane: string
  prepareRequest(options?: LoopRequestOptions): Promise<LoopRequest>
  /** Uses this turn's prepared request without dispatch, admission or budget reservation. */
  estimateRequest(request: LoopRequest): Promise<LoopRequestEstimate>
  readonly turn: {
    view(): Promise<LoopTurnView | null>
    /** Close the current execution step before compaction. Does not run a scheduler edge. */
    endStep(): Promise<void>
    continuation(): LoopContinuation | null
    cancelled(): boolean
    checkpoint(signal: AbortSignal): Promise<LoopStepOutcome>
    finishCancelled(): Promise<LoopStepOutcome>
    finishFailure(): Promise<LoopStepOutcome>
  }
  readonly effects: { status(invocationId: string): Promise<LoopEffectStatus> }
  readonly model: {
    /** Assemble, infer and persist the assistant/tools edge with Core-owned stamps. */
    respond(signal: AbortSignal): Promise<LoopStepOutcome>
    /** RequestBody accepts text, images and other protocol content blocks. */
    stream(request: LoopRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>
    complete(request: LoopRequest, signal: AbortSignal): Promise<readonly InferenceEvent[]>
  }
  readonly tools: {
    /** Drain model-planned calls, preserving approval, cancellation and deferred-job invariants. */
    drain(signal: AbortSignal): Promise<LoopStepOutcome>
    /** Execution goes through the session's approval and tool policy path. */
    execute(call: LoopToolCall, signal: AbortSignal): Promise<ToolResult>
    /** Independent calls may overlap; results preserve input order and policy controls concurrency.
     * A pending approval throws code=PARKED after siblings drain and the turn closes.
     */
    batch(calls: readonly LoopToolCall[], signal: AbortSignal): Promise<readonly ToolResult[]>
    /** Resume only the original approval-bound call after input.resumeParked() opens it.
     * A rejected approval returns its durable refusal; an uncertain external effect is refused.
     * E_LANE_BUSY means this call still awaits its own approval continuation.
     */
    resume(invocationId: string, signal: AbortSignal): Promise<ToolResult>
  }
  readonly input: {
    /** Claims the next input and opens its observable turn, or returns null. */
    accept(): Promise<LoopInput | null>
    claim(target: 'next-turn' | 'next-step'): Promise<LoopInput | null>
    resumeParked(): Promise<'opened' | 'waiting' | 'blocked' | false>
    pending(): boolean
  }
  readonly events: LoopEventPort & {
    /** Non-reserved x/* events only; Core records this loop's untrusted plugin provenance. */
    emit(type: string, data: JsonValue): Promise<void>
    /** Persist an assistant message and the driver's next checkpoint in one ledger transaction. */
    assistant(message: Omit<AssistantMessage, 'requestSeq'>, checkpoint: LoopCheckpoint): Promise<void>
    finish(reason: LoopEndReason, error?: { code: string; message: string }): Promise<void>
  }
  readonly checkpoints: {
    read(): LoopCheckpoint | null
    write(checkpoint: LoopCheckpoint, association?: { invocationIds: readonly string[] }): Promise<void>
  }
  readonly wait: {
    /** Wait for input, wake or cancellation without busy polling. */
    park(signal: AbortSignal): Promise<void>
    /** Coalescing, lane-local wake. Await to guarantee durability before shutdown.
     * One park coalesces wakes committed before consumption; cancellation consumes none.
     * Save the next checkpoint to acknowledge delivery across restart; otherwise it is redelivered.
     */
    wake(): Promise<void>
    poll(signal: AbortSignal): Promise<LoopStepOutcome>
    delay(ms: number, signal: AbortSignal): Promise<void>
  }
  readonly compaction?: { run(signal: AbortSignal): Promise<LoopStepOutcome> }
  readonly jobs: {
    /** The original tool invocation must own a durable deferred-job marker. */
    status(invocationId: string): Promise<LoopJobStatus>
    /** Poll and atomically publish the original tool result; never run a scheduler edge. */
    join(invocationId: string, signal: AbortSignal): Promise<ToolResult>
  }
  readonly children?: LoopChildrenPort
}

export interface LoopDriver {
  step(signal: AbortSignal): Promise<LoopStepOutcome>
  cancel(): void | Promise<void>
  dispose(): void | Promise<void>
  checkpoint(): LoopCheckpoint
}

export interface LoopFactory extends LoopSelection {
  readonly capabilities: readonly string[]
  /** Ledger-backed drivers recover through public continuation ports; driver is the default. */
  readonly checkpointMode?: 'driver' | 'ledger'
  readonly codec: LoopCheckpointCodec
  create(ctx: LoopContext, signal?: AbortSignal): LoopDriver | Promise<LoopDriver>
  resume(ctx: LoopContext, checkpoint: LoopCheckpoint, signal?: AbortSignal): LoopDriver | Promise<LoopDriver>
}

export interface LoopCatalogEntry extends LoopSelection {
  capabilities: readonly string[]
  sourcePackage: string
}

/** The Cordis `loops` service. Registration returns an owner cleanup callback. */
export interface LoopRegistryPort {
  register(sourcePackage: string, factory: LoopFactory): () => Promise<void>
  resolve(selection: LoopSelection): LoopFactory
  catalog(): readonly LoopCatalogEntry[]
}

/** Shared production/testkit stop rule. Completed turns may continue only for until=idle. */
export function loopShouldStop(result: LoopStepOutcome, until: 'turn-end' | 'idle'): boolean {
  switch (result.outcome) {
    case 'running':
      return false
    case 'idle':
    case 'parked':
      return true
    case 'turn-ended':
      return until === 'turn-end' || (result.reason ?? 'completed') !== 'completed'
    default:
      throw new Error('Invalid loop step outcome')
  }
}
