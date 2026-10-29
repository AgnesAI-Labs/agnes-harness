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
import type { SessionRef } from './common.js'
import type { DecisionHandle, DecisionPort } from './decisions.js'
import type { LoopEventPort } from './loop-events.js'
import type { BindableKind, ServiceInstance, ServicePorts } from './service-provider.js'
import type { LoopSideCallPort } from './side-call.js'
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
/** One trailing note for one model request. */
export interface LoopTailNote {
  /**
   * Appended after the visible history and after Core's own per-request notes, as one user-side
   * message. Only Core's request-only notes, never written to history (a timed turn's measured
   * time), follow a committed note; an uncommitted note is always last. It is trusted at the level of the loop's own instructions, the same as `system`: Core
   * scrubs it and never wraps it as untrusted data, since the note is meant to steer the model. A
   * loop that quotes untrusted content in it (a tool result, a file name, fetched text) is
   * responsible for that content; Core does not mark the quote as data. 1 to 32768 UTF-8 bytes; it
   * must not begin with a Core note prefix (`[runtime context]`, `[hook context]` or
   * `[skill loaded]` followed by a line break).
   */
  readonly text: string
  /**
   * Write the note as a history row in the transaction that records this request as sent, so
   * every later request carries it as an ordinary turn and each request stays a prefix of the
   * next. The row stays even if the request then fails; `effects.status(invocationId)` tells
   * whether it was sent, so the note is not added a second time. Send it when none of the loop's
   * tool calls is still running: a result recorded after the note is placed before it in later
   * requests. Default false: this request only, and the next request's history no longer extends
   * this one from the note on. Refused together with custom `messages`.
   *
   * Resuming: the committed note is part of the history, so preparing the request again under the
   * same `invocationId` gives a different request, and sending it throws `E_RELATION`. Read
   * `effects.status(invocationId)` and use the recorded result instead.
   *
   * Other slots: a committed note on a request for a slot other than `primary` (such as `fast`,
   * `verifier` or `compaction`) is written into the main conversation history all the same, as Core's
   * own runtime and hook notes are on such requests. Core does not check this; the loop is
   * responsible for it.
   */
  readonly commit?: boolean
}
export interface LoopRequestOptions {
  slot?: RequestBody['slot']
  system?: string
  /** Omitted uses the visible post-compaction history. */
  messages?: RequestBody['messages']
  /**
   * Exact names from the turn's frozen catalog; omitted uses current disclosure, which grows
   * whenever the model loads a deferred tool, in this turn or an earlier one (loads are kept for the
   * session). Requests that pass the same names carry the same tool bytes (sorted by name, whatever
   * the order passed) and the same `tool_schema_hash` within a turn, and across turns while those
   * tools' definitions are unchanged, for the same slot and model. A name outside the catalog throws
   * `E_ENVELOPE`.
   */
  tools?: readonly string[]
  sampling?: RequestBody['sampling']
  invocationId?: string
  /** A note sent after the history; an invalid one throws `E_ENVELOPE` before anything is written. */
  tailNote?: LoopTailNote
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
  origin?: 'principal' | 'system'
  /** Host-authenticated source; data remains untrusted for model policy. */
  system?: import('@agnes/protocol').SystemInput
}
/** Facts about one tool in the turn's catalog: the three flags come from the tool's static meta; `offered` depends on the view's model. */
export interface LoopToolMeta {
  readonly isReadOnly: boolean
  readonly isDestructive: boolean
  readonly isOpenWorld: boolean
  /** Whether a request that names the tool keeps it for the view's model. */
  readonly offered: boolean
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
  /** One entry per tool in the catalog. `isReadOnly`, `isDestructive` and `isOpenWorld` come from the tool's static meta; `offered` depends on the view's model. Optional so a test double may leave it out. */
  readonly toolMeta?: Readonly<Record<string, LoopToolMeta>>
  /** The tool names a request that leaves out `tools` would send at this moment, in the order it sends them. Optional so a test double may leave it out. */
  readonly disclosedTools?: readonly string[]
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
 * Default-loop scheduling stage. Core may add stages additively; a loop must treat an unknown value
 * as an error (no exhaustive-only switch that silently falls through) rather than assume this union
 * is closed. Part of {@link DefaultLoopConvenience}; a replaceable loop never needs it.
 */
export type LoopContinuation = 'checkpoint' | 'model' | 'tools' | 'compaction' | 'deferred' | 'failure'

export interface LoopToolCall {
  /** Stable across retries/reopen, unique within this session and lane. */
  invocationId?: string
  name: string
  args: JsonValue
}

/** Options of `tools.execute` and `tools.batch`. */
export interface LoopToolCallOptions {
  /**
   * Record the call, or the whole batch, as one new assistant message that asked for it, written in
   * the same ledger transaction as the call rows and before anything runs. `true`: an assistant
   * message with no text, for a call the loop chose itself. `{ content }`: the text and thinking a
   * model produced beside a call it authored and the loop now dispatches. `content` is model output
   * in the trusted assistant frame: scrubbed when a request is rendered, not wrapped as untrusted.
   * Every call is checked first and nothing is written if one is refused, including a batch that
   * repeats an `invocationId`; a turn with an unsettled call or effect is refused with `E_RELATION`.
   * Each call still goes through approval and tool policy. Omitted: the call is recorded on its own.
   *
   * Replay takes the same `invocationId` and `announce`; the receipt covers the name, the arguments
   * and `announce`, not `content`. A planned call that was never dispatched (its process died first)
   * continues on replay while the step that planned it is open: after a reopen, a loop that replays
   * its recorded announced invocations before it prepares a request or makes any other model or tool
   * call still runs that very call, once. Otherwise the call is closed with an error result (its
   * `tool/result` row in the history carries the code `TOOL_NOT_STARTED`; a `ToolResult` has no
   * `code`) when its step ends, or before the next request is prepared, so the history never holds
   * the call without a result; a later replay returns that result (the text
   * `<name> was announced but did not run`, `isError: true`) without running the call, and the loop
   * can announce again under a new `invocationId`. An invocation whose receipt was
   * written but whose message and call rows were not (a crash between the two) stays refused.
   */
  readonly announce?: true | { readonly content: AssistantMessage['content'] }
}

/** Generic service reader. Host installs the deferred queue under its kind token. */
export interface LoopServiceReader {
  get<S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
  ): Promise<S | undefined> | S | undefined
}

/**
 * The generic controlled-execution surface: model calls, tool execution, durable decisions, effect
 * receipts, inputs, events, checkpoints and waiting. Core binds approvals, media and recovery to
 * these ports without exposing its private program counter; the driver selects every next edge.
 * A loop typed against this interface depends on nothing about the default ReAct stages.
 */
export interface GenericLoopPorts {
  readonly decisions: DecisionPort
  /** Host/Core-bound session identity. Use session.workspaceRoot for workspace-owned state, policy and config. */
  readonly session: SessionRef
  /** Host-bound services for this session. Absent means the caller has no service reader. */
  readonly services?: LoopServiceReader
  readonly sessionKey: string
  readonly lane: string
  prepareRequest(options?: LoopRequestOptions): Promise<LoopRequest>
  /** Uses this turn's prepared request without dispatch, admission or budget reservation. */
  estimateRequest(request: LoopRequest): Promise<LoopRequestEstimate>
  /**
   * Model and tool ports open a step when none is open. Opening one is an admission edge: the step
   * and credit budget and the `before_step` hooks decide there. A refusal ends the turn in Core and
   * throws `E_BUDGET` with `detail.reason` set to the reason the turn ended with; do not finish it again.
   */
  readonly turn: {
    view(): Promise<LoopTurnView | null>
    /** Close the current execution step before compaction. Does not run a scheduler edge. */
    endStep(): Promise<void>
    cancelled(): boolean
  }
  readonly effects: { status(invocationId: string): Promise<LoopEffectStatus> }
  /** One-off model calls to a chosen route and model, outside the conversation. Optional so existing test doubles keep compiling. */
  readonly sideCall?: LoopSideCallPort
  readonly model: {
    /** RequestBody accepts text, images and other protocol content blocks. */
    stream(request: LoopRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>
    complete(request: LoopRequest, signal: AbortSignal): Promise<readonly InferenceEvent[]>
  }
  readonly tools: {
    /** Execution goes through the session's approval and tool policy path. */
    execute(call: LoopToolCall, signal: AbortSignal, options?: LoopToolCallOptions): Promise<ToolResult>
    /** Independent calls may overlap; results preserve input order and policy controls concurrency.
     * A pending approval throws code=PARKED after siblings drain and the turn closes.
     */
    batch(
      calls: readonly LoopToolCall[],
      signal: AbortSignal,
      options?: LoopToolCallOptions,
    ): Promise<readonly ToolResult[]>
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
    /**
     * Append an event of this loop's own. `name` is relative (`result`, `plan.proposed`): Core writes
     * it as `x/<owning package without @>/<name>` with this loop's untrusted provenance, so a loop
     * cannot write into another owner's namespace.
     */
    emit(name: string, data: JsonValue): Promise<void>
    /** Persist an assistant message and the driver's next checkpoint in one ledger transaction. */
    assistant(message: Omit<AssistantMessage, 'requestSeq'>, checkpoint: LoopCheckpoint): Promise<void>
    /**
     * End the turn. `completed` first passes the platform stop gate (`turn_stopping` hooks, the
     * verifier and the repair decision), so the result is the gate's answer, not the request:
     * `running` means the turn stays open with the reason recorded in history, and the loop must
     * take another step before asking again. Asking again without one ends the turn as `blocked`.
     * `parked` means the gate is waiting on a person: the loop's part of the turn is over, and Core
     * completes or blocks the turn when the answer arrives. Every other reason ends the turn as given.
     */
    finish(reason: LoopEndReason, error?: { code: string; message: string }): Promise<LoopStepOutcome>
  }
  readonly checkpoints: {
    read(): LoopCheckpoint | null
    write(
      checkpoint: LoopCheckpoint,
      association?: { invocationIds?: readonly string[]; decisionRefs?: readonly DecisionHandle[] },
    ): Promise<void>
  }
  readonly wait: {
    /** Wait for input, wake or cancellation without busy polling. */
    park(signal: AbortSignal): Promise<void>
    /** Coalescing, lane-local wake. Await to guarantee durability before shutdown.
     * One park coalesces wakes committed before consumption; cancellation consumes none.
     * Save the next checkpoint to acknowledge delivery across restart; otherwise it is redelivered.
     */
    wake(): Promise<void>
    delay(ms: number, signal: AbortSignal): Promise<void>
  }
  /** Core-owned compaction policy; the loop decides when to run it. */
  readonly compaction?: { run(signal: AbortSignal): Promise<LoopStepOutcome> }
  readonly jobs: {
    /** The original tool invocation must own a durable deferred-job marker. */
    status(invocationId: string): Promise<LoopJobStatus>
    /** Poll and atomically publish the original tool result; never run a scheduler edge.
     * E_JOB_POLL_TIMEOUT is recoverable: no result or effect settlement is published; retry join.
     */
    join(invocationId: string, signal: AbortSignal): Promise<ToolResult>
  }
  readonly children?: LoopChildrenPort
}

/**
 * Coarse edges tied to Core's ReAct stages, used by `@agnes/loop-default` to reuse Core's
 * model/tool/gate policy wholesale. A replaceable loop does not need them and should not depend on
 * them: each runs a scheduler edge on the loop's behalf. Select among them through
 * `turn.continuation()`, treating an unknown {@link LoopContinuation} as an error.
 */
export interface DefaultLoopConvenience {
  readonly turn: {
    continuation(): LoopContinuation | null
    checkpoint(signal: AbortSignal): Promise<LoopStepOutcome>
    finishCancelled(): Promise<LoopStepOutcome>
    finishFailure(): Promise<LoopStepOutcome>
  }
  readonly model: {
    /** Assemble, infer and persist the assistant/tools edge with Core-owned stamps. */
    respond(signal: AbortSignal): Promise<LoopStepOutcome>
  }
  readonly tools: {
    /** Drain model-planned calls, preserving approval, cancellation and deferred-job invariants. */
    drain(signal: AbortSignal): Promise<LoopStepOutcome>
  }
  readonly wait: {
    poll(signal: AbortSignal): Promise<LoopStepOutcome>
  }
}

/** Everything Core binds for a session. Prefer {@link GenericLoopPorts} in a replaceable loop. */
export type LoopContext = GenericLoopPorts & DefaultLoopConvenience

export interface LoopDriver {
  step(signal: AbortSignal): Promise<LoopStepOutcome>
  cancel(): void | Promise<void>
  dispose(): void | Promise<void>
  checkpoint(): LoopCheckpoint
}

/** Optional human controls. Omission is a refusal, never an inferred default.
 * Steer is claimed at a completed step boundary, never inside an active tool batch.
 * Interrupt cooperatively drains effects before accepting the next input.
 * Pause keeps the turn/checkpoint and must remain paused after cold recovery.
 * Cancellation is part of every driver's existing lifecycle contract.
 */
export interface LoopControls {
  readonly steer?: boolean
  readonly interrupt?: boolean
  readonly pause?: boolean
}

export interface LoopFactory extends LoopSelection {
  readonly controls?: LoopControls
  readonly capabilities: readonly string[]
  /** Ledger-backed drivers recover through public continuation ports; driver is the default. */
  readonly checkpointMode?: 'driver' | 'ledger'
  readonly codec: LoopCheckpointCodec
  create(ctx: LoopContext, signal?: AbortSignal): LoopDriver | Promise<LoopDriver>
  resume(ctx: LoopContext, checkpoint: LoopCheckpoint, signal?: AbortSignal): LoopDriver | Promise<LoopDriver>
}

/** A factory that needs only the generic ports. It is a valid {@link LoopFactory}. */
export interface GenericLoopFactory extends Omit<LoopFactory, 'create' | 'resume'> {
  create(ctx: GenericLoopPorts, signal?: AbortSignal): LoopDriver | Promise<LoopDriver>
  resume(
    ctx: GenericLoopPorts,
    checkpoint: LoopCheckpoint,
    signal?: AbortSignal,
  ): LoopDriver | Promise<LoopDriver>
}

export interface LoopCatalogEntry extends LoopSelection {
  controls?: LoopControls
  capabilities: readonly string[]
  sourcePackage: string
}

/** Host-owned Loop resolution and catalog operations. */
export interface LoopRegistryPort {
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
