import type { JsonValue, UiSurface } from '@agnes/protocol/gen/intelligent-ui'

/** One question of an ask_user_question form, read back from the form schema the tool published. */
export interface QuestionItem {
  id: string
  question: string
  /** Short name for the step chip and the answer summary. */
  label: string
  options: readonly string[]
  multiple: boolean
  /** Free text is accepted: either beside the options («Other») or as the only answer. */
  freeText: boolean
}
export interface QuestionForm {
  /** The form component whose input is submitted. */
  componentId: string
  actionId: string
  questions: readonly QuestionItem[]
  /** Epoch ms until which the tool waits for the answer; 0 when the agent did not wait. */
  deadline: number
}
export type QuestionAnswers = Record<string, string | string[]>

const MARKER = 'question'
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The question's own words, shortened to a step-chip label. Wide (CJK) characters count double. */
export function shortQuestionLabel(question: string, budget = 20): string {
  const text = question
    .trim()
    .replace(/[\s?？:：。.!！]+$/u, '')
    .replace(/\s+/g, ' ')
  let width = 0
  let out = ''
  for (const char of text) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(char) ? 2 : 1
    if (width > budget) {
      // Latin text breaks at the last whole word; CJK text has no spaces to break at.
      const space = /\s/.test(char) ? out.length : out.lastIndexOf(' ')
      return `${(space > 0 ? out.slice(0, space) : out).trimEnd()}…`
    }
    out += char
  }
  return out || question.slice(0, budget)
}

/**
 * A surface published by ask_user_question carries a `question` marker in its data. Anything else,
 * including an older question surface without the marker, is not a question card.
 */
export function questionForm(
  surface: Pick<UiSurface, 'components' | 'data' | 'actions'>,
): QuestionForm | undefined {
  const marker = surface.data[MARKER]
  if (!record(marker) || marker.kind !== 'ask_user_question') return undefined
  const form = surface.components.find((component) => component.kind === 'form' && !('fallback' in component))
  if (!form || form.kind !== 'form' || 'fallback' in form) return undefined
  const action = surface.actions.find(
    (item) => item.tool === 'ui_submit' && form.actionIds?.includes(item.id),
  )
  const schema = form.schema as Record<string, unknown>
  if (!action || !record(schema.properties)) return undefined
  const labels = record(marker.labels) ? marker.labels : {}
  const questions: QuestionItem[] = []
  // Stored surfaces are canonical JSON, so property order is lost; `required` keeps the asking order.
  const properties = schema.properties
  const asked = Array.isArray(schema.required)
    ? schema.required.filter((id): id is string => typeof id === 'string' && Object.hasOwn(properties, id))
    : []
  const order = [...asked, ...Object.keys(properties).filter((id) => !asked.includes(id))]
  for (const id of order) {
    const field = properties[id]
    if (!record(field)) return undefined
    const multiple = field.type === 'array'
    const item = multiple && record(field.items) ? field.items : field
    const choices = field['x-ui-choices']
    const options = Array.isArray(choices) ? choices.filter((value) => typeof value === 'string') : []
    const question = typeof field.title === 'string' && field.title ? field.title : id
    const label = typeof labels[id] === 'string' && labels[id] ? labels[id] : shortQuestionLabel(question)
    questions.push({ id, question, label, options, multiple, freeText: !Array.isArray(item.enum) })
  }
  if (!questions.length) return undefined
  return {
    componentId: form.id,
    actionId: action.id,
    questions,
    deadline: typeof marker.deadline === 'number' ? marker.deadline : 0,
  }
}

/** The answers held in the form draft, kept only where they have the shape the schema expects. */
export function draftAnswers(form: QuestionForm, input: JsonValue | undefined): QuestionAnswers {
  const out: QuestionAnswers = {}
  if (!record(input)) return out
  for (const question of form.questions) {
    const value = input[question.id]
    if (question.multiple && Array.isArray(value))
      out[question.id] = value.filter((item): item is string => typeof item === 'string')
    else if (!question.multiple && typeof value === 'string') out[question.id] = value
  }
  return out
}

export function isAnswered(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.some((item) => item.trim()) : !!value?.trim()
}

/** Free text beside the options: what the person wrote that is not one of the options. */
export function otherText(question: QuestionItem, value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.find((item) => !question.options.includes(item)) ?? ''
  return value !== undefined && !question.options.includes(value) ? value : ''
}

/** Selecting an option. A single choice replaces the free text; a multiple choice toggles. */
export function toggleOption(
  question: QuestionItem,
  value: string | string[] | undefined,
  option: string,
): string | string[] {
  if (!question.multiple) return option
  const current = Array.isArray(value) ? value : []
  return current.includes(option) ? current.filter((item) => item !== option) : [...current, option]
}

/** Typing «Other». A single choice becomes the text; a multiple choice keeps its options plus the text. */
export function withOtherText(
  question: QuestionItem,
  value: string | string[] | undefined,
  text: string,
): string | string[] {
  if (!question.multiple) return text
  const chosen = (Array.isArray(value) ? value : []).filter((item) => question.options.includes(item))
  return text ? [...chosen, text] : chosen
}

/** Answers ready to submit, trimmed of empty free text. Undefined until every question has one. */
export function completeAnswers(form: QuestionForm, answers: QuestionAnswers): QuestionAnswers | undefined {
  const out: QuestionAnswers = {}
  for (const question of form.questions) {
    const value = answers[question.id]
    if (!isAnswered(value)) return undefined
    out[question.id] = Array.isArray(value) ? value.filter((item) => item.trim()) : value!
  }
  return out
}
