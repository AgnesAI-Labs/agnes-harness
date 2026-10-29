import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { inheritFreshSession } from './composer-memory.js'
import { tt } from './locale-extended.js'
import { freshTuiSessionKey } from './session-key.js'

/** The path a slash argument names on this machine: `~` expanded, otherwise relative to the session workspace. */
export const localPath = (app: TuiApp, arg: string): string =>
  resolve(app.cwd, arg === '~' || arg.startsWith('~/') ? homedir() + arg.slice(1) : arg)

/** The directory a slash argument names on this machine (`~`, or relative to the session workspace), and whether it exists. */
export async function localDirectory(app: TuiApp, arg: string): Promise<{ dir: string; isDir: boolean }> {
  const dir = localPath(app, arg)
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  )
  return { dir, isDir }
}

/**
 * `/cd <dir>`: the workspace of a session cannot change, so this registers the directory and opens a fresh
 * session there, then switches to it. The old session stays resumable; its conversation does not follow
 * (`/handoff` carries context). The new directory is its own, untrusted workspace.
 */
export async function cdSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale } = app
  if (app.o.remote) return { text: tt('cd.remote', locale) }
  const arg = line.trim().replace(/^\S+\s*/, '')
  if (!arg) return { text: tt('cd.usage', locale) }
  const { dir, isDir } = await localDirectory(app, arg)
  if (!isDir) return { text: tt('cd.notDir', locale, { path: dir }) }
  if (dir === resolve(app.cwd)) return { text: tt('cd.same', locale, { dir }) }
  const client = app.session.client
  await client.workspace.add(dir)
  const created = await client.session.new({ cwd: dir, sessionKey: freshTuiSessionKey(app.profile) })
  const inherited = await inheritFreshSession(created, app.composerSelectionPath, undefined, locale)
  const notice = tt('cd.switched', locale, { dir, old: app.session.id })
  return { switchSession: created, text: inherited.notice ? `${notice}\n${inherited.notice}` : notice }
}
