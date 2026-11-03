import type { AppSessionContext } from '../app.js'

/** The longest focus the daemon takes. */
const MAX_FOCUS = 512
const REASONS = new Set(['child-session', 'closing', 'invalid', 'unpriced'])

type RefineContext = Pick<AppSessionContext, 'client' | 'current' | 'notice' | 't' | 'showError'>

export function isRefineCommand(input: string): boolean {
  return /^\/refine(?:\s|$)/u.test(input)
}

/**
 * `/refine [focus]`: asks the daemon for one background experience review of the open conversation and
 * says how it went in the notice line. A refusal because the switch is off (or not yet active in this
 * process) gets its own hint; `--workspace` is only answered, nothing is requested.
 */
export async function runRefineCommand(context: RefineContext, input: string): Promise<void> {
  const say = (key: string, vars?: Record<string, string | number>) => {
    context.notice.setText(context.t(key, vars))
    context.notice.setKind('')
  }
  const focus = input.replace(/^\/refine\s*/u, '').trim()
  if (/^--workspace(?:\s|$)/u.test(focus)) return say('app.refine.workspace')
  // Counted in UTF-16 units, as the daemon counts it.
  if (focus.length > MAX_FOCUS) return say('app.refine.tooLong')
  const session = context.current
  if (!session) return say('app.refine.noSession')
  try {
    const { runId } = await context.client.session.refine(session.id, focus === '' ? undefined : focus)
    say('app.refine.queued', { id: runId })
  } catch (error) {
    const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
    if ((error as { code?: unknown } | null)?.code === -32601) return say('app.refine.unsupported')
    if (data?.code !== 'SEMANTIC_REJECTED' || typeof data.reason !== 'string') return context.showError(error)
    // Off, switched on after this host started, or not connected to this session: one hint covers them.
    if (data.reason === 'refinement-off' || data.reason === 'unavailable') return say('app.refine.off')
    const reason = REASONS.has(data.reason) ? context.t(`app.refine.reason.${data.reason}`) : data.reason
    say('app.refine.refused', { reason })
  }
}
