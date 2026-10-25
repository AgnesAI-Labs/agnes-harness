/**
 * A tool call that failed with a known outcome. `not_sent`: refused before the request left this
 * process. `answered`: the server replied with a JSON-RPC error rather than running the tool.
 */
export class McpCallError extends Error {
  constructor(
    readonly stage: 'not_sent' | 'answered',
    message: string,
  ) {
    super(message)
    this.name = 'McpCallError'
  }
}
