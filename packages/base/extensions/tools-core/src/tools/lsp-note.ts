import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { LspSessions } from '../../../lsp/src/registry.js'

/**
 * Appends the language server's errors for a file that was just written. Called after the file lock is
 * released: the wait for the server can take seconds and must not hold up other edits of the file.
 */
export async function withLspNote(
  lsp: LspSessions | undefined,
  ctx: ToolContext,
  abs: string,
  text: string,
  result: ToolResult,
): Promise<ToolResult> {
  const note = await lsp?.diagnosticsFor(ctx, abs, text)
  return note ? { ...result, content: [...result.content, { type: 'text', text: note }] } : result
}
