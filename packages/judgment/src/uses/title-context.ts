import type { PluginProjectionDef, ProjectionEvent } from '@agnes/extension-api'
import { object } from '../questions.js'
import { formatTitleContext, section, TITLE_HEAD, TITLE_TAIL, type TitleTurn } from './title-format.js'
import { cleanTinyMessage, maskedTitleText } from './title-preprocess.js'

// Folded per-session view of the conversation used to judge title drift and to regenerate titles.

export const TITLE_CONTEXT = 'title.context'

type Speaker = 'user' | 'assistant'
type JudgeLine = [Speaker, string]
type Mark = { seq: number; text: string }

export type TitleState = {
  child: boolean
  seq: number
  judge: JudgeLine[]
  judgeUser: string
  recent: TitleTurn[]
  opening: Mark | null
  latest: Mark | null
}

/** Units of cleaned text kept per judge line. */
const LINE_UNITS = 1000
/** Total units of judge text kept across all lines. */
const JUDGE_UNITS = 3000
/** Number of recent turns kept for regeneration. */
const RECENT_TURNS = 6
/** Units of raw operator text kept in an anchor. */
const MARK_UNITS = 400

// Worst case: 6 JSON bytes per UTF-16 unit for all stored text, 18 bytes of framing per judge line, plus slack.
export const TITLE_STATE_BYTES =
  6 * (RECENT_TURNS * 2 * (TITLE_HEAD + TITLE_TAIL) + JUDGE_UNITS + LINE_UNITS + 2 * MARK_UNITS) +
  JUDGE_UNITS * 18 +
  4096

const FINISHED = new Set(['end_turn', 'tool_use', 'max_tokens', 'refusal'])

export function isOperator(actor: unknown, origin: unknown, trust: unknown, kind: unknown): boolean {
  return (
    origin === 'principal' &&
    trust === 'trusted' &&
    (kind === 'prompt' || kind === 'steer') &&
    object(actor) &&
    typeof actor.id === 'string' &&
    typeof actor.role === 'string' &&
    actor.role !== 'extension'
  )
}

/** Join the trimmed, non-blank, non-excerpt blocks of one type. */
function blockText(content: unknown, type: 'text' | 'thinking'): string {
  if (!Array.isArray(content)) return ''
  const pieces: string[] = []
  for (const block of content) {
    if (
      !object(block) ||
      block.type !== type ||
      typeof block.text !== 'string' ||
      block.reference !== undefined
    )
      continue
    const trimmed = block.text.trim()
    if (trimmed) pieces.push(trimmed)
  }
  return pieces.join('\n\n')
}

/** Drop the oldest lines while the text total exceeds the budget, always keeping the newest line. */
function withinBudget(lines: JudgeLine[]): JudgeLine[] {
  let total = 0
  for (const [, text] of lines) total += text.length
  let dropped = 0
  for (const [, text] of lines) {
    if (total <= JUDGE_UNITS || dropped >= lines.length - 1) break
    total -= text.length
    dropped++
  }
  return dropped > 0 ? lines.slice(dropped) : lines
}

function fold(state: Readonly<TitleState>, event: ProjectionEvent): TitleState {
  const data = event.data
  if (
    event.type === 'session/start' &&
    event.origin === 'system' &&
    event.trust === 'trusted' &&
    object(data)
  ) {
    const child =
      Object.hasOwn(data, 'parent') || Object.hasOwn(data, 'delegation') || Object.hasOwn(data, 'fork')
    return child === state.child ? state : { ...state, child }
  }
  if (!object(data) || event.trust !== 'trusted' || event.seq <= state.seq) return state
  const user = event.type === 'user/message'
  if (user) {
    if (!isOperator(event.actor, event.origin, event.trust, data.kind ?? 'prompt')) return state
  } else if (
    event.type !== 'assistant/message' ||
    (event.origin !== 'system' && event.origin !== 'model') ||
    !FINISHED.has(String(data.stopReason))
  )
    return state
  const role: Speaker = user ? 'user' : 'assistant'
  const rawText = blockText(data.content, 'text')
  const rawThinking = user ? '' : blockText(data.content, 'thinking')
  if (!rawText && !rawThinking) return state

  const text = cleanTinyMessage(maskedTitleText(rawText))
  const thinking = cleanTinyMessage(maskedTitleText(rawThinking))
  const line: JudgeLine | null = text ? [role, text.slice(0, LINE_UNITS)] : null
  const mark: Mark | null = user
    ? { seq: event.seq, text: cleanTinyMessage(maskedTitleText(rawText, true)) }
    : null
  return {
    ...state,
    seq: event.seq,
    judge: withinBudget(line ? [...state.judge, line] : state.judge),
    judgeUser: user && line ? line[1] : state.judgeUser,
    recent: [
      ...state.recent,
      { seq: event.seq, role, text: section(text), thinking: section(thinking) },
    ].slice(-RECENT_TURNS),
    opening: state.opening ?? mark,
    latest: mark ?? state.latest,
  }
}

export function createTitleProjection(): PluginProjectionDef<TitleState> {
  return {
    name: TITLE_CONTEXT,
    stateVersion: 1,
    inputEventTypes: ['session/start', 'user/message', 'assistant/message'],
    maxStateBytes: TITLE_STATE_BYTES,
    stateSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['child', 'seq', 'judge', 'judgeUser', 'recent', 'opening', 'latest'],
      properties: {
        child: { type: 'boolean' },
        seq: { type: 'integer' },
        judge: { type: 'array' },
        judgeUser: { type: 'string' },
        recent: { type: 'array' },
        opening: {},
        latest: {},
      },
    },
    init: () => ({ child: false, seq: 0, judge: [], judgeUser: '', recent: [], opening: null, latest: null }),
    apply: fold,
  }
}

export function buildTitleDriftTurns(state: TitleState): { role: Speaker; text: string }[] {
  const turns = state.judge.map(([role, text]) => ({ role, text }))
  if (!state.judgeUser || turns.some((turn) => turn.role === 'user')) return turns
  // No operator turn survived the budget: put the latest request back in front, making room for it.
  let total = 0
  for (const turn of turns) total += turn.text.length
  let dropped = 0
  for (const turn of turns) {
    if (dropped >= turns.length - 1 || total + state.judgeUser.length <= JUDGE_UNITS) break
    total -= turn.text.length
    dropped++
  }
  return [{ role: 'user', text: state.judgeUser }, ...turns.slice(dropped)]
}

export function buildReplanTitleContext(state: TitleState): string {
  const [oldest] = state.recent
  const first = oldest ? oldest.seq : 0
  const marks: Mark[] = []
  if (state.opening && state.opening.seq < first) marks.push(state.opening)
  if (
    state.latest &&
    state.latest.seq < first &&
    state.latest.seq !== state.opening?.seq &&
    !state.recent.some((turn) => turn.role === 'user')
  )
    marks.push(state.latest)
  const anchors = marks.map(
    (mark): TitleTurn => ({ seq: mark.seq, role: 'user', text: section(mark.text), thinking: section('') }),
  )
  return formatTitleContext([...anchors, ...state.recent])
}
