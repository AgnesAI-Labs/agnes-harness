import type { ComparisonSnapshot } from '@agnes/protocol'
import {
  type ComparisonRecord,
  type ComparisonStore,
  type RoundRecord,
  type RunRecord,
  type SessionObservation,
  SIDES,
  type TerminalCause,
} from './ports.js'

export class ComparisonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Only the submit branch before reservation may attest that this invocation admitted no input. */
    readonly rejectedInput?: Readonly<{ id: string; inputId: string; admissionReason?: string }>,
  ) {
    super(message)
    this.name = 'ComparisonError'
  }
}

// Host-owned workspace refusals only. Persisted error prose is never a public response.
const workspaceCreationCodes = new Set(
  [
    'INVALID_LIMIT',
    'INVALID_CONFIGURATION',
    'INVALID_ID',
    'INVALID_SOURCE',
    'INVALID_STORAGE',
    'WORKSPACE_OVERLAP',
    'SOURCE_CHANGED',
    'READ_DENIED',
    'SPECIAL_FILE_UNSUPPORTED',
    'SYMLINK_UNSUPPORTED',
    'SYMLINK_UNRESOLVED',
    'SYMLINK_EXCLUDED_TARGET',
    'EXTERNAL_REFERENCE_DENIED',
    'EXTERNAL_REFERENCE_UNSUPPORTED',
    'EXTERNAL_REFERENCE_CHANGED',
    'MANIFEST_INVALID',
    'SNAPSHOT_EXISTS',
    'SNAPSHOT_LIMIT',
    'COPY_FAILED',
    'CLEANUP_FAILED',
    'SNAPSHOT_FAILED',
  ].map((code) => `WORKSPACE_${code}`),
)

function creationError(code: unknown): ComparisonError {
  if (code === 'COMPARISON_PREPARATION_BUSY')
    return new ComparisonError(code, 'Comparison preparation is blocked by an existing configuration owner')
  if (code === 'COMPARISON_ISOLATION_REQUIRED' || code === 'COMPARISON_WRITABLE_OVERLAP')
    return new ComparisonError(code, 'Comparison isolation requirements were not met')
  return typeof code === 'string' && workspaceCreationCodes.has(code)
    ? new ComparisonError(code, `Comparison workspace preparation failed (${code})`)
    : new ComparisonError('COMPARISON_CREATE_FAILED', 'Comparison preparation failed')
}

/** Only a trusted adapter error and a fixed code may survive creation cleanup. */
export function creationFailure(error: unknown): ComparisonError {
  return creationError(error instanceof ComparisonError ? error.code : undefined)
}

/** Only producer-owned identifiers cross the public refusal boundary, never exception prose. */
export function admissionFailureReason(error: unknown): string {
  const value = error as { reason?: unknown; detail?: { reason?: unknown } } | null
  const reason = value?.reason ?? value?.detail?.reason
  return typeof reason === 'string' &&
    [
      'configuration-changed',
      'prepared-source-invalid',
      'runtime-publication-pending',
      'resource-admission-busy',
      'resource-admission-draining',
      'resource-recovery-required',
    ].includes(reason)
    ? reason
    : 'unknown'
}
/** Strict deterministic payload identity; JSON key order is irrelevant, array order is significant. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  throw new ComparisonError('INVALID_PAYLOAD', 'Comparison payload must contain only finite JSON values')
}
export function terminal(round: RoundRecord): boolean {
  return SIDES.every((side) => ['settled', 'skipped'].includes(round.runs[side].status))
}
const TERMINAL_CAUSES: readonly TerminalCause[] = ['finished', 'cancelled', 'failed', 'unknown']
export function terminalCause(run: RunRecord): TerminalCause {
  return run.terminalCause !== undefined && TERMINAL_CAUSES.includes(run.terminalCause)
    ? run.terminalCause
    : 'unknown'
}
export function validateObservation(state: SessionObservation): void {
  if (
    !Number.isSafeInteger(state.lastSeq) ||
    state.lastSeq < 0 ||
    (state.settled && !['idle', 'closed', 'failed'].includes(state.phase)) ||
    (!state.settled && state.terminalCause !== undefined) ||
    (state.terminalCause !== undefined && !TERMINAL_CAUSES.includes(state.terminalCause))
  )
    throw new ComparisonError('INVALID_OBSERVATION', 'Invalid session settlement observation')
}
export function comparisonPhase(record: ComparisonRecord): ComparisonSnapshot['phase'] {
  const round = record.rounds.at(-1)
  const allTerminal = round !== undefined && terminal(round)
  const incomplete =
    round !== undefined &&
    SIDES.some(
      (side) =>
        round.acceptances[side].status !== 'accepted' ||
        ['unknown', 'skipped'].includes(round.runs[side].status) ||
        record.lanes[side]?.phase === 'failed',
    )
  const causes = allTerminal ? SIDES.map((side) => terminalCause(round.runs[side])) : []
  return record.creation === 'failed'
    ? 'failed'
    : record.creation === 'preparing'
      ? 'preparing'
      : allTerminal && causes.every((cause) => cause === 'finished')
        ? 'completed'
        : allTerminal && causes.every((cause) => cause === 'cancelled')
          ? 'cancelled'
          : allTerminal || incomplete
            ? 'partial'
            : round === undefined
              ? 'ready'
              : 'running'
}
export function snapshot(record: ComparisonRecord): ComparisonSnapshot {
  if (record.retirement?.state === 'removed')
    throw new ComparisonError('COMPARISON_REMOVED', 'Comparison results have been removed')
  const { baseline } = record
  const left = record.lanes.left
  const right = record.lanes.right
  if (record.creation === 'failed' && (baseline === undefined || left === undefined || right === undefined))
    throw creationError(record.error?.code)
  if (baseline === undefined || left === undefined || right === undefined)
    throw new ComparisonError('COMPARISON_IN_PROGRESS', 'Comparison preparation is still pending')
  const phase = comparisonPhase(record)
  return structuredClone({
    id: record.id,
    revision: record.revision,
    phase,
    ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }),
    ...(record.retirement ? { storageState: record.retirement.state } : {}),
    baselineId: baseline.id,
    baselineDigest: baseline.digest,
    policyHash: baseline.policyHash,
    ...(record.prepared === undefined ? {} : { prepared: record.prepared }),
    ...(record.inputCancellations === undefined
      ? {}
      : {
          inputCancellations: record.inputCancellations.map((value) => ({
            inputId: value.inputId,
            states: SIDES.flatMap((side) =>
              value.sides[side] === undefined ? [] : [{ side, status: value.sides[side]! }],
            ),
          })),
        }),
    lanes: [left, right],
    rounds: record.rounds.map((item) => ({
      inputId: item.inputId,
      ...(item.permissionMode === undefined ? {} : { permissionMode: item.permissionMode }),
      ...(item.prepared === undefined ? {} : { prepared: item.prepared }),
      acceptances: SIDES.map((side) => item.acceptances[side]),
      settledSides: SIDES.filter((side) => item.runs[side].status === 'settled'),
      terminalCauses: SIDES.flatMap((side) =>
        ['settled', 'skipped'].includes(item.runs[side].status)
          ? [{ side, cause: terminalCause(item.runs[side]) }]
          : [],
      ),
    })),
    metrics: { state: 'unknown' },
  })
}
/** Historical reads retain ownership; a retirement fence permanently ends execution authority. */
export function assertComparisonActive(
  record: ComparisonRecord,
  rejectedInput?: Readonly<{ id: string; inputId: string }>,
): void {
  if (record.retirement !== undefined && record.retirement.state !== 'full')
    throw new ComparisonError(
      'COMPARISON_RETIRED',
      'Comparison execution has been permanently retired',
      rejectedInput,
    )
}
export async function read(store: ComparisonStore, id: string): Promise<ComparisonRecord> {
  const record = await store.read(id)
  if (record === undefined) throw new ComparisonError('COMPARISON_NOT_FOUND', 'Comparison does not exist')
  return record
}
export async function update(
  store: ComparisonStore,
  id: string,
  change: (record: ComparisonRecord) => void,
): Promise<ComparisonRecord> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const previous = await read(store, id)
    const next = structuredClone(previous)
    change(next)
    next.revision++
    if (!Number.isSafeInteger(next.revision))
      throw new ComparisonError('REVISION_EXHAUSTED', 'Comparison revision exhausted')
    if (await store.compareAndSwap(id, previous.revision, next)) return next
  }
  throw new ComparisonError('COMPARISON_BUSY', 'Comparison changed concurrently; retry reading its state')
}
