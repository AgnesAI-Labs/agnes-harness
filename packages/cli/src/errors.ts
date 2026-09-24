import type { TurnEndReason } from '@agnes/protocol'

/**
 * The whole vocabulary a script calling `agnes` ever sees. It is closed: no code path invents a
 * number outside this object, and every number here has exactly one meaning.
 */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  PARKED: 3,
  BUDGET: 4,
  MAX_STEPS: 5,
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} as const
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * The three signals the ladder installs, and the code each one exits with. This is the single table:
 * boot/signals.ts reads it rather than keeping three numbers of its own, so the ladder's exit code
 * and the code an aborted turn reports cannot drift apart while two tests each stay green.
 */
export const SIGNAL_EXIT_CODES = {
  SIGINT: ExitCode.SIGINT,
  SIGTERM: ExitCode.SIGTERM,
  SIGHUP: ExitCode.SIGHUP,
} as const satisfies Record<string, ExitCodeValue>
export type SignalName = keyof typeof SIGNAL_EXIT_CODES

/**
 * Keyed by TurnEndReason, so a reason added to the protocol schema leaves this record short of a key
 * and fails `tsc -b` before any test runs. test/errors.test.ts pins the same thing at runtime against
 * protocol's own live table, for the case where the type is widened without the table being updated.
 *
 * `interrupted` is a one, decided here rather than left at zero. The design says only that it never
 * stands alone as a code of its own, and core writes no turn/end carrying it today, so nothing
 * observable changes either way. Zero is the one value a caller cannot check for: under `-p` there
 * is nobody in this process to have sent the steer an interruption would answer, so a terminal
 * `interrupted` means the turn the caller asked for did not finish, and reporting success for it is
 * the one mistake that cannot be caught downstream. Text mode prints the reason word beside every
 * non-zero exit, so a caller that considers it benign can still say so.
 *
 * `aborted` holds the SIGINT value because a Ctrl-C is what produces an abort with nobody to ask.
 * It is the row a signal overrides: shell convention is 128 plus the signal number, so a run stopped
 * by SIGTERM owes 143. That decision is not made here, because it is not a property of the reason --
 * a signalled run leaves with the signal's code whatever the turn managed to report first, which is
 * also the only way the ladder's own exit and the run's return can be the same number.
 * modes/print.ts makes it, from SIGNAL_EXIT_CODES above.
 */
export const REASON_EXIT_CODES: Record<TurnEndReason, ExitCodeValue> = {
  completed: ExitCode.OK,
  error: ExitCode.ERROR,
  parked: ExitCode.PARKED,
  budget: ExitCode.BUDGET,
  blocked: ExitCode.BUDGET,
  max_steps: ExitCode.MAX_STEPS,
  aborted: ExitCode.SIGINT,
  interrupted: ExitCode.ERROR,
}

/**
 * Total by construction. The argument is only as trustworthy as the daemon that produced it: a reason
 * this build has never heard of would otherwise return undefined, and `process.exit(undefined)` is a
 * success exit for something nobody could classify. Own-property lookup, so an inherited name such as
 * `toString` cannot be mistaken for a mapping either.
 *
 * There is deliberately no second fallback after the guard. Every own key of the record is a defined
 * ExitCodeValue, so a `?? ExitCode.ERROR` on the lookup would be a branch no input can reach and no
 * test can turn red -- protection that reads as protection and is not.
 */
export function exitCodeForReason(reason: TurnEndReason): ExitCodeValue {
  if (!Object.hasOwn(REASON_EXIT_CODES, reason)) return ExitCode.ERROR
  return (REASON_EXIT_CODES as Record<string, ExitCodeValue>)[reason] as ExitCodeValue
}

/** The user wrote something the grammar does not accept. Never raised for anything else. */
export class UsageError extends Error {
  readonly code = ExitCode.USAGE
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Startup could not produce a usable session. Same exit code as a usage error, different name. */
export class BootError extends Error {
  readonly code = ExitCode.USAGE
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'BootError'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * A command already reported per-item detail to the operator (one line per outcome) before this is
 * thrown; the message here is only the final "something failed" summary that decides the exit code,
 * not a diagnosis to print again. `bin.ts`'s catch-all gives this the same clean, stack-free
 * handling as UsageError/BootError, but at the generic ERROR code since it is not a usage mistake.
 */
export class CommandError extends Error {
  readonly code = ExitCode.ERROR
  constructor(message: string) {
    super(message)
    this.name = 'CommandError'
  }
}
