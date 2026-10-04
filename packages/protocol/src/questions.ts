import type { TSchema } from '@sinclair/typebox'
import { Value, ValueErrorType } from '@sinclair/typebox/value'
import type { QuestionAnswer, QuestionAnswerPolicy, QuestionRequest } from '../gen/ts/session-v1.js'
import {
  QuestionAnswer as answerSchema,
  QuestionAnswerPolicy as policySchema,
  QuestionRequest as requestSchema,
} from '../gen/ts/session-v1.js'

export type {
  Question,
  QuestionAnswer,
  QuestionAnswerItem,
  QuestionAnswerPolicy,
  QuestionIntent,
  QuestionOption,
  QuestionRequest,
} from '../gen/ts/session-v1.js'

export type QuestionValidationCode =
  | 'INVALID_SHAPE'
  | 'EMPTY_QUESTIONS'
  | 'DUPLICATE_QUESTION_ID'
  | 'DUPLICATE_OPTION_LABEL'
  | 'INTENT_OPTION_MISSING'
  | 'INTENT_DETAIL_MISSING'
  | 'INCOMPLETE_ANSWERS'
  | 'UNKNOWN_QUESTION_ID'
  | 'DUPLICATE_ANSWER_ID'
  | 'DUPLICATE_SELECTION'
  | 'OPTION_NOT_ALLOWED'
  | 'SINGLE_SELECT_LIMIT'
  | 'ANSWER_REQUIRED'
export type QuestionValidationError = Readonly<{
  target: 'request' | 'answer' | 'policy'
  /** JSON pointer relative to target; no question or answer content is echoed. */
  path: string
  code: QuestionValidationCode
}>
export type QuestionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly [QuestionValidationError] }

function invalid(
  target: QuestionValidationError['target'],
  path: string,
  code: QuestionValidationCode,
): QuestionValidationResult<never> {
  return { ok: false, errors: [{ target, path, code }] }
}

function invalidShape(
  target: QuestionValidationError['target'],
  schema: TSchema,
  value: unknown,
): QuestionValidationResult<never> {
  const error = Value.Errors(schema, value).First()
  // Unknown property names are caller-controlled; locate the object without echoing those names.
  const path =
    error?.type === ValueErrorType.ObjectAdditionalProperties
      ? error.path.slice(0, error.path.lastIndexOf('/'))
      : (error?.path ?? '')
  return invalid(target, path, 'INVALID_SHAPE')
}

/** Exact string identity, without trimming, Unicode normalization or arbitrary content limits. */
export function validateQuestionRequest(value: unknown): QuestionValidationResult<QuestionRequest> {
  if (!Value.Check(requestSchema, value)) return invalidShape('request', requestSchema, value)
  if (value.questions.length === 0) return invalid('request', '/questions', 'EMPTY_QUESTIONS')
  const ids = new Set<string>()
  for (const [index, question] of value.questions.entries()) {
    const path = `/questions/${index}`
    if (ids.has(question.id)) return invalid('request', `${path}/id`, 'DUPLICATE_QUESTION_ID')
    ids.add(question.id)
    const labels = new Set<string>()
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      if (labels.has(option.label))
        return invalid('request', `${path}/options/${optionIndex}/label`, 'DUPLICATE_OPTION_LABEL')
      labels.add(option.label)
    }
    if (question.intent !== undefined) {
      if (!labels.has(question.intent.approve))
        return invalid('request', `${path}/intent/approve`, 'INTENT_OPTION_MISSING')
      if (question.detail === undefined) return invalid('request', `${path}/detail`, 'INTENT_DETAIL_MISSING')
    }
  }
  return { ok: true, value }
}

/**
 * Stateless validation: rejection consumes no pending request. The owner handles lifetime, identity
 * and adoption separately. Returned answers retain their original text, selection order and IDs.
 */
export function validateQuestionAnswer(
  request: unknown,
  value: unknown,
  policy: QuestionAnswerPolicy,
): QuestionValidationResult<QuestionAnswer> {
  const checked = validateQuestionRequest(request)
  if (!checked.ok) return checked
  if (!Value.Check(policySchema, policy)) return invalidShape('policy', policySchema, policy)
  if (!Value.Check(answerSchema, value)) return invalidShape('answer', answerSchema, value)
  const questions = new Map(checked.value.questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  for (const [index, item] of value.answers.entries()) {
    const path = `/answers/${index}`
    const question = questions.get(item.id)
    if (question === undefined) return invalid('answer', `${path}/id`, 'UNKNOWN_QUESTION_ID')
    if (seen.has(item.id)) return invalid('answer', `${path}/id`, 'DUPLICATE_ANSWER_ID')
    seen.add(item.id)
    const labels = new Set(question.options?.map((option) => option.label))
    const selected = new Set<string>()
    for (const [selectionIndex, label] of item.selected.entries()) {
      if (selected.has(label))
        return invalid('answer', `${path}/selected/${selectionIndex}`, 'DUPLICATE_SELECTION')
      if (!labels.has(label))
        return invalid('answer', `${path}/selected/${selectionIndex}`, 'OPTION_NOT_ALLOWED')
      selected.add(label)
    }
    if (!question.multiSelect && item.selected.length > 1)
      return invalid('answer', `${path}/selected`, 'SINGLE_SELECT_LIMIT')
    if (!policy.allowSkip && item.selected.length === 0 && !item.custom?.trim())
      return invalid('answer', path, 'ANSWER_REQUIRED')
  }
  if (seen.size !== questions.size) return invalid('answer', '/answers', 'INCOMPLETE_ANSWERS')
  return { ok: true, value }
}
