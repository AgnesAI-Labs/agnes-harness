import { createHash } from 'node:crypto'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { withFileLock } from '../guards/mutation-queue.js'
import { normalizeWorkspacePath } from '../paths.js'

export const SAVE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
  details: { code: 'FS_ATTACHMENT_COPY' },
})
const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu
const utf8 = new TextEncoder()

export function validSaveTarget(path: string): boolean {
  if (path.length > 4096 || path.includes('\\')) return false
  return path
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        ![...part].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127) &&
        !/[<>:"|?*]/u.test(part) &&
        !/[. ]$/u.test(part) &&
        !reserved.test(part) &&
        utf8.encode(part).length <= 255,
    )
}

let active = 0
const sessions = new Set<string>()
/** Bounded original copy; independent processes arbitrate at the exclusive filesystem create. */
export async function saveAttachment(path: string, saveTo: string, ctx: ToolContext): Promise<ToolResult> {
  if (!/^session-(file|image):\/\/[1-9][0-9]*\/[1-9][0-9]*$/u.test(path))
    return fail(
      'save_to requires one session-file://<seq>/<index> or session-image://<seq>/<index> original.',
    )
  if (!validSaveTarget(saveTo))
    return fail('save_to must be a plain relative workspace path without reserved names or traversal.')
  if (!ctx.fs.create)
    return fail(
      'Exclusive workspace creation is unavailable in this runtime; download the original through the client.',
    )
  if (active >= 2 || sessions.has(ctx.session.key))
    return fail('An original copy is already in progress; retry after it finishes.')
  const target = normalizeWorkspacePath(saveTo, ctx.cwd)
  if (!target.inside || target.rel !== saveTo) return fail('save_to must remain inside the workspace.')
  active++
  sessions.add(ctx.session.key)
  try {
    ctx.signal.throwIfAborted()
    // The session port resolves authority before a workspace lock or mutation is reached.
    const original = await ctx.session.readAttachment?.({ path, maxBytes: SAVE_ATTACHMENT_MAX_BYTES })
    if (!original)
      return fail(
        'The original is unavailable in this session and lane; use session-file://list or session-image://list to choose an available original.',
      )
    if (original.bytes.length > SAVE_ATTACHMENT_MAX_BYTES)
      return fail('The original exceeds 100 MiB. Download it through bounded client windows instead.')
    return await withFileLock(target.abs, async () => {
      ctx.signal.throwIfAborted()
      const expected = createHash('sha256').update(original.bytes).digest('hex')
      const written = await ctx.fs.create!(target.abs, original.bytes)
      if (written.size !== original.bytes.length || written.sha256 !== expected)
        return fail(
          `The copy at ${JSON.stringify(saveTo)} failed integrity verification; remove the incomplete file before retrying.`,
        )
      return {
        content: [
          {
            type: 'text',
            text: `Saved ${JSON.stringify(original.name)} (${original.mimeType}, ${written.size} bytes) to ${JSON.stringify(saveTo)}.`,
          },
        ],
        details: { path: saveTo, size: written.size, sha256: written.sha256 },
      }
    })
  } catch {
    ctx.signal.throwIfAborted()
    return fail(
      'Original copy failed. The target may exist, be denied, or contain a changed/symbolic-link parent. If a partial file was created, remove it before retrying. For oversized originals use bounded client downloads.',
    )
  } finally {
    active--
    sessions.delete(ctx.session.key)
  }
}
