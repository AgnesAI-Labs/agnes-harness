/** Preserve the original readable form when it fits the protocol's 128-code-point limit.
 * The long form has no colon, so it cannot collide with any readable client:session:n form. */
export async function journalCommandId(
  clientId: string,
  sessionId: string,
  counter: number,
): Promise<string> {
  const plain = `${clientId}:${sessionId}:${counter}`
  if (Array.from(plain).length <= 128) return plain
  const encoded = new TextEncoder().encode(JSON.stringify([clientId, sessionId]))
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoded))
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256-${hex}-${counter}`
}
