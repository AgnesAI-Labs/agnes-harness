import type { TuiApp } from './app.js'
import { localDirectory } from './cd-command.js'
import type { SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'

/**
 * `/add-dir <dir>`: a session's directories are fixed when it is created, so this registers the directory
 * and forks the session at its latest completed turn into a new one that also has it, then switches.
 * The old session is untouched and stays resumable.
 */
export async function addDirSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale } = app
  if (app.o.remote) return { text: tt('adddir.remote', locale) }
  const arg = line.trim().replace(/^\S+\s*/, '')
  if (!arg) return { text: tt('adddir.usage', locale) }
  const { dir, isDir } = await localDirectory(app, arg)
  if (!isDir) return { text: tt('cd.notDir', locale, { path: dir }) }
  if (app.busy) return { text: tt('fork.busy', locale) }
  const { timeline } = await app.session.projectUIOpening({ surface: 'tui' })
  const turn = timeline.turns.findLast((t) => t.forkable && t.endSeq !== undefined)
  if (turn?.endSeq === undefined) return { text: tt('adddir.noTurn', locale) }
  const client = app.session.client
  await client.workspace.add(dir)
  const created = await client.session.fork(app.session.id, turn.endSeq, { additionalDirectories: [dir] })
  return {
    switchSession: created,
    text: tt('adddir.forked', locale, {
      id: escapeControl(created.id),
      dir: escapeControl(dir),
      old: escapeControl(app.session.id),
    }),
  }
}
