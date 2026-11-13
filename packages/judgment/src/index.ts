import type { PluginContextFacets } from '@agnes/extension-api'
import { resolveStopConfig } from './config.js'
import { createJudgmentRuntime } from './runtime.js'
import { registerStopDetection } from './uses/stop.js'
import { registerJudgmentTools } from './uses/tools.js'

export type { JudgmentAccounting } from './accounting.js'
export { createAnswerCache } from './cache.js'
export type { JudgeTarget, StopConfig } from './config.js'
export { CONFIG_SCHEMA, resolveJudgeChain, resolveStopConfig, resolveToolConfig } from './config.js'
export { nativePayload, splitRequest } from './encode.js'
export type { Judge, JudgeOptions, JudgeOutcome } from './judge.js'
export { createJudge, createRouteCooldown } from './judge.js'
export type * from './questions.js'
export { validateRequest } from './questions.js'
export type { JudgmentContext, JudgmentRuntime } from './runtime.js'
export { createJudgmentRuntime } from './runtime.js'
export type { JudgmentScheduler } from './scheduler.js'
export { createJudgmentScheduler } from './scheduler.js'
export { parseAnswers, renderPrompt } from './text-bridge.js'

export { registerJudgmentTools } from './uses/tools.js'

export const judgmentPlugin = {
  inject: ['hooks', 'projections', 'eventLog', 'sideCall', 'self', 'tools'] as const,
  apply(plugin: PluginContextFacets, config?: unknown) {
    const runtime = createJudgmentRuntime(plugin, config)
    const dispose = registerStopDetection(plugin, {
      config: () => resolveStopConfig(config),
      judge: (ctx) => runtime.judge(ctx),
    })
    const disposeTools = registerJudgmentTools(plugin, runtime, config)
    return () => {
      disposeTools()
      dispose()
      runtime.dispose()
    }
  },
}
