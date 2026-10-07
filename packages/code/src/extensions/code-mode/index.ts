import { type Disposer, defineExtension, type ExtensionAPI } from '@agnes/extension-api'
import { processRuntime } from '../../runtime/process.js'
import { createBridge } from './bridge.js'
import { createRunCodeTool } from './run-code.js'

export const CODE_MODE_EXT_ID = 'agnes/code-mode' as const

/**
 * The event names this extension may emit under its own `x/agnes/code-mode/<name>` namespace
 * (code spec §6.1). This is a separate, code-package-local whitelist of event *names* — unrelated
 * to the manifest's `capabilities.events`, which is a single boolean permission ("may this
 * extension call `agnes.events.append` at all"), not a list of names.
 */
export const CODE_MODE_EVENTS = ['snapshot', 'kernel', 'sdk-skipped'] as const
export type CodeModeEvent = (typeof CODE_MODE_EVENTS)[number]

/** The extension delegates execution and all nested tool authority to public invocation ports. */
export default defineExtension((agnes: ExtensionAPI) => {
  const language = 'typescript' as const
  const runCode = createRunCodeTool({
    language,
    acquire: async (ctx) => {
      if (ctx.codeRuntime?.state === 'persistent')
        throw new Error('E_PRESET_UNSUPPORTED: this runtime supports stateless cells only')
      return processRuntime(ctx, ctx.codeRuntime?.language ?? language)
    },
    bridge: (ctx) =>
      createBridge(ctx, {
        maxParallel: ctx.codeRuntime?.maxParallelSubCalls ?? 4,
        maxCalls: 256,
        toolsOnly: true,
      }),
    limits: (ctx) => ({
      language: ctx.codeRuntime?.language ?? language,
      wallMs: Math.min(ctx.codeRuntime?.wallMs ?? ctx.timeoutMs, ctx.timeoutMs),
      maxOutputChars: ctx.codeRuntime?.maxOutputChars ?? ctx.outputMaxBytes,
      maxParallelSubCalls: ctx.codeRuntime?.maxParallelSubCalls ?? 4,
    }),
  })
  const disposers: Disposer[] = [
    agnes.registerTool(runCode),
    agnes.registerHook('session_start', async () => {
      await agnes.events.append('kernel', { alive: false })
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
})
