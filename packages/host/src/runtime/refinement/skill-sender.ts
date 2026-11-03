import type { WorkspaceSkills } from './skill-update.js'

/**
 * How one installer request reaches the process where resource control lives: for the requesting
 * session (that process takes the workspace from the session), answered with the installer's reply.
 */
export type RefinementSaveTransport = (
  sessionKey: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>

/** How many times an install is sent when its reply does not come back. */
export const SKILL_INSTALL_ATTEMPTS = 3
/** How long one request may take: an install waits for the skill to be ready. */
export const SKILL_REQUEST_TIMEOUT_MS = 5 * 60_000

/**
 * The save path's sender of installer requests.
 *
 * - An install whose reply is lost (the channel closed, the request timed out) is sent again, with the
 *   same receipt id: the installer resumes the same install from its journal, and never publishes
 *   twice. Nothing else is sent again: an update compares against the revision the save read, so a
 *   second attempt after a lost reply could read a skill it has just written as a person's change.
 *   When the reply of an update that did finish is lost, the save is recorded `unavailable`, the entry
 *   is not handed off, and the registry record keeps the previous save's `source` until the next save
 *   of that skill: taking it back still bars its lineage and name, but not the new content under
 *   another name.
 * - Before its first request for a session, it asks the installer to finish whatever a crash left
 *   unfinished in that session's workspace, and only while refinement is on.
 */
export function skillSender(
  transport: RefinementSaveTransport,
  options: { enabled: () => boolean; timeoutMs?: number },
): WorkspaceSkills['request'] {
  const recovered = new Set<string>()
  const send = (sessionKey: string, params: Record<string, unknown>) =>
    transport(sessionKey, params, AbortSignal.timeout(options.timeoutMs ?? SKILL_REQUEST_TIMEOUT_MS))
  const on = () => {
    try {
      return options.enabled() === true
    } catch {
      return false
    }
  }
  return async (sessionKey, params) => {
    if (!recovered.has(sessionKey) && on()) {
      recovered.add(sessionKey)
      // Bounded: the set only grows with sessions that saved a skill in this process.
      if (recovered.size > 1024) recovered.clear()
      await send(sessionKey, { op: 'recover' }).catch(() => undefined)
    }
    const attempts = params.op === 'install' ? SKILL_INSTALL_ATTEMPTS : 1
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(sessionKey, params)
      } catch (error) {
        if (attempt >= attempts) throw error
      }
    }
  }
}
