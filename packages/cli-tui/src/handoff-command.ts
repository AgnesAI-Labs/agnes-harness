import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { listSessionChoices, type SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'
import { freshTuiSessionKey } from './session-key.js'
import { applySwitch, beginSwitch, endSwitch } from './session-switch.js'

/** The /btw question limit. */
const MAX_QUESTION = 4000

const INSTRUCTION =
  'Write a handoff summary of this conversation for a fresh session that will continue the work and sees nothing else. ' +
  'Use these sections, in this order: Goal; Done so far; Key decisions; Open items; Relevant files; Next step. ' +
  'Be concrete and brief. Do not call tools; answer in plain text.'

/** The fixed handoff instruction, with the user's note appended and cut so the whole stays within the /btw limit. */
export function handoffQuestion(note: string): string {
  if (!note) return INSTRUCTION
  const prefix = `${INSTRUCTION}\nThe user adds: `
  return `${prefix}${[...note].slice(0, MAX_QUESTION - [...prefix].length).join('')}`
}

/**
 * `/handoff [note]`: one read-only `session.btw` call over the whole conversation (billed on the session's
 * primary model route) writes the summary, which is previewed. Enter then opens a fresh session in the same
 * workspace, switches to it, titles it and sends the summary as its first prompt; Esc creates nothing. The
 * old session is not touched, and a failed call is shown as it comes.
 */
export async function handoffSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session: s } = app
  if (app.busy) return { text: tt('handoff.busy', locale) }
  app.statusBar.setNotice(tt('handoff.working', locale))
  app.renderer.requestRender()
  const answer = await s.client.session.btw(s.id, handoffQuestion(line.trim().replace(/^\S+\s*/, '')))
  // A session switch while the call ran leaves nothing to hand off from.
  if (app.session !== s) {
    app.statusBar.setNotice(undefined)
    return {}
  }
  const summary = answer.text.trim()
  const choices = await listSessionChoices(s).catch(() => [])
  const oldTitle = oneLine(choices.find((c) => c.sessionId === s.id)?.title ?? s.id)
  app.statusBar.setNotice(undefined)
  app.usagePanel.show(summary, tt('handoff.title', locale), {
    hint: tt('handoff.hint', locale),
    run: () => void open(app, s.id, oldTitle, summary).catch((error: unknown) => app.showError(error)),
  })
  return {}
}

async function open(app: TuiApp, oldId: string, oldTitle: string, summary: string): Promise<void> {
  const { locale, session: old } = app
  if (old.id !== oldId || app.refuseSwitch()) return
  const ticket = beginSwitch(app)
  const client = old.client
  let created: Session
  try {
    await client.workspace.add(app.cwd)
    created = await client.session.new({ cwd: app.cwd, sessionKey: freshTuiSessionKey(app.profile) })
  } catch (error) {
    endSwitch(app, ticket)
    throw error
  }
  if (!(await applySwitch(app, created, ticket))) return
  app.statusBar.setNotice(tt('handoff.sent', locale, { id: escapeControl(oneLine(oldId)) }), 'success')
  await client.session
    .rename(created.id, `${tt('handoff.titlePrefix', locale)}${oldTitle}`)
    .catch((error: unknown) => app.showError(error))
  app.prompted.add(created.id)
  void created
    .prompt(`${tt('handoff.intro', locale, { id: oldId })}\n\n${summary}`)
    .catch((error: unknown) => app.showError(error))
  if (!app.stopped) app.renderer.requestRender()
}
