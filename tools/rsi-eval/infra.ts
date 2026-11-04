// Telling an infrastructure failure from a task failure, and keeping secrets out of what is recorded
// about one.
//
// A run whose upstream refused or failed to answer (no quota, bad key, rate limit, server error) never
// got the model to do the task; counting it as a failed run would put the provider's trouble in the
// results. The host reports the end of a turn in its ledger (`turn/end` with the error it ended on, after
// its own retries), and the usage proxy sees every upstream status; either is enough to call the run an
// infrastructure failure.
import type { InfraFailure, RunRecord } from './types.js'

/**
 * After this many runs in a row ended by the infrastructure, a shard stops instead of starting the next
 * run: the key, the balance or the upstream is the problem, and every further run would be one more
 * wasted attempt. Three is more than one bad moment and few enough to waste little.
 */
export const INFRA_STOP_AFTER = 3

/**
 * Counts runs ended by the infrastructure in a row. `record(true)` for a run it ended, `record(false)`
 * for one it did not; true once `limit` runs in a row were ended by it.
 */
export const createInfraStreak = (limit = INFRA_STOP_AFTER) => {
  let inARow = 0
  return {
    record(infraFailed: boolean): boolean {
      inARow = infraFailed ? inARow + 1 : 0
      return inARow >= limit
    },
    get stopped(): boolean {
      return inARow >= limit
    },
  }
}

/** HTTP statuses that mean the upstream, not the request, is the problem: credentials, quota, rate limit, server. */
export const isInfraStatus = (status: number): boolean =>
  status === 401 || status === 402 || status === 403 || status === 429 || (status >= 500 && status <= 599)

/** Error codes of a model call (`AiErrorCode`) that are the provider's or the network's doing. */
const INFRA_CODES: ReadonlySet<string> = new Set(['AUTH', 'QUOTA', 'RATE_LIMIT', 'TRANSPORT'])

const STATUS = /\bstatus=(\d{3})\b/

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The infrastructure failure a session's ledger ends in, if any: its last main-lane `turn/end` ended in
 * error with a provider error code (or an infrastructure HTTP status in the message). The host has retried
 * by then, so a rate limit here is one that persisted. A turn that completed, or ended some other way
 * (a task failure, a refused format, an abort), is not one.
 */
export const infraFromLedger = (rows: readonly unknown[], session = 0): InfraFailure | undefined => {
  let last: Json | undefined
  for (const row of rows) {
    if (!isObject(row) || row.type !== 'turn/end') continue
    if (row.lane !== null && row.lane !== undefined && row.lane !== '' && row.lane !== 'main') continue
    last = isObject(row.data) ? row.data : {}
  }
  if (last?.reason !== 'error' || !isObject(last.error)) return undefined
  const code = typeof last.error.code === 'string' ? last.error.code : ''
  const message = typeof last.error.message === 'string' ? last.error.message : ''
  const found = STATUS.exec(message)
  const status = found ? Number(found[1]) : undefined
  const byStatus = status !== undefined && isInfraStatus(status)
  if (!byStatus && !INFRA_CODES.has(code)) return undefined
  return {
    session,
    reason: `${code || 'ERROR'}${status === undefined ? '' : ` (HTTP ${status})`}`,
    ...(status === undefined ? {} : { status }),
  }
}

/** How many of the proxy's last answers for a run decide it: three in a row from the upstream. */
const STATUS_TAIL = 3

/**
 * The same from the statuses the proxy saw for a run, oldest first: the run's last answers were all
 * infrastructure statuses. For a run that ended without a readable ledger error.
 */
export const infraFromStatuses = (statuses: readonly number[], session = 0): InfraFailure | undefined => {
  const tail = statuses.slice(-STATUS_TAIL)
  if (tail.length < STATUS_TAIL || !tail.every(isInfraStatus)) return undefined
  const status = tail[tail.length - 1] as number
  return { session, reason: `HTTP ${status}`, status }
}

// ---------------------------------------------------------------- error bodies

/** How much of an upstream error body is kept. */
export const ERROR_BODY_CHARS = 500

const REDACTED = '[redacted]'

/**
 * `text` without anything that looks like a credential: the given secrets verbatim, `Bearer` tokens,
 * `sk-` style keys, values of key-like fields (`api_key`, `authorization`, `token`, `secret`,
 * `password`, in JSON or as `name=value`), and any long unbroken token. Headers are not part of what is
 * recorded, only the body, so this is a second line of defence.
 */
export const redactSecrets = (text: string, secrets: readonly string[] = []): string => {
  let out = text
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(REDACTED)
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /("?(?:x-)?(?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|token|secret|password)"?\s*[:=]\s*)("[^"]*"|[^\s,;}]+)/gi,
      (_m, name: string, value: string) => `${name}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/[A-Za-z0-9_+/=]{32,}/g, REDACTED)
}

/** The first `ERROR_BODY_CHARS` characters of a response body, secrets removed first, whitespace folded. */
export const errorBodyPreview = (body: string, secrets: readonly string[] = []): string => {
  const folded = redactSecrets(body, secrets).replace(/\s+/g, ' ').trim()
  return folded.length > ERROR_BODY_CHARS ? `${folded.slice(0, ERROR_BODY_CHARS)}...` : folded
}

/** The runs of a system that the upstream ended, per arm, with the reasons; none when there are none. */
export type InfraExcluded =
  | { on: number; off: number; oracle: number; reasons: Record<string, number> }
  | undefined
export const infraExcluded = (records: RunRecord[]): InfraExcluded => {
  const failed = records.filter((r) => r.infraFailed)
  if (failed.length === 0) return undefined
  const reasons: Record<string, number> = {}
  for (const r of failed)
    reasons[r.infraFailed?.reason ?? '?'] = (reasons[r.infraFailed?.reason ?? '?'] ?? 0) + 1
  return {
    on: failed.filter((r) => r.setting === 'on').length,
    off: failed.filter((r) => r.setting === 'off').length,
    oracle: failed.filter((r) => r.setting === 'oracle').length,
    reasons,
  }
}

export const infraMarkdown = (x: NonNullable<InfraExcluded>): string[] => [
  `Runs the upstream ended, not the task (quota, credentials, rate limit, server error), left out of every metric below: on ${x.on}, off ${x.off}, oracle ${x.oracle}.${
    Object.keys(x.reasons).length === 0
      ? ''
      : ` Reasons: ${Object.entries(x.reasons)
          .map(([reason, n]) => `${reason} x${n}`)
          .join(', ')}.`
  } They are redone when the run is started again.`,
  '',
]
