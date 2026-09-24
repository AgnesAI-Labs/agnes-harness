import type { ExtensionAPI } from '@agnes/extension-api'

export const CONSENT_LEVELS = ['DISABLED', 'LOCAL', 'ANON', 'FULL'] as const
export type ConsentLevel = (typeof CONSENT_LEVELS)[number]

export type ConsentTransition = { ok: true } | { ok: false; reason: string }

const rank = (level: ConsentLevel): number => CONSENT_LEVELS.indexOf(level)

/**
 * Consent may always be reduced. Increasing it is deliberately narrow: one tier at a time, with
 * the sole shortcut of opting directly into anonymised uploads.
 */
export function canTransition(from: ConsentLevel, to: ConsentLevel): ConsentTransition {
  if (rank(to) <= rank(from)) return { ok: true }
  if (to === 'ANON') return { ok: true }
  if (rank(to) === rank(from) + 1) return { ok: true }
  return { ok: false, reason: `${from} cannot transition directly to ${to}` }
}

/** Applies the transition rules which require the caller's explicit opt-in context. */
export function transitionConsent(
  from: ConsentLevel,
  to: ConsentLevel,
  opts: { explicit: boolean; by: string },
): ConsentTransition {
  const transition = canTransition(from, to)
  if (!transition.ok) return transition
  if (to === 'FULL' && !opts.explicit) return { ok: false, reason: 'FULL requires explicit consent' }
  return { ok: true }
}

export function allowsUpload(level: ConsentLevel): boolean {
  return level === 'ANON' || level === 'FULL'
}

export function allowsContent(level: ConsentLevel): boolean {
  return level === 'FULL'
}

/** Validates a consent change before recording the accepted state transition. */
export async function changeConsent(
  agnes: ExtensionAPI,
  from: ConsentLevel,
  to: ConsentLevel,
  by: string,
  explicit: boolean,
): Promise<ConsentTransition> {
  const transition = transitionConsent(from, to, { explicit, by })
  if (!transition.ok) return transition
  await agnes.events.append('consent', { from, to, by })
  return { ok: true }
}
