import type { ManagedInputAdmission, ManagedInputResult } from './managed-inputs.js'

/**
 * Sessions a profile-scoped managed service opens and drives for the owner who trusted and enabled
 * its plugin. The Host records the plugin row as the session's manager; the plugin sees and drives
 * only the sessions it manages, and the owner keeps seeing, approving and stopping them in the Web.
 * Only a managed service whose reviewed declaration sets `sessions: true` receives a working port;
 * session tools and hooks never do.
 */

/** Computed from runtime facts on every read; never stored. */
export interface ManagedSessionStatus {
  readonly kind: 'notLoaded' | 'idle' | 'active' | 'systemError'
  readonly flags: readonly ('waitingOnApproval' | 'waitingOnUserInput')[]
}

/** `task` keeps the session; `ephemeral` archives it once its result was read, and keeps it out of task-experience mining. */
export type ManagedSessionRetention = 'task' | 'ephemeral'

export interface ManagedSessionStartInput {
  /** `<this package>#<bundle>`: a reviewed Bundle of the calling package. Its launch decides the session's preset. */
  readonly bundle: string
  /** A workspace the owner authorized for this plugin. */
  readonly workspace: string
  /** The first input. */
  readonly input: string
  /** Repeating a start with the same key returns the session it opened. */
  readonly startKey: string
  readonly retention: ManagedSessionRetention
  /** `full-access` is refused until the outward checkpoint and an OS boundary are both in force. */
  readonly permission?: 'default' | 'full-access'
  /** The primary model route. A route the deployment lacks refuses the start; there is no fallback. */
  readonly model?: { readonly route: string; readonly model: string }
  /** `false` refuses every memory write in the session, before any approval: full access would allow it. */
  readonly memoryWrites?: boolean
  /** `false` refuses every skill, plugin and MCP server install the session asks for, including saved skills. */
  readonly skillInstalls?: boolean
  /**
   * Binds the session to a task of the calling service. A bound session refuses `send` with
   * `CAPABILITY_DENIED` (`OWNER_INPUT_REQUIRED`); later input goes through `admitInput`. Repeating the
   * start key with another binding is refused (`START_KEY_REUSED`). Added in 5.18.
   */
  readonly taskBinding?: { readonly id: string; readonly generation: number }
}

export interface ManagedSessionStartResult {
  readonly sessionId: string
  /** False when the start key already named a session. */
  readonly created: boolean
}

export type ManagedSessionNotSubmittedReason = 'busy' | 'archived' | 'duplicateKey'

export type ManagedSessionSendResult =
  | { readonly state: 'started' }
  | { readonly state: 'notSubmitted'; readonly reason: ManagedSessionNotSubmittedReason }

export interface ManagedSessionSummary {
  readonly sessionId: string
  readonly startKey: string
  readonly bundle: string
  readonly workspace: string
  readonly retention: ManagedSessionRetention
  readonly archived: boolean
  readonly status: ManagedSessionStatus
}

export type ManagedSessionEvent =
  | { readonly kind: 'text'; readonly seq: number; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly seq: number
      readonly name: string
      readonly status: 'planned' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled'
      /** Read the full result with `toolResult(sessionId, seq)`. */
      readonly resultSeq?: number
    }
  | {
      readonly kind: 'approval'
      readonly seq: number
      readonly state: 'pending' | 'decided' | 'expired'
      readonly category: 'permission' | 'question'
      readonly summary: string
      readonly toolName?: string
    }
  | {
      /**
       * How one approval ended, at the seq of the event that ended it, so a reader paging with
       * `afterSeq` past the approval still receives it. `approvalSeq` is the seq of that approval's
       * own event. An approval that was never pending (full access) has this event at its own seq,
       * after the approval event.
       */
      readonly kind: 'approvalOutcome'
      readonly seq: number
      readonly approvalSeq: number
      readonly outcome: 'allowed' | 'rejected' | 'expired'
      /**
       * Who ended it. `person` only for an answer the owner gave on an owner surface; `full-access`
       * for the automatic allow under full access; `automatic` for everything else, expiry and any
       * answer that cannot be tied to the owner included.
       */
      readonly via: 'person' | 'full-access' | 'automatic'
    }
  | {
      readonly kind: 'turn'
      readonly seq: number
      readonly turn: number
      readonly status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
      readonly reason?: string
      readonly error?: { readonly code: string; readonly message: string }
    }

export interface ManagedSessionEvents {
  readonly events: readonly ManagedSessionEvent[]
  /** Pass back as `afterSeq` to read only what came later. */
  readonly lastSeq: number
}

export interface ManagedSessionResult {
  /** Null while no turn has ended. */
  readonly turn: { readonly status: 'completed' | 'failed' | 'cancelled'; readonly reason?: string } | null
  /** The last assistant text of the last ended turn, or null when it wrote none. */
  readonly text: string | null
}

/** Null means the runtime cannot tell, never zero. */
export interface ManagedSessionUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cost: { readonly amount: number; readonly currency: string } | null
}

export interface ManagedSessionToolResult {
  readonly name: string
  /** `pending` while the call has no result yet; `isError`, `text` and `exitCode` then say nothing. */
  readonly state: 'pending' | 'done'
  readonly isError: boolean
  readonly text: string
  /** The shell's exit code, from the Host; null for other tools and for a command that was stopped. */
  readonly exitCode: number | null
}

export interface ManagedSessions {
  start(input: ManagedSessionStartInput): Promise<ManagedSessionStartResult>
  /** Accepted only while the session is idle. The Host records `idempotencyKey`; a reused key is `duplicateKey`. */
  send(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<ManagedSessionSendResult>
  list(): Promise<readonly ManagedSessionSummary[]>
  status(sessionId: string): Promise<ManagedSessionStatus>
  events(sessionId: string, options?: { afterSeq?: number }): Promise<ManagedSessionEvents>
  result(sessionId: string): Promise<ManagedSessionResult>
  usage(sessionId: string): Promise<ManagedSessionUsage>
  toolResult(sessionId: string, callSeq: number): Promise<ManagedSessionToolResult>
  interrupt(sessionId: string): Promise<void>
  archive(sessionId: string): Promise<void>
  /**
   * Admits one input of the owner for a session bound to a task. Refusals are `CAPABILITY_DENIED` with
   * `data.reason`: `OWNER_INPUT_TARGET_MISMATCH` (`target` differs from the session's start key or
   * binding), `OWNER_INPUT_KEY_REUSED` (the key was used with a different request) and
   * `SESSION_ARCHIVED` (thrown, never returned). Invalid parameters are `INVALID_PARAMS`. Added in 5.18.
   */
  admitInput(sessionId: string, input: ManagedInputAdmission): Promise<ManagedInputResult>
  /**
   * The current state of an input by key. It never changes the request, but it may submit a held input
   * that has since become eligible, as an idle session or the platform's periodic sweep would. Added in 5.18.
   */
  inputResult(sessionId: string, input: { key: string }): Promise<ManagedInputResult>
}
