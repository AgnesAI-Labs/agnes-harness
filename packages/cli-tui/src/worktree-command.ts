import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { inheritFreshSession } from './composer-memory.js'
import { tt } from './locale-extended.js'
import { freshTuiSessionKey } from './session-key.js'
import { cleanupWorktree, createWorktree, outcomeLine, startedNotices } from './worktree.js'

/**
 * `/worktree [name]`: the workspace of a session cannot change, so this makes a git worktree on a new
 * `agh/<name>` branch, registers it, opens a fresh session there and switches to it. The old session stays
 * resumable. The new path is its own, untrusted workspace; trust is never copied from the checkout.
 */
export async function worktreeSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale } = app
  if (app.o.remote) return { text: tt('worktree.remote', locale) }
  const name = line.trim().replace(/^\S+\s*/, '')
  const info = await createWorktree(app.cwd, name || undefined, locale)
  const client = app.session.client
  try {
    await client.workspace.add(info.path)
    const created = await client.session.new({ cwd: info.path, sessionKey: freshTuiSessionKey(app.profile) })
    const inherited = await inheritFreshSession(created, app.composerSelectionPath, undefined, locale)
    app.worktrees.adopt(created.id, info)
    app.worktrees.queueNotes(startedNotices(info, locale))
    return { switchSession: created, ...(inherited.notice ? { text: inherited.notice } : {}) }
  } catch (error) {
    // Nothing was started in it, so it has no changes: take it back out.
    await cleanupWorktree(info)
    throw error
  }
}

/** After any session switch: leaves the previous worktree behind (removing it if clean) and shows the new one. */
export async function worktreeSwitched(app: TuiApp, sessionId: string): Promise<void> {
  const left = await app.worktrees.switched(sessionId)
  app.refreshWorkspace()
  const lines = [...(left ? [outcomeLine(left, app.locale)] : []), ...app.worktrees.takeNotes()]
  if (lines.length > 0) app.noteLocal('/worktree', lines.join('\n'))
}
