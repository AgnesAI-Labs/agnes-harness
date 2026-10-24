import type { Session } from '@agnes/sdk'
import { CommandError } from '../errors.js'

/**
 * Narrows the session before anything else can run in it. A daemon that predates the method answers
 * METHOD_NOT_FOUND; that is reported as such and the run stops, because carrying on would give the
 * agent every tool the user asked to take away.
 */
export async function applyToolFilter(
  session: Pick<Session, 'setToolFilter'>,
  filter: { allow?: string[]; deny?: string[] },
): Promise<void> {
  try {
    await session.setToolFilter(filter)
  } catch (error) {
    const e = error as { code?: unknown; data?: { code?: unknown; reason?: unknown; names?: unknown } } | null
    if (e?.code === -32601)
      throw new CommandError(
        "this daemon cannot limit a session's tools (it has no session.setToolFilter), so --tools and --disallowed-tools were not applied and no prompt was sent; update the daemon or run without them",
      )
    if (e?.data?.code === 'TOOL_FILTER_REJECTED') {
      const names = Array.isArray(e.data.names) ? e.data.names.map(String).join(', ') : ''
      throw new CommandError(
        e.data.reason === 'unknown-tool'
          ? `--tools/--disallowed-tools name tools this session does not have: ${names}; no prompt was sent`
          : 'the daemon refused the tool list; no prompt was sent',
      )
    }
    throw error
  }
}
