import { type Disposer, defineExtension, type ExtensionAPI } from '@agnes/extension-api'
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

/**
 * code-mode's extension entry point (code spec §6.1). `agnes.extensions` in this package's
 * package.json points host's loader at this file via the manifest's `entry`.
 *
 * Registers `run_code` with a lifecycle dependency that refuses execution until wired.
 * The disclosure Operation lives outside this extension entirely — it reaches host through this
 * package's root `operations` named export, not through `registerTool`/`registerHook`.
 *
 * The `session_start` hook records that no Python kernel exists at the start of a session.
 */
const unwired = (): never => {
  throw new Error('E_PRESET_UNSUPPORTED: code runtime lifecycle is not wired yet')
}
const runCode = createRunCodeTool({ acquire: unwired, bridge: createBridge, limits: unwired })

export default defineExtension((agnes: ExtensionAPI) => {
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
