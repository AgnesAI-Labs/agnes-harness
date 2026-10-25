import { looksLikeSecret, redactText } from '@agnes/error-sanitization'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { normalizeWorkspacePath } from '../paths.js'
import { guardedResult } from './output.js'

/** Never reflect backend exception messages: they can contain secrets and resolved private paths. */
export function failureCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) && !looksLikeSecret(code)
    ? code
    : fallback
}

export function displayPath(ctx: ToolContext, path: string): string {
  const p = normalizeWorkspacePath(path, ctx.session.workspaceRoot)
  return p.inside ? JSON.stringify(p.rel || '.') : '[requested path outside workspace]'
}

/**
 * The refusal of a change to a file the session has not read. It names the path exactly as the model
 * gave it (quoted, so a space or a newline cannot blur it), even outside the workspace: the model
 * wrote it, so echoing it discloses nothing, and it says which tool clears the way.
 */
export const notObservedText = (tool: 'edit' | 'write', path: string) =>
  `${tool} refused: read ${JSON.stringify(path)} with the read tool in this session before ${tool === 'edit' ? 'editing' : 'overwriting'} it`

export const scrubFeedback = (text: string) =>
  redactText(text, { secrets: true, paths: false, pii: false, custom: [] })
    .text.split('\n')
    .map((line) => (looksLikeSecret(line) ? '[REDACTED:secret]' : line))
    .join('\n')

export async function toolFailure(ctx: ToolContext, code: string, message: string): Promise<ToolResult> {
  const safe = scrubFeedback(message)
  return { ...(await guardedResult(ctx, safe)), isError: true, details: { code } }
}

export function fsFailure(ctx: ToolContext, operation: string, path: string, error: unknown) {
  const code = failureCode(error, 'FS_OPERATION_FAILED')
  const reasons: Record<string, string> = {
    ENOENT: 'path does not exist; use ls/find to locate it or create a new file with write',
    ENOTDIR: 'a path component is not a directory; use ls on its parent and correct the path',
    EISDIR: 'path is a directory; use ls, then choose a file',
    EACCES: 'permission denied; choose an accessible path or ask the user to adjust access',
    EPERM: 'permission denied; choose an accessible path or ask the user to adjust access',
    E_FS_DENIED:
      'denied by file policy; choose an allowed path or ask the user to change the workspace/access policy',
  }
  const why =
    reasons[code] ?? 'filesystem operation failed; inspect the path and current state before retrying'
  return toolFailure(ctx, code, `${operation} failed for ${displayPath(ctx, path)} (${code}): ${why}.`)
}
