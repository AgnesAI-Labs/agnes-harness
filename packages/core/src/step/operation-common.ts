import type { PromptSection } from '../request/contribute.js'
import type { OpContext, OperationEffectResult } from './session.js'

export type OperationCommon = {
  name: string
  /** Package-owned completion guidance, rendered only when Core admits the review round. */
  completionReviewNote?: () => string
  order?: number
  replay: 'safe' | 'never'
  applicable(ctx: OpContext): Promise<'applied' | 'skip' | 'not-applicable'>
  /** Additive-slot entry point retained for existing package/host operation factories. */
  run(ctx: OpContext): Promise<OperationEffectResult>
  contribute?(ctx: OpContext): {
    tools?: string[]
    promptSections?: PromptSection[]
    runtimeContext?: Record<string, unknown>
  }
}
