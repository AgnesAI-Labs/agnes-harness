import type { AuthoringCandidate } from '@agnes/protocol'
import type { CandidateText } from './candidate-review.js'

/** Presentation facts come from the inspected candidate, never from its package name. */
export function candidateIdentity(value: AuthoringCandidate) {
  let manifest: { version?: unknown; agnes?: { kinds?: unknown } } | undefined
  try {
    manifest = JSON.parse(value.sourceFiles.find((file) => file.path === 'package.json')?.content ?? '{}')
  } catch {
    // Edited drafts can contain invalid JSON; leave their version unavailable.
  }
  const kinds = value.preview?.kinds ?? manifest?.agnes?.kinds
  const type = Array.isArray(kinds) && kinds.length === 1 && kinds[0] === 'skills' ? 'skill' : 'plugin'
  const version =
    value.preview?.version ?? (typeof manifest?.version === 'string' ? manifest.version : undefined)
  return { type, version, change: value.baseHash === null ? `candidates.new.${type}` : 'candidates.update' }
}
export function CandidateListFacts({
  identity,
  startedAt,
  t,
  now = Date.now(),
}: {
  identity: ReturnType<typeof candidateIdentity>
  startedAt?: string | undefined
  t: CandidateText
  now?: number
}) {
  const timestamp = startedAt ? Date.parse(startedAt) : NaN
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  const time = !Number.isFinite(timestamp)
    ? undefined
    : minutes < 1
      ? t('candidates.justNow')
      : minutes < 60
        ? t('candidates.minutesAgo', { count: minutes })
        : minutes < 1440
          ? t('candidates.hoursAgo', { count: Math.floor(minutes / 60) })
          : t('candidates.daysAgo', { count: Math.floor(minutes / 1440) })
  return (
    <span className="candidate-list-facts" data-testid="candidate-list-facts">
      <span>
        {t(`candidates.type.${identity.type}`)} · {t(identity.change)}
        {identity.version ? ` · ${identity.version}` : ''}
      </span>
      {time ? (
        <time dateTime={startedAt} title={startedAt} data-testid="candidate-origin-time">
          {t('candidates.originTime', { time })}
        </time>
      ) : (
        <span>{t('candidates.timeUnavailable')}</span>
      )}
    </span>
  )
}
