import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'

/** The longest focus the daemon takes. */
const MAX_FOCUS = 512

type Reason = 'child-session' | 'closing' | 'invalid' | 'unpriced'
const REASON_KEYS = {
  'child-session': 'refine.reason.child-session',
  closing: 'refine.reason.closing',
  invalid: 'refine.reason.invalid',
  unpriced: 'refine.reason.unpriced',
} as const satisfies Record<Reason, Parameters<typeof tt>[0]>

const refusal = (error: unknown): { code?: unknown; reason?: unknown } | undefined => {
  const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
  return typeof data === 'object' && data !== null ? data : undefined
}

/**
 * `/refine [focus]`: asks the daemon for one background experience review of this session. What the
 * daemon refuses is explained here: the switch being off (or not yet active in this process) gets its
 * own hint, other refusals name their reason. `--workspace` is only answered; nothing is requested.
 */
export async function refineSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session } = app
  const rest = line.trim().replace(/^\S+\s*/u, '')
  if (/^--workspace(?:\s|$)/u.test(rest)) return { text: tt('refine.workspace', locale) }
  // Counted in UTF-16 units, as the daemon counts it.
  if (rest.length > MAX_FOCUS) return { text: tt('refine.tooLong', locale) }
  try {
    const { runId } = await session.client.session.refine(session.id, rest === '' ? undefined : rest)
    return { text: tt('refine.queued', locale, { id: runId }) }
  } catch (error) {
    const data = refusal(error)
    if ((error as { code?: unknown }).code === -32601) return { text: tt('refine.unsupported', locale) }
    if (data?.code !== 'SEMANTIC_REJECTED' || typeof data.reason !== 'string') throw error
    // Off, switched on after this host started, or not connected to this session: one hint covers them.
    if (data.reason === 'refinement-off' || data.reason === 'unavailable')
      return { text: tt('refine.off', locale) }
    const known = REASON_KEYS[data.reason as Reason]
    return { text: tt('refine.refused', locale, { reason: known ? tt(known, locale) : data.reason }) }
  }
}
