import type { UITurn } from '@agnes/protocol'

/**
 * What a failed turn is asking of the reader, derived from the code the daemon recorded.
 *
 * There is one sentence per class and one set of actions per class. A retry is offered only where
 * running the same input again can plausibly end differently; a rejected credential or a reached
 * budget limit is reported with the place that fixes it instead.
 */
export type TurnErrorKind =
  | 'auth'
  | 'quota'
  | 'rate'
  | 'timeout'
  | 'transport'
  | 'model'
  | 'context'
  | 'format'
  | 'workspace'
  | 'internal'
  | 'budget'
  | 'steps'
  | 'interrupted'
  | 'unknown'

export type TurnErrorAction = 'retry' | 'account' | 'model'

export interface TurnErrorDetail {
  code?: string
  reason?: string
  message?: string
}

export interface TurnErrorView {
  kind: TurnErrorKind
  actions: readonly TurnErrorAction[]
  /** Present only when the daemon sent an error object; the row then offers the raw record. */
  detail?: TurnErrorDetail
}

interface ClassRule {
  kind: TurnErrorKind
  actions: readonly TurnErrorAction[]
}

const RETRY: readonly TurnErrorAction[] = ['retry']
const ACCOUNT: readonly TurnErrorAction[] = ['account']
const MODEL: readonly TurnErrorAction[] = ['model']
const NONE: readonly TurnErrorAction[] = []

/** Exact matches only: a code is either known here or handled by the reason fallback below. */
const BY_CODE: Readonly<Record<string, ClassRule>> = {
  AUTH: { kind: 'auth', actions: ACCOUNT },
  PROVIDER_UNCONFIGURED: { kind: 'auth', actions: ACCOUNT },
  QUOTA: { kind: 'quota', actions: ACCOUNT },
  RATE_LIMIT: { kind: 'rate', actions: RETRY },
  TIMEOUT: { kind: 'timeout', actions: RETRY },
  TRANSPORT: { kind: 'transport', actions: RETRY },
  CONTRACT_MISMATCH: { kind: 'transport', actions: RETRY },
  NO_MODEL: { kind: 'model', actions: MODEL },
  NO_ADAPTER: { kind: 'model', actions: MODEL },
  OVERFLOW: { kind: 'context', actions: NONE },
  FORMAT: { kind: 'format', actions: RETRY },
  E_WORKSPACE_CLOSED: { kind: 'workspace', actions: NONE },
  E_FS_DENIED: { kind: 'workspace', actions: NONE },
  E_FS_IO: { kind: 'workspace', actions: NONE },
  E_FS_CHECK_FAILED: { kind: 'workspace', actions: NONE },
  E_STEP_FAILED: { kind: 'internal', actions: RETRY },
  E_RELATION: { kind: 'internal', actions: RETRY },
  E_LEDGER_INTEGRITY: { kind: 'internal', actions: RETRY },
  LEDGER_FAILED: { kind: 'internal', actions: RETRY },
  HOOK_BLOCKED: { kind: 'internal', actions: RETRY },
  CODE_RUNTIME_UNAVAILABLE: { kind: 'internal', actions: RETRY },
  INTERRUPTED: { kind: 'interrupted', actions: RETRY },
}

/** A turn can end without a code; `reason` is the only fact then. */
const BY_REASON: Readonly<Record<string, ClassRule>> = {
  budget: { kind: 'budget', actions: NONE },
  max_steps: { kind: 'steps', actions: NONE },
  interrupted: { kind: 'interrupted', actions: RETRY },
}

const UNKNOWN: ClassRule = { kind: 'unknown', actions: RETRY }

export function turnErrorView(turn: UITurn): TurnErrorView {
  const code = turn.error?.code
  const rule = (code === undefined ? undefined : BY_CODE[code]) ?? BY_REASON[turn.reason ?? ''] ?? UNKNOWN
  const detail: TurnErrorDetail | undefined = turn.error
    ? {
        code: turn.error.code,
        ...(turn.reason ? { reason: turn.reason } : {}),
        message: turn.error.message,
      }
    : undefined
  return { kind: rule.kind, actions: rule.actions, ...(detail ? { detail } : {}) }
}

export interface TurnErrorFacts {
  status?: string
  requestId?: string
}

/**
 * The two facts the adapter keeps when it redacts a provider error: a numeric HTTP status and a
 * request id. Nothing else in the message is safe or useful to put on the row.
 */
export function turnErrorMessageFacts(message: string | undefined): TurnErrorFacts {
  if (!message) return {}
  const status = /(?:^|\s)status=([1-5]\d{2})(?=\s|$)/.exec(message)?.[1]
  const requestId = /(?:^|\s)requestId=(\S+)/.exec(message)?.[1]
  return {
    ...(status ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  }
}
