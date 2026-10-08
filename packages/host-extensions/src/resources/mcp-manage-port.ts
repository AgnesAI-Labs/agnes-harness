/** Host-stamped identity; never accepted from plugin or model arguments. */
export type McpManageInvocation = Readonly<{
  packageId: string
  snapshotId: string
  rowId: string
  sessionKey: string
  toolUseId: string
  leaseId: string
  input: unknown
}>
export type McpManageBridge = (input: McpManageInvocation, signal: AbortSignal) => Promise<unknown>
