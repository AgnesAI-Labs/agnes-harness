import type { AdminFeedbackParams, AdminFeedbackResult } from '@agnes/protocol/gen/app-server'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'

const MAX_NOTE = 4000
const METHOD = '_agnes/v1/admin.feedback'

const unavailable = (error: unknown): boolean => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return code === 'METHOD_NOT_FOUND' || code === 'CAPABILITY_DENIED'
}

/**
 * `/rate up|down [reason]`: rates the newest settled reply of this session with the daemon method the
 * Web thumbs use (`admin.feedback`). The target is that reply's message sequence and turn, so rating
 * the same reply again replaces the earlier rating instead of adding one.
 */
export async function rateSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session: s } = app
  const found = /^\/rate\s+(up|down)(?:\s+([\s\S]+))?$/.exec(line.trim())
  if (!found) return { text: tt('rate.usage', locale) }
  const rating = found[1] as 'up' | 'down'
  const note = found[2]?.trim() ?? ''
  if (note.length > MAX_NOTE) return { text: tt('rate.tooLong', locale, { max: MAX_NOTE }) }
  const { timeline } = await s.projectUIOpening({ surface: 'tui' })
  // Same test as the Web: the turn's final answer, finished, and not one inherited from a fork parent.
  const turn = [...timeline.turns]
    .reverse()
    .find((t) => t.status !== 'running' && t.status !== 'waiting' && !t.inherited && t.finalAssistantId)
  const answer = timeline.nodes.find(
    (n) => n.kind === 'assistant' && n.id === turn?.finalAssistantId && !n.streaming && n.seq > 0,
  )
  if (!turn || !answer || answer.kind !== 'assistant') return { text: tt('rate.none', locale) }
  const target = { messageSeq: answer.seq, turn: turn.turn }
  try {
    const call = (params: AdminFeedbackParams) => s.client.call<AdminFeedbackResult>(METHOD, params)
    const before = (await call({ action: 'list', sessionId: s.id })).items.find(
      (item) => item.target.messageSeq === target.messageSeq && item.target.turn === target.turn,
    )
    await call({
      action: 'put',
      sessionId: s.id,
      target,
      ...(before ? { id: before.id } : {}),
      expectedRevision: before?.revision ?? null,
      rating,
      category: '',
      note,
    })
  } catch (error) {
    if (unavailable(error)) return { text: tt('rate.unsupported', locale) }
    throw error
  }
  return { text: tt('rate.done', locale, { rating, turn: turn.turn }) }
}
