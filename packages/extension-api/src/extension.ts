import type { LeaseView, Logger, PlatformFacts } from './common.js'

export type TrustTier = 'builtin' | 'trusted'

/** What a plugin reads through `ctx.self`: its identity, trust tier, logger, abort signal and platform facts. */
export interface ExtensionContext {
  readonly extId: string
  readonly version: string
  readonly trust: TrustTier
  readonly lease: LeaseView
  /** Writes to the Host audit stream on the extension channel, never to the ledger. */
  readonly log: Logger
  /** Aborted when the Host closes or the plugin is revoked. */
  readonly signal: AbortSignal
  readonly info: {
    readonly agnesVersion: string
    readonly apiVersion: string
    readonly profileName: string
    readonly preset?: string
    /** Execution directory snapshot at the start of this call (or the explicitly requested operation).
     * May differ from workspaceRoot in a future version; use workspaceRoot for workspace-owned state, policy and config.
     * Session defaults currently equal workspaceRoot; explicit process/child overrides do not change workspace identity.
     */
    readonly cwd?: string
  }
  /** Assembly-time snapshot; `terminal.width` is not live. */
  readonly platform: PlatformFacts
}
