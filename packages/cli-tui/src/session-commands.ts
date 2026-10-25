import type { ContentBlock, UINode } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SessionChoice, SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'

/** Titles, snippets and prompts are external text: one inert line each. */
export const oneLine = (text: string): string => escapeControl(text).replace(/\s+/g, ' ').trim()

type HistoryHit = {
  sessionId: string
  title: string
  snippet: string
  ts: string
  seq?: number
  workspace?: string
}

/** The text of a turn's user prompt, as sent; the editor sanitizes it when it takes it. */
export function turnPrompt(nodes: readonly UINode[], ids: readonly string[]): string | undefined {
  const user = nodes.find((n) => n.kind === 'user' && ids.includes(n.id))
  if (user?.kind !== 'user') return undefined
  const text = (user.content as ContentBlock[]).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  return text.trim() ? text : undefined
}

function promptPreview(nodes: readonly UINode[], ids: readonly string[]): string | undefined {
  return oneLine(turnPrompt(nodes, ids) ?? '').slice(0, 80) || undefined
}

/** Completed turns the daemon will fork from: `forkable` marks a turn whose boundary is a turn/end. */
export async function rewindChoices(app: TuiApp): Promise<SessionChoice[]> {
  const { timeline } = await app.session.projectUIOpening({ surface: 'tui' })
  return timeline.turns
    .filter((t) => t.forkable && t.endSeq !== undefined)
    .reverse()
    .map((t) => {
      const title = promptPreview(timeline.nodes, t.nodeIds)
      const draft = turnPrompt(timeline.nodes, t.nodeIds)
      return {
        sessionId: app.session.id,
        createdAt: t.startedAt,
        lastSeq: t.endSeq as number,
        preset: null,
        forkAt: t.endSeq as number,
        ...(draft ? { draft } : {}),
        ...(title ? { title: `#${t.turn} ${title}` } : { title: `#${t.turn}` }),
      }
    })
}

/** The fork `/rewind` makes. The daemon forks only for the owner and only at a completed turn boundary. */
export const forkAt = (app: TuiApp, seq: number): Promise<Session> =>
  app.session.client.session.fork(app.session.id, seq)

/** `/fork [N]`: fork at the end of the latest completed turn (or turn N) and switch to the new session. */
export async function forkSlash(app: TuiApp, args: readonly string[]): Promise<SlashResult> {
  const locale = app.locale
  const n = args[0] === undefined ? undefined : Number(args[0])
  if (args.length > 1 || (n !== undefined && !(Number.isInteger(n) && n > 0)))
    return { text: tt('fork.usage', locale) }
  if (app.busy) return { text: tt('fork.busy', locale) }
  const session = app.session
  const { timeline } = await session.projectUIOpening({ surface: 'tui' })
  // A /resume or /new during the await leaves nothing to fork from.
  if (app.session !== session) return {}
  const turn =
    n === undefined ? timeline.turns.findLast((t) => t.forkable) : timeline.turns.find((t) => t.turn === n)
  if (!turn)
    return { text: tt(n === undefined ? 'fork.noTurns' : 'fork.notForkable', locale, { turn: n ?? 0 }) }
  if (!turn.forkable || turn.endSeq === undefined)
    return { text: tt('fork.notForkable', locale, { turn: turn.turn }) }
  const switchSession = await session.client.session.fork(session.id, turn.endSeq)
  return {
    switchSession,
    text: tt('fork.done', locale, { turn: turn.turn, id: escapeControl(session.id) }),
  }
}

/** The prompt of the completed turn that ends at `seq`. */
export async function rewindPrompt(app: TuiApp, seq: number): Promise<string | undefined> {
  const { timeline } = await app.session.projectUIOpening({ surface: 'tui' })
  const turn = timeline.turns.find((t) => t.endSeq === seq)
  return turn ? turnPrompt(timeline.nodes, turn.nodeIds) : undefined
}

/** /pin /unpin /rename /archive /search: every write goes through the daemon and echoes its refusal. */
export async function sessionSlash(app: TuiApp, cmd: string, line: string): Promise<SlashResult> {
  const locale = app.locale
  const s = app.session
  const rest = line.trim().slice(cmd.length).trim()
  switch (cmd) {
    case '/pin':
    case '/unpin':
      await s.client.session.pin(s.id, cmd === '/pin')
      return { text: tt(cmd === '/pin' ? 'session.pinned' : 'session.unpinned', locale) }
    case '/rename': {
      if (!rest) return { text: 'usage: /rename <title>' }
      const prefs = await s.client.session.rename(s.id, rest)
      return { text: tt('session.renamed', locale, { title: oneLine(prefs.title ?? rest) }) }
    }
    case '/archive':
      await s.client.session.archive(s.id, true)
      return { text: tt('session.archived', locale) }
    default: {
      if (!rest) return { text: tt('session.searchUsage', locale) }
      const result = await s.client.call<{ items: HistoryHit[] }>('_agnes/v1/admin.history.search', {
        query: rest,
        title: '',
        workspace: '',
      })
      const seen = new Set<string>()
      const sessionChoices: SessionChoice[] = []
      for (const hit of result.items) {
        if (seen.has(hit.sessionId)) continue
        seen.add(hit.sessionId)
        const label = [oneLine(hit.title), oneLine(hit.snippet)].filter(Boolean).join(' — ')
        sessionChoices.push({
          sessionId: hit.sessionId,
          createdAt: hit.ts,
          lastSeq: hit.seq ?? 0,
          preset: null,
          ...(hit.workspace ? { cwd: hit.workspace } : {}),
          ...(label ? { title: label } : {}),
        })
      }
      return sessionChoices.length
        ? { sessionChoices, sessionPickerTitle: 'picker.searchTitle' }
        : { text: tt('session.noMatches', locale) }
    }
  }
}
