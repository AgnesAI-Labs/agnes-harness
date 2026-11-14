/**
 * Owner input admission for managed sessions. A managed service that holds a task for the owner does
 * not hand the owner's words to a session with `send`; it asks the platform to admit them, and the
 * platform decides whether and when a session turn may take them. Added in 5.18.
 *
 * Trust: the text of an admitted `ownerMessage` still enters the session inbox as `origin: 'system'`
 * with `trust: 'untrusted'`. Admission proves the text came from the paired owner's channel receipt;
 * it does not make the text an owner-identity input and it grants no approval.
 */

/** Why an input is in its current state. The set may grow: treat an unknown value as plain text. */
export type ManagedInputReason =
  | 'eligible'
  | 'busy'
  | 'questionOpen'
  | 'legacySourceUnknown'
  | 'recoveryUnverified'
  | 'receiptUnknown'
  | 'pairingChanged'
  | 'grantRevoked'
  | 'sessionArchived'
  | 'ownerRetained'
  | 'ownerDiscarded'

/** The task generation and start key the input is meant for; the platform compares them with the session's. */
export interface ManagedInputTarget {
  readonly taskId: string
  readonly taskGeneration: number
  readonly startKey: string
}

/**
 * One input to admit. `key` is the caller's idempotency key (1–256 characters): repeating a request
 * with the same key and the same content returns the same input, any difference is refused.
 */
export interface ManagedInputAdmission {
  readonly key: string
  readonly target: ManagedInputTarget
  readonly input: /** The text is never passed: the platform takes it from the receipt it recorded when the channel event arrived. */
    | { readonly kind: 'ownerMessage'; readonly receiptId: string }
    /** The platform writes a fixed continuation sentence, after checking the turn that ended at `turnEndSeq`. */
    | { readonly kind: 'recoveryContinuation'; readonly turnEndSeq: number }
    /** Text whose origin the platform cannot verify: it is held for the owner to decide and never runs on its own. */
    | { readonly kind: 'legacyOwnerMessage'; readonly text: string; readonly originalInbox: string | null }
}

/** Fields every input state carries. `inputId` equals the admission `key`; `version` rises on every change. */
interface ManagedInputStateFields {
  readonly inputId: string
  readonly version: number
  readonly reason: ManagedInputReason
  /** `/?session=<sessionId>&ownerInput=<inputId>`: where the owner reviews the input in the Web. */
  readonly reviewLocation: string
}

/**
 * - `queued`: the key is taken but the record was not completed (a crash, or an `admitInput` that rejected because a
 *   start gate could not be read); the input does not run. Call `admitInput` again with the same request.
 * - `enqueued`: admitted and held by the platform until the session is idle and its gates pass; held as it is while
 *   a gate cannot be read.
 * - `consumed`: a turn took the text; `turn` and `seq` identify it. Final.
 * - `retained`: kept and never delivered (the owner chose to keep or discard it, or the session was archived). Final.
 * - `needsOwner`: delivery cannot be shown to be right (receipt unknown or not this service's, pairing changed,
 *   grant revoked, start gates failing); the owner decides in the Web.
 * - `waitingQuestion`: the session has an unanswered question; the platform holds the input and moves it on.
 * - `recoveryUnknown`: a `legacyOwnerMessage`, or a `recoveryContinuation` that failed its checks; the owner decides.
 * - `legacySend`: the key only exists in the old `send` ledger; `delivery` says whether that message was found.
 * - `absent`: the platform knows no such key. `historyCoverage` is `complete` for every session the service still
 *   manages, since a managed session's input and send records are never pruned by time; `partial` is reserved for an
 *   input history the platform cannot vouch for and is not returned today.
 */
export type ManagedInputResult =
  | ({
      readonly state:
        | 'queued'
        | 'enqueued'
        | 'retained'
        | 'needsOwner'
        | 'waitingQuestion'
        | 'recoveryUnknown'
    } & ManagedInputStateFields)
  | ({
      readonly state: 'consumed'
      readonly turn: number
      readonly seq: number
    } & ManagedInputStateFields)
  | { readonly state: 'legacySend'; readonly delivery: 'consumed' | 'pending' | 'unknown' }
  | { readonly state: 'absent'; readonly historyCoverage: 'complete' | 'partial' }
