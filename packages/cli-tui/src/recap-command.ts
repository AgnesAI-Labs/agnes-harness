import type { UIHistoryCursor, UINode, UIOpeningResult, UITimeline } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import { backgroundSessions } from './bg-command.js'
import { listSessionChoices, type SlashResult } from './commands.js'
import { padLine } from './component.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'
import { displayWidth } from './terminal.js'
import { latestPlan, type PlanStep } from './views/special-card.js'

const MAX_REQUEST = 200
const MAX_HISTORY_PAGES = 10

/** The last thing the user asked: one inert line, cut at 200 characters. System-injected inputs are not requests. */
export function lastRequest(nodes: readonly UINode[]): string | undefined {
  for (const node of nodes.toReversed()) {
    if (node.kind !== 'user' || node.origin === 'system') continue
    const text = oneLine(node.content.map((b) => (b.type === 'text' ? b.text : '')).join(' '))
    if (!text) continue
    const chars = [...text]
    return chars.length > MAX_REQUEST ? `${chars.slice(0, MAX_REQUEST).join('')}…` : text
  }
  return undefined
}

const attempt = <T>(work: () => Promise<T>): Promise<T | undefined> =>
  Promise.resolve()
    .then(work)
    .catch(() => undefined)

function formatTurnsValue(opening: UIOpeningResult, locale: string): string {
  const { timeline, history } = opening
  const windowTurns = timeline.turns.length
  const authoritativeTotal = (history as { totalTurns?: unknown } | undefined)?.totalTurns
  if (
    typeof authoritativeTotal === 'number' &&
    Number.isInteger(authoritativeTotal) &&
    authoritativeTotal >= 0
  ) {
    return String(authoritativeTotal)
  }
  if (!history?.hasEarlier) return String(windowTurns)
  const highestTurn = Math.max(
    timeline.opState?.turn ?? 0,
    ...timeline.turns.map((turn) => (typeof turn.turn === 'number' ? turn.turn : 0)),
  )
  if (locale === 'zh-CN') {
    return highestTurn > windowTurns
      ? `${highestTurn}（最近 ${windowTurns} 轮 / 部分历史）`
      : `最近 ${windowTurns} 轮 / 部分历史`
  }
  return highestTurn > windowTurns
    ? `${highestTurn} (recent ${windowTurns} turns / partial history)`
    : `recent ${windowTurns} turns / partial history`
}

async function resolveEarlierFacts(
  session: TuiApp['session'],
  opening: UIOpeningResult,
  initialRequest: string | undefined,
  initialPlan: PlanStep[] | undefined,
): Promise<{ request: string | undefined; plan: PlanStep[] | undefined }> {
  let request = initialRequest
  let plan = initialPlan
  if ((request && plan) || !opening.history?.hasEarlier) return { request, plan }
  if (typeof session.projectUIHistory !== 'function') return { request, plan }
  let cursor: UIHistoryCursor | undefined = opening.history.cursor
  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES && cursor && (!request || !plan); pageIndex++) {
    const page = await attempt(() => session.projectUIHistory(cursor as UIHistoryCursor))
    if (!page) break
    if (!request) request = lastRequest(page.nodes)
    if (!plan) plan = latestPlan({ ...opening.timeline, nodes: page.nodes })?.steps
    if (!page.hasEarlier) break
    cursor = page.cursor
  }
  return { request, plan }
}

/**
 * `/recap`: where the session stands, from data the TUI already reads for /status, /diff, /bg and
 * /schedule. It calls no model. An item that cannot be read, or that has nothing to report, is left out.
 */
export async function recapSlash(app: TuiApp): Promise<SlashResult> {
  const { locale, session: s } = app
  const [opening, choices, changes, scheduled] = await Promise.all([
    attempt(() => s.projectUIOpening({ surface: 'tui' })),
    attempt(() => listSessionChoices(s)),
    attempt(() => s.workspaceChanges({ scope: 'session' })),
    attempt(async () => {
      const { sessionKey } = await s.client.session.runtime(s.id)
      return (
        await s.client.call<{ schedules: unknown[] }>('_agnes/v1/schedules.list', {
          scope: 'session',
          sessionKey,
        })
      ).schedules.length
    }),
  ])
  const timeline: UITimeline | undefined = opening?.timeline
  const rows: Array<[Parameters<typeof tt>[0], string]> = []
  const title = choices?.find((c) => c.sessionId === s.id)?.title
  rows.push(['recap.session', oneLine(title ? `${title} (${s.id})` : s.id)])
  if (opening && timeline) {
    rows.push(['recap.turns', formatTurnsValue(opening, locale)])
    const { request, plan: steps } = await resolveEarlierFacts(
      s,
      opening,
      lastRequest(timeline.nodes),
      latestPlan(timeline)?.steps,
    )
    if (request) rows.push(['recap.request', request])
    if (steps?.length) {
      const doing = steps.find((step) => step.status === 'doing')
      const done = steps.filter((step) => step.status === 'done').length
      rows.push(['recap.plan', `${done}/${steps.length}${doing ? ` · ${oneLine(doing.text)}` : ''}`])
    }
  }
  if (changes?.files.length) rows.push(['recap.files', String(changes.files.length)])
  const background = backgroundSessions(app).length
  if (background > 0) rows.push(['recap.background', String(background)])
  if (scheduled) rows.push(['recap.schedules', String(scheduled)])
  const context = timeline?.usage?.context
  if (context?.window)
    rows.push([
      'recap.context',
      `${context.tokens} / ${context.window} (${((context.tokens / context.window) * 100).toFixed(1)}%)`,
    ])
  const labels = rows.map(([key]) => tt(key, locale))
  const width = Math.max(...labels.map(displayWidth))
  return {
    text: rows.map(([, value], i) => `${padLine(labels[i] as string, width)}  ${value}`).join('\n'),
    presentation: 'transcript',
  }
}
