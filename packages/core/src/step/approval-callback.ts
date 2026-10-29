import { isDateTime } from '@agnes/protocol'
import type { DecisionAnswerContext, DecisionCommands } from './decisions.js'

export type HumanAnswerContext = DecisionAnswerContext
export type HumanAnswerCommand = Parameters<DecisionCommands['answer']>[0]

/** Invalid deadlines are already due. */
export const approvalDeadlineMs = (value: string): number =>
  isDateTime(value) ? Date.parse(value) : Number.NaN
