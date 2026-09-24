import type { Disposer } from './common.js'
import type { ExtensionAPI } from './extension.js'
import type { HOOK_TABLE } from './generated/hook-table.js'
import type { HookEvent, HookHandler } from './hooks.js'

/** Events whose kernel table entry is observe-only: the handler result is never used. */
export type ObserveHookEvent = {
  [E in HookEvent]: (typeof HOOK_TABLE)[E]['category'] extends 'observe' ? E : never
}[HookEvent]

/**
 * What a plugin row receives from `ctx.extension()`: tools, any of the 17 hook events (`on` for
 * observe-only convenience, `registerHook` for the full transform/intercept chain), and ledger
 * events. Slots, services, projections and resources remain refused at runtime
 * (third-party-transform-directive-hooks design; `registerHook` opened up in draft 3, `on` stayed as
 * the simplified observe-only entry it always was).
 */
export interface PluginExtensionAPI {
  readonly ctx: ExtensionAPI['ctx']
  registerTool: ExtensionAPI['registerTool']
  on<E extends ObserveHookEvent>(event: E, handler: NoInfer<HookHandler<E>>): Disposer
  registerHook: ExtensionAPI['registerHook']
  readonly events: ExtensionAPI['events']
}
