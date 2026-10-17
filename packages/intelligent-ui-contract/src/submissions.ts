/** Public compatibility adapter for authenticated surface answer facts. */
export type UiAnswers = Record<string, string | string[]>
export type UiAnswerFact =
  | { kind: 'received'; commandId: string; surfaceId: string; answers: UiAnswers }
  | { kind: 'succeeded'; commandId: string }
  | { kind: 'presented'; surfaceId: string }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** These names are protocol compatibility, not an implementation/package dispatch rule. */
export const UI_ANSWER_OWNER = 'agnes/intelligent-ui'
export const UI_SUBMIT_TOOL = 'ui_submit'
export const UI_ANSWER_EVENTS = [
  `x/${UI_ANSWER_OWNER}/action.received`,
  `x/${UI_ANSWER_OWNER}/action.succeeded`,
  `x/${UI_ANSWER_OWNER}/surface.opened`,
] as const

/** Only owner-authenticated facts count; prose, refusals and failed submissions never answer. */
export function readUiAnswerFact(event: {
  type: string
  origin: string
  data: unknown
}): UiAnswerFact | undefined {
  if (event.origin !== `ext:${UI_ANSWER_OWNER}` || !object(event.data)) return undefined
  if (event.type === UI_ANSWER_EVENTS[1] && typeof event.data.commandId === 'string')
    return { kind: 'succeeded', commandId: event.data.commandId }
  if (event.type === UI_ANSWER_EVENTS[2]) {
    const record = event.data.record
    if (
      object(record) &&
      record.status === 'open' &&
      object(record.surface) &&
      typeof record.surface.id === 'string' &&
      record.surface.id.length > 0 &&
      record.surface.id.length <= 64
    )
      return { kind: 'presented', surfaceId: record.surface.id }
  }
  if (event.type !== UI_ANSWER_EVENTS[0]) return undefined
  const record = event.data.record
  if (!object(record) || !object(record.request) || !object(record.invocation)) return undefined
  const args = record.invocation.args
  if (
    record.invocation.tool !== UI_SUBMIT_TOOL ||
    typeof record.request.commandId !== 'string' ||
    !object(args) ||
    typeof args.surfaceId !== 'string' ||
    args.surfaceId.length === 0 ||
    args.surfaceId.length > 64 ||
    !object(args.answers)
  )
    return undefined
  if (
    Object.entries(args.answers).length === 0 ||
    Object.entries(args.answers).length > 4 ||
    !Object.values(args.answers).every((value) =>
      typeof value === 'string'
        ? value.length > 0 && value.length <= 8192
        : Array.isArray(value) &&
          value.length > 0 &&
          value.length <= 12 &&
          value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 8192),
    )
  )
    return undefined
  return {
    kind: 'received',
    commandId: record.request.commandId,
    surfaceId: args.surfaceId,
    answers: args.answers as UiAnswers,
  }
}
