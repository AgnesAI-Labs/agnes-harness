// Context selection adapted from oh-my-pi; see LICENSE.oh-my-pi.
import type { PluginProjectionDef } from '@agnes/extension-api'
import { object } from '../questions.js'
import { formatTitleContext, section, TITLE_HEAD, TITLE_TAIL, type TitleTurn } from './title-format.js'
import { cleanTinyMessage, maskedTitleText } from './title-preprocess.js'

export const TITLE_CONTEXT = 'title.context'
type Role = 'user' | 'assistant'
type Drift = [Role, string]
type Anchor = { seq: number; text: string }
export type TitleState = {
  child: boolean
  seq: number
  judge: Drift[]
  judgeUser: string
  recent: TitleTurn[]
  opening: Anchor | null
  latest: Anchor | null
}
// JSON uses at most 6 bytes per UTF-16 unit. Judge tuples cost <=18 bytes each,
// with at most 3000 nonempty turns. The remaining bound covers exact key/number
// scaffolding for six 2-section turns, two anchors, and the scalar fields.
export const TITLE_STATE_BYTES =
  6 * (6 * 2 * (TITLE_HEAD + TITLE_TAIL) + 3000 + 1000 + 800) + 3000 * 18 + 4096
const blank = () => section('')
const textOf = (content: unknown, kind: string) =>
  Array.isArray(content)
    ? content
        .flatMap((block) =>
          object(block) &&
          block.type === kind &&
          typeof block.text === 'string' &&
          block.reference === undefined &&
          block.text.trim()
            ? [block.text.trim()]
            : [],
        )
        .join('\n\n')
    : ''
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
    apply(state, event) {
      const data = event.data
      if (
        event.type === 'session/start' &&
        event.origin === 'system' &&
        event.trust === 'trusted' &&
        object(data)
      ) {
        const child = ['parent', 'delegation', 'fork'].some((key) => Object.hasOwn(data, key))
        return child === state.child ? state : { ...state, child }
      }
      if (!object(data) || event.trust !== 'trusted' || event.seq <= state.seq) return state
      const user = event.type === 'user/message'
      if (
        user
          ? !isOperator(event.actor, event.origin, event.trust, data.kind ?? 'prompt')
          : event.type !== 'assistant/message' ||
            !['system', 'model'].includes(event.origin) ||
            !['end_turn', 'tool_use', 'max_tokens', 'refusal'].includes(String(data.stopReason))
      )
        return state
      const role: Role = user ? 'user' : 'assistant'
      const raw = textOf(data.content, 'text')
      const rawThinking = user ? '' : textOf(data.content, 'thinking')
      if (!raw && !rawThinking) return state
      const text = cleanTinyMessage(maskedTitleText(raw))
      const thinking = cleanTinyMessage(maskedTitleText(rawThinking))
      const drift: Drift | null = text ? [role, text.slice(0, 1000)] : null
      const judge = drift ? [...state.judge, drift] : state.judge
      let chars = judge.reduce((sum, item) => sum + item[1].length, 0)
      let start = 0
      while (chars > 3000 && start < judge.length - 1) {
        const oldest = judge[start++]
        if (!oldest) break
        chars -= oldest[1].length
      }
      const anchor = user ? { seq: event.seq, text: cleanTinyMessage(maskedTitleText(raw, true)) } : null
      return {
        ...state,
        seq: event.seq,
        judge: start ? judge.slice(start) : judge,
        judgeUser: user && drift ? drift[1] : state.judgeUser,
        recent: [
          ...state.recent,
          { seq: event.seq, role, text: section(text), thinking: section(thinking) },
        ].slice(-6),
        opening: state.opening ?? anchor,
        latest: anchor ?? state.latest,
      }
    },
  }
}
export function buildTitleDriftTurns(state: TitleState): { role: Role; text: string }[] {
  const turns = state.judge.map(([role, text]) => ({ role, text }))
  if (!state.judgeUser || turns.some((turn) => turn.role === 'user')) return turns
  let chars = turns.reduce((sum, turn) => sum + turn.text.length, 0),
    start = 0
  while (start < turns.length - 1 && chars + state.judgeUser.length > 3000) {
    const oldest = turns[start++]
    if (!oldest) break
    chars -= oldest.text.length
  }
  return [{ role: 'user', text: state.judgeUser }, ...turns.slice(start)]
}
export function buildReplanTitleContext(state: TitleState): string {
  const first = state.recent[0]?.seq ?? 0
  const anchors: Anchor[] = []
  if (state.opening && state.opening.seq < first) anchors.push(state.opening)
  if (
    state.latest &&
    state.latest.seq < first &&
    state.latest.seq !== state.opening?.seq &&
    !state.recent.some((turn) => turn.role === 'user')
  )
    anchors.push(state.latest)
  return formatTitleContext([
    ...anchors.map((anchor) => ({
      seq: anchor.seq,
      role: 'user' as const,
      text: section(anchor.text),
      thinking: blank(),
    })),
    ...state.recent,
  ])
}
