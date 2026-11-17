import type { LegacyChatReadGrant } from './storage/managed-chat-authority.js'

export type WorkspaceBindingRecord = Readonly<{
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
  legacyChatReadGrant?: LegacyChatReadGrant
  /** Canonical, registered extra directories admitted at creation; absent means none. */
  extraRoots?: readonly string[]
}>

declare const workspaceBindingBrand: unique symbol

/** Nominal daemon-only authority. The brand is deliberately absent from the serialized frame. */
export type WorkspaceBindingEnvelope = WorkspaceBindingRecord & {
  readonly version: 1
  readonly [workspaceBindingBrand]: true
}
