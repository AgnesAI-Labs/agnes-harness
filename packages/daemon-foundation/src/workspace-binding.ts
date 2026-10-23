export type WorkspaceBindingRecord = Readonly<{
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
  /** Canonical, registered extra directories admitted at creation; absent means none. */
  extraRoots?: readonly string[]
}>

declare const workspaceBindingBrand: unique symbol

/** Nominal daemon-only authority. The brand is deliberately absent from the serialized frame. */
export type WorkspaceBindingEnvelope = WorkspaceBindingRecord & {
  readonly version: 1
  readonly [workspaceBindingBrand]: true
}
