// Adapted from dsh-superagent (MIT)
/** Human-facing acknowledgement text shared by the tools of the main and executor sessions. */
import { z } from 'zod'
import { IM_WORDS, wordCount } from '../infra/text.js'

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (text) => wordCount(text) <= IM_WORDS,
    `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`,
  )
