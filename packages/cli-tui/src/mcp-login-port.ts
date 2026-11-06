/**
 * What the MCP sign-in panel needs from the sign-in code. The terminal CLI owns that code; the same
 * shapes are declared here because this package may only depend on the protocol and the SDK.
 */

/** Where a sign-in shows its address and progress, and reads the address a browser ended on. */
export type McpLoginPanelUi = Readonly<{
  show(input: { serverId: string; authorizationUrl: string }): void
  /** The pasted text; undefined when nothing can be pasted. Settles when `signal` aborts. */
  paste(signal: AbortSignal): Promise<string | undefined>
  progress(text: string): void
}>

export type McpLoginPanelOutcome = Readonly<{
  kind: 'signed-in' | 'already-signed-in' | 'cancelled' | 'timed-out'
  /** The sign-in is saved, but the server could not be brought up with it; says why. */
  reconnectFailed?: string
}>

/**
 * Sign in and out of MCP servers. A failed call rejects with an Error whose message is one plain
 * sentence meant for the user (server-supplied text already cleaned).
 */
export type TuiMcpLogin = Readonly<{
  /** HTTP servers that cannot connect until someone signs in. */
  candidates(profile: string): Promise<readonly string[]>
  login(input: {
    profile: string
    serverId: string
    ui: McpLoginPanelUi
    signal: AbortSignal
  }): Promise<McpLoginPanelOutcome>
  logout(profile: string, serverId: string): Promise<void>
}>
