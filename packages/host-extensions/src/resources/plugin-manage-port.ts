/** Host-stamped identity; never accepted from plugin or model arguments. */
export type PluginManageInvocation = Readonly<{
  packageId: string
  snapshotId: string
  rowId: string
  sessionKey: string
  toolUseId: string
  turn: number
  leaseId: string
  input: unknown
}>
export type PluginManageBridge = (input: PluginManageInvocation, signal: AbortSignal) => Promise<unknown>
