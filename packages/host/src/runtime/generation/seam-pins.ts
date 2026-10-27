import { PINNED_SEAM_KINDS } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import type { SeamBinding } from '@agnes/host-providers/assemble/seam-rows'
import type { PinnedSeam } from '@agnes/package-manager'
import { type SessionVersionAction, type SessionVersionIssue, sessionVersionNotice } from '@agnes/protocol'

const PINNED = new Set<string>(PINNED_SEAM_KINDS)

/** The bindings a session keeps for its lifetime: only the kinds whose selection is pinned. */
export function pinnedBindings(bindings: readonly SeamBinding[]): readonly PinnedSeam[] {
  return bindings
    .filter((binding) => PINNED.has(binding.kind))
    .map(({ kind, provider, version, sourcePackage, integrity }) => ({
      kind,
      provider,
      version,
      sourcePackage,
      integrity,
    }))
}

export type PinDifference = Readonly<{ kind: string; from?: PinnedSeam; to?: PinnedSeam }>

const same = (a: PinnedSeam, b: PinnedSeam): boolean =>
  a.provider === b.provider &&
  a.version === b.version &&
  a.sourcePackage === b.sourcePackage &&
  a.integrity === b.integrity

/** Kinds whose implementation identity differs between two pinned sets, in kind order. */
export function diffPins(from: readonly PinnedSeam[], to: readonly PinnedSeam[]): readonly PinDifference[] {
  const kinds = [...new Set([...from, ...to].map((pin) => pin.kind))].sort()
  return kinds.flatMap((kind) => {
    const before = from.find((pin) => pin.kind === kind)
    const after = to.find((pin) => pin.kind === kind)
    if (before && after && same(before, after)) return []
    return [{ kind, ...(before ? { from: before } : {}), ...(after ? { to: after } : {}) }]
  })
}

const label = (pin: PinnedSeam | undefined): string =>
  pin ? `${pin.provider}@${pin.version} (${pin.sourcePackage})` : 'none'

export function describeDifferences(differences: readonly PinDifference[]): string {
  return differences.map((item) => `${item.kind}: ${label(item.from)} -> ${label(item.to)}`).join('; ')
}

/** A container's pinned bindings must be exactly what the session was bound to. */
export function assertPinsMatch(
  sessionKey: string,
  recorded: readonly PinnedSeam[] | undefined,
  actual: readonly PinnedSeam[],
): void {
  if (!recorded)
    throw seamPinError('corrupt', sessionKey, 'E_GENERATION_INTEGRITY', 'the session pin records no seams')
  const differences = diffPins(recorded, actual)
  if (!differences.length) return
  throw seamPinError('older', sessionKey, 'E_SEAM_PIN_MISMATCH', describeDifferences(differences), {
    kinds: differences.map((item) => item.kind),
  })
}

/** Refuses a migration that would swap a pinned seam unless the request names that kind. */
export function assertRepinConsented(
  sessionKey: string,
  differences: readonly PinDifference[],
  repin: readonly string[],
): readonly PinDifference[] {
  const unconsented = differences.filter((item) => !repin.includes(item.kind))
  if (unconsented.length)
    throw seamPinError('older', sessionKey, 'E_SEAM_PIN_CHANGE', describeDifferences(unconsented), {
      kinds: unconsented.map((item) => item.kind),
      differences: unconsented.map((item) => ({
        kind: item.kind,
        from: label(item.from),
        to: label(item.to),
      })),
    })
  return differences
}

/**
 * A refusal in one of the three directions. The message carries the machine code (so a bare log line
 * still says which rule fired) followed by the English text; the bilingual text and the follow-up
 * actions travel in `detail` for clients.
 */
export function seamPinError(
  issue: SessionVersionIssue,
  sessionKey: string,
  cause: string,
  reason: string,
  extra: Record<string, unknown> = {},
  ledgerPath?: string,
): HostError {
  const notice = sessionVersionNotice(issue, {
    sessionId: sessionKey,
    reason,
    repinnable: issue === 'older',
    ...(ledgerPath ? { ledgerPath } : {}),
  })
  return new HostError(notice.code, `${notice.message.en} [${cause}]`, {
    detail: {
      sessionKey,
      cause,
      issue,
      actions: notice.actions as readonly SessionVersionAction[],
      localized: notice.message,
      ...(ledgerPath ? { ledgerPath } : {}),
      ...extra,
    },
  })
}

/** How a generation failure maps onto the three directions, or undefined when it is something else. */
export function classifyGenerationFailure(error: unknown): SessionVersionIssue | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.match(/E_[A-Z0-9_]+/)?.[0]
  switch (code) {
    case 'E_GENERATION_SNAPSHOT_NEWER':
    case 'E_GENERATION_PIN_NEWER':
    case 'E_FORMAT_NEWER':
      return 'newer'
    case 'E_GENERATION_INCOMPATIBLE':
    case 'E_GENERATION_SNAPSHOT_MISSING':
    case 'E_GENERATION_SEAMS_MISSING':
    case 'E_GENERATION_UNTRUSTED':
    case 'E_SEAM_MISSING':
    case 'E_FORMAT_OLDER':
      return 'older'
    // Only a stored generation whose trust decision went stale is a version problem. Any other
    // workspace refusal (cwd outside the workspace, a binding mismatch) is a refusal, not an old session.
    case 'E_WORKSPACE_UNTRUSTED':
      return (error as { detail?: { generationRestore?: unknown } }).detail?.generationRestore === true
        ? 'older'
        : undefined
    case 'E_GENERATION_INTEGRITY':
    case 'E_GENERATION_CONFIG_INTEGRITY':
    case 'E_COMPOSITION_BINDING_INVALID':
    case 'E_GENERATION_RESOURCE_INTEGRITY':
    case 'E_FORMAT_CORRUPT':
    case 'E_LEDGER_INTEGRITY':
      return 'corrupt'
    default:
      return undefined
  }
}

/**
 * A session that cannot continue is told in one of three directions (newer, older, corrupt) with the
 * session id and where the raw ledger lives; a damaged durable record also names its file in `detail.file`.
 * Every storage-shape failure of generation or composition metadata arrives here as `corrupt`, while a
 * record written by a newer AGH stays `newer`. The original code stays in the message and the detail,
 * nothing durable is touched, and a failure that is not about versions passes through unchanged.
 */
export function translateSessionFailure(error: unknown, key: string): unknown {
  if (error instanceof HostError && /^E_(SESSION_|SEAM_PIN_)/.test(error.code)) return error
  const issue = classifyGenerationFailure(error)
  if (!issue) return error
  const message = error instanceof Error ? error.message : String(error)
  const cause = message.match(/E_[A-Z0-9_]+/)?.[0] ?? 'E_GENERATION'
  const detail = (error as { detail?: { location?: unknown } }).detail
  const file = (error as { file?: unknown }).file
  return seamPinError(
    issue,
    key,
    cause,
    message.replace(/^E_[A-Z0-9_]+:\s*/, '').slice(0, 240),
    typeof file === 'string' ? { file } : {},
    typeof detail?.location === 'string' ? detail.location : undefined,
  )
}
