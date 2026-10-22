import { dirname } from 'node:path'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { listSessionChoices } from './commands.js'
import { formatUsdMicros } from './format-usage.js'
import { tt } from './locale-extended.js'
import { waitingIn } from './queue-commands.js'
import { oneLine } from './session-commands.js'

const NONE = '-'

/** `/status`: what the footer and /cost, /context and /queue know, on one screen. A source that fails shows `-`. */
async function statusSlash(app: TuiApp): Promise<SlashResult> {
  const { locale, session: s } = app
  const [opening, choices, state] = await Promise.allSettled([
    s.projectUIOpening({ surface: 'tui', maxNodes: 1 }),
    listSessionChoices(s),
    s.controls(),
  ])
  const timeline = opening.status === 'fulfilled' ? opening.value.timeline : undefined
  const mine = choices.status === 'fulfilled' ? choices.value.find((c) => c.sessionId === s.id) : undefined
  const usage = timeline?.usage
  const cost = usage?.cost
    ? formatUsdMicros(usage.cost.usdMicros)
    : usage?.credits
      ? `${usage.credits.amount} credits`
      : NONE
  const context = usage
    ? `${usage.context.tokens} / ${usage.context.window} (${((usage.context.tokens / usage.context.window) * 100).toFixed(1)}%)`
    : NONE
  const remote = app.o.remote ?? false
  // The personal commands directory is `<AGH_HOME>/commands`; no separate home option is passed.
  const home = app.o.commandsDir && dirname(app.o.commandsDir)
  const rows: Array<[Parameters<typeof tt>[0], string]> = [
    ['status.session', oneLine(mine?.title ? `${s.id} · ${mine.title}` : s.id)],
    ['status.preset', oneLine(mine?.preset ?? NONE)],
    ['status.model', usage ? `${usage.model.route}/${usage.model.id} (${usage.model.thinking})` : NONE],
    ['status.cwd', oneLine(app.cwd)],
    // Over --connect this machine's home is not the daemon's: showing it would mislead.
    ['status.home', home && !remote ? oneLine(home) : NONE],
    ['status.connection', tt(remote ? 'status.remote' : 'status.local', locale)],
    ['status.context', context],
    ['status.cost', cost],
    ['status.queued', state.status === 'fulfilled' ? String(waitingIn(state.value.pending).length) : NONE],
    ['status.yolo', timeline ? tt(timeline.yolo ? 'status.on' : 'status.off', locale) : NONE],
  ]
  const labels = rows.map(([key]) => tt(key, locale))
  const width = Math.max(...labels.map((label) => [...label].length))
  return {
    text: rows.map(([, value], i) => `${(labels[i] as string).padEnd(width, ' ')}  ${value}`).join('\n'),
    presentation: 'transcript',
  }
}

/** The small commands that report on the session or hand work to the agent. */
export async function infoSlash(app: TuiApp, cmd: string, _line: string): Promise<SlashResult> {
  switch (cmd) {
    case '/status':
      return statusSlash(app)
    default:
      return {}
  }
}
