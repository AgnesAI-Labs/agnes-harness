import type { AppSessionContext } from '../app.js'

/** The longest focus the daemon takes. */
const MAX_FOCUS = 512
const REASONS = new Set(['child-session', 'closing', 'invalid', 'unpriced'])

type RefineContext = Pick<AppSessionContext, 'client' | 'current' | 'notice' | 't' | 'showError'>

export function isRefineCommand(input: string): boolean {
  return /^\/refine(?:\s|$)/u.test(input)
}

/**
 * `/refine [--workspace|--user] [--unpriced] [focus]`: asks the daemon for one background experience
 * review of the open conversation and says how it went in the notice line; with `--workspace` the
 * review's result is also saved to the workspace, with `--user` to user memory instead, as the user's
 * own save; `--unpriced` is the user's agreement to
 * plan on a model with no known price. A refusal because the switch is off (or not yet active in this
 * process), or because the model has no known price, gets its own hint.
 */
export async function runRefineCommand(context: RefineContext, input: string): Promise<void> {
  const say = (key: string, vars?: Record<string, string | number>) => {
    context.notice.setText(context.t(key, vars))
    context.notice.setKind('')
  }
  let focus = input.replace(/^\/refine\s*/u, '').trim()
  const flags = { workspace: false, user: false, unpriced: false }
  for (let flag = /^--(workspace|user|unpriced)(?:\s+|$)/u.exec(focus); flag; ) {
    flags[flag[1] as 'workspace' | 'user' | 'unpriced'] = true
    focus = focus.slice(flag[0].length)
    flag = /^--(workspace|user|unpriced)(?:\s+|$)/u.exec(focus)
  }
  const { workspace, user, unpriced } = flags
  // Counted in UTF-16 units, as the daemon counts it.
  if (focus.length > MAX_FOCUS) return say('app.refine.tooLong')
  if (workspace && user) return say('app.refine.both')
  const session = context.current
  if (!session) return say('app.refine.noSession')
  try {
    const asked = focus === '' ? undefined : focus
    const options = {
      ...(workspace ? { saveTo: 'workspace' as const } : {}),
      ...(user ? { saveTo: 'user' as const } : {}),
      ...(unpriced ? { allowUnpriced: true as const } : {}),
    }
    const { runId } =
      workspace || user || unpriced
        ? await context.client.session.refine(session.id, asked, options)
        : await context.client.session.refine(session.id, asked)
    say(workspace ? 'app.refine.workspace' : user ? 'app.refine.user' : 'app.refine.queued', { id: runId })
  } catch (error) {
    const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
    if ((error as { code?: unknown } | null)?.code === -32601) return say('app.refine.unsupported')
    if (data?.code !== 'SEMANTIC_REJECTED' || typeof data.reason !== 'string') return context.showError(error)
    // Off, switched on after this host started, or not connected to this session: one hint covers them.
    if (data.reason === 'refinement-off' || data.reason === 'unavailable') return say('app.refine.off')
    if (data.reason === 'unpriced') return say('app.refine.unpriced')
    const reason = REASONS.has(data.reason) ? context.t(`app.refine.reason.${data.reason}`) : data.reason
    say('app.refine.refused', { reason })
  }
}
