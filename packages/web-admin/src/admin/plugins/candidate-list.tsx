import type { AuthoringCandidate } from '@agnes/protocol'
import type { CandidateText } from './candidate-review.js'

/** Presentation facts come from the inspected candidate, never from its package name. */
export function candidateIdentity(value: AuthoringCandidate) {
  let manifest: { version?: unknown; agnes?: { contributions?: unknown; provides?: unknown } } | undefined
  try {
    manifest = JSON.parse(value.sourceFiles.find((file) => file.path === 'package.json')?.content ?? '{}')
  } catch {
    // Edited drafts can contain invalid JSON; leave their version unavailable.
  }
  const declared = manifest?.agnes?.contributions
  const kinds =
    value.preview?.presentation?.includes?.provides ??
    (Array.isArray(manifest?.agnes?.provides)
      ? manifest.agnes.provides
      : Array.isArray(declared) &&
          declared.length > 0 &&
          declared.every((item) => item && item.kind === 'skill')
        ? ['skills']
        : [])
  const type = Array.isArray(kinds) && kinds.length === 1 && kinds[0] === 'skills' ? 'skill' : 'plugin'
  const version =
    value.preview?.version ?? (typeof manifest?.version === 'string' ? manifest.version : undefined)
  return { type, version, change: value.baseHash === null ? `candidates.new.${type}` : 'candidates.update' }
}
/** Display-only fallback for authored Skills without package metadata. Never validates a candidate. */
export function candidateSkillText(value: AuthoringCandidate): { name?: string; summary?: string } {
  const file = value.sourceFiles.find((entry) => /(^|\/)SKILL\.md$/.test(entry.path))
  const header = file?.content.slice(0, 16 * 1024).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!header) return {}
  const scalar = (key: string, limit: number) => {
    const raw = header.match(new RegExp(`^${key}:[\\t ]*(.+)$`, 'm'))?.[1]?.trim()
    if (!raw || /^(?:[>|&*!{]|\[)/.test(raw)) return undefined
    let text = raw
    if (raw.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(raw)
        if (typeof decoded !== 'string') return undefined
        text = decoded
      } catch {
        return undefined
      }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) return undefined
      text = raw.slice(1, -1).replace(/''/g, "'")
    } else text = raw.replace(/\s+#.*$/, '')
    text = text.trim()
    const hasControl = Array.from(text).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    return text && text.length <= limit && !hasControl ? text : undefined
  }
  const name = scalar('name', 128),
    summary = scalar('description', 1024)
  return { ...(name ? { name } : {}), ...(summary ? { summary } : {}) }
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
