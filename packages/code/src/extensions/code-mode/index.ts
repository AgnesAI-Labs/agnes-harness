import { type Disposer, defineExtension, type ExtensionAPI } from '@agnes/extension-api'
import { createBridge } from './bridge.js'
import { createRunCodeTool } from './run-code.js'

export const CODE_MODE_EXT_ID = 'agnes/code-mode' as const

/**
 * The event names this extension may emit under its own `x/agnes/code-mode/<name>` namespace
 * (code spec §6.1). This is a separate, code-package-local whitelist of event *names* — unrelated
 * to the manifest's `capabilities.events`, which is a single boolean permission ("may this
 * extension call `agnes.events.append` at all"), not a list of names. The stale Task 8 draft
 * conflated the two (writing `events` in the manifest as this array); R5 (2026-09-09) corrected
 * that — they stay apart here on purpose.
 */
export const CODE_MODE_EVENTS = ['snapshot', 'kernel', 'sdk-skipped'] as const
export type CodeModeEvent = (typeof CODE_MODE_EVENTS)[number]

/**
 * code-mode's extension entry point (code spec §6.1). `agnes.extensions` in this package's
 * package.json points host's loader at this file via the manifest's `entry`.
 *
 * Task 13 registers `run_code` here with an explicit loud-failure lifecycle dependency; Task 18
 * replaces that dependency with the actual session runtime lifecycle.
 *   - `before_compact` / `shutdown` hooks are registered by later tasks (code plan Tasks 20-22),
 *     once there is a real compaction and shutdown path to report on
 * The disclosure Operation lives outside this extension entirely — it reaches host through this
 * package's root `operations` named export, not through `registerTool`/`registerHook`.
 *
 * R5 (2026-09-09) forbids landing this as an empty no-op factory: a manifest nobody's code acts on
 * is not a shipped extension. So this task registers one real, minimal thing instead of nothing —
 * a `session_start` hook that records the plain fact that no Python kernel exists yet at the start
 * of a session. Task 20 owns that hook's long-term shape and may replace it once the kernel it
 * describes is real.
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
