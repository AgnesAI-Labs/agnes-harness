/** The authorization server answered the sign-in with an error (for example the user said no). */
export class McpLoginRefused extends Error {
  readonly error: string
  constructor(error: string, description?: string) {
    // Both come from the authorization server: control characters must not reach the terminal.
    const plain = (text: string) => text.replace(/\p{Cc}/gu, ' ')
    super(
      `the authorization server refused the sign-in: ${plain(error)}${description ? ` (${plain(description)})` : ''}`,
    )
    this.name = 'McpLoginRefused'
    this.error = error
  }
}

/** The pasted text is not this sign-in's callback address. */
export class McpLoginPasteInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpLoginPasteInvalid'
  }
}

/**
 * Reads the address the browser ended on. Only the full address is accepted: its origin and path
 * must be the callback address and its `state` this sign-in's; a bare code or query string is not.
 * An empty paste cancels. Anything else throws, which ends the sign-in.
 */
export function parsePastedCallback(
  text: string,
  expected: Readonly<{ redirectUri: string; state: string }>,
): Readonly<{ code: string }> | 'cancel' {
  const trimmed = text.trim()
  if (!trimmed) return 'cancel'
  let pasted: URL
  try {
    pasted = new URL(trimmed)
  } catch {
    throw new McpLoginPasteInvalid(
      'paste the full address the browser ended on (starting with http://localhost), not only the code',
    )
  }
  const callback = new URL(expected.redirectUri)
  if (pasted.origin !== callback.origin || pasted.pathname !== callback.pathname)
    throw new McpLoginPasteInvalid(
      `that is not this sign-in's callback address (${callback.origin}${callback.pathname})`,
    )
  if (pasted.searchParams.get('state') !== expected.state)
    throw new McpLoginPasteInvalid('that address does not belong to this sign-in; start the sign-in again')
  const error = pasted.searchParams.get('error')
  if (error) throw new McpLoginRefused(error, pasted.searchParams.get('error_description') ?? undefined)
  const code = pasted.searchParams.get('code')
  if (!code)
    throw new McpLoginPasteInvalid('that address has no code; paste the address the browser ended on')
  return { code }
}
