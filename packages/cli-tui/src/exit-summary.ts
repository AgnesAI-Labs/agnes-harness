import type { UITimeline } from '@agnes/protocol'
import type { Locale } from './locale.js'
import { tt } from './locale-extended.js'

/** What the loaded projection says about the session when the TUI leaves. */
export type TimelineFacts = {
  /** Messages the user sent; absent when older history was not loaded, since the count would be short. */
  messages?: number
  /** Approvals still waiting for an answer. */
  approvals: number
}

export function timelineFacts(value: UITimeline, hasEarlier: boolean): TimelineFacts {
  let messages = 0
  let approvals = 0
  for (const node of value.nodes) {
    if (node.kind === 'user') messages++
    else if (node.kind === 'approval' && node.state === 'pending') approvals++
  }
  return { ...(hasEarlier ? {} : { messages }), approvals }
}

/** `65_000` -> `1m 5s`; whole seconds, each larger unit shown only once it is non-zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h > 0 ? `${h}h` : '', h > 0 || m > 0 ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ')
}

/**
 * The lines printed above the resume hint: how long this run lasted and, when known, how many messages
 * the session holds; then one more line only if something is still waiting (an approval, queued input).
 */
export function exitSummaryLines(
  facts: TimelineFacts & { elapsedMs: number; queued: number },
  locale: Locale,
): string[] {
  const head = [
    tt('exit.ran', locale, { duration: formatDuration(facts.elapsedMs) }),
    ...(facts.messages === undefined ? [] : [tt('exit.messages', locale, { n: facts.messages })]),
  ].join(' · ')
  const waiting = [
    ...(facts.approvals > 0 ? [tt('exit.approvals', locale, { n: facts.approvals })] : []),
    ...(facts.queued > 0 ? [tt('exit.queued', locale, { n: facts.queued })] : []),
  ]
  return [head, ...(waiting.length > 0 ? [tt('exit.pending', locale, { items: waiting.join(', ') })] : [])]
}
