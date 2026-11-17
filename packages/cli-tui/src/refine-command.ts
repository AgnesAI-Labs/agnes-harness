import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'

/** The longest focus the daemon takes. */
const MAX_FOCUS = 512

/** The leading flags of `/refine`, in any order, and the focus after them. */
export function refineArgs(args: string): {
  workspace: boolean
  user: boolean
  unpriced: boolean
  focus: string
} {
  let rest = args
  const seen = { workspace: false, user: false, unpriced: false }
  for (;;) {
    const flag = /^--(workspace|user|unpriced)(?:\s+|$)/u.exec(rest)
    if (!flag) break
    seen[flag[1] as 'workspace' | 'user' | 'unpriced'] = true
    rest = rest.slice(flag[0].length)
  }
  return { ...seen, focus: rest }
}

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
 * `/refine [--workspace|--user] [--unpriced] [focus]`: asks the daemon for one background experience
 * review of this session; with `--workspace` the review's result is also saved to the workspace, with
 * `--user` to user memory (read in every workspace) instead, as your own save; `--unpriced` is your agreement to plan on a model with no known price. What the daemon refuses
 * is explained here: the switch being off (or not yet active in this process) and a model with no known
 * price get their own hints, other refusals name their reason.
 */
export async function refineSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session } = app
  const { workspace, user, unpriced, focus: rest } = refineArgs(line.trim().replace(/^\S+\s*/u, ''))
  // Counted in UTF-16 units, as the daemon counts it.
  if (rest.length > MAX_FOCUS) return { text: tt('refine.tooLong', locale) }
  if (workspace && user) return { text: tt('refine.both', locale) }
  try {
    const focus = rest === '' ? undefined : rest
    const options = {
      ...(workspace ? { saveTo: 'workspace' as const } : {}),
      ...(user ? { saveTo: 'user' as const } : {}),
      ...(unpriced ? { allowUnpriced: true as const } : {}),
    }
    const { runId } =
      workspace || user || unpriced
        ? await session.client.session.refine(session.id, focus, options)
        : await session.client.session.refine(session.id, focus)
    return {
      text: tt(workspace ? 'refine.workspace' : user ? 'refine.user' : 'refine.queued', locale, {
        id: runId,
      }),
    }
  } catch (error) {
    const data = refusal(error)
    if ((error as { code?: unknown }).code === -32601) return { text: tt('refine.unsupported', locale) }
    if (data?.code !== 'SEMANTIC_REJECTED' || typeof data.reason !== 'string') throw error
    // Off, switched on after this session opened, or not connected to this session: one hint covers them.
    if (data.reason === 'refinement-off' || data.reason === 'unavailable')
      return { text: tt('refine.off', locale) }
    if (data.reason === 'unpriced') return { text: tt('refine.unpriced', locale) }
    const known = REASON_KEYS[data.reason as Reason]
    return { text: tt('refine.refused', locale, { reason: known ? tt(known, locale) : data.reason }) }
  }
}
