import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { describeFailure } from '../guards/output.js'
import { normalizeWorkspacePath } from '../paths.js'

/**
 * The largest original `read` copies into the workspace. The tool file system writes a file whole
 * from memory, so a larger one is exported with `agh export --raw` instead.
 */
export const SAVE_TO_MAX_BYTES = 256 * 1024 * 1024

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

const SESSION_ORIGINAL = /^session-(file|image):\/\/[1-9][0-9]*\/[1-9][0-9]*$/u
const MAX_NAME_BYTES = 255
const utf8 = new TextEncoder()

/**
 * Why `saveTo` cannot name a new file, if it cannot. Only a plain relative path is accepted: no
 * absolute or drive path, no `.`/`..`/empty segment, no backslash, no control character (NUL
 * included) and none of the characters some file systems reserve, so the name means one thing on
 * every platform and to every layer below this one.
 */
function badTarget(saveTo: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (/[\u0000-\u001f\u007f]/u.test(saveTo)) return 'saveTo may not contain control characters.'
  if (saveTo.startsWith('/') || /^[A-Za-z]:/u.test(saveTo))
    return 'saveTo must be a relative path inside the workspace, not an absolute one.'
  if (saveTo.includes('\\')) return 'saveTo must use / between directories.'
  for (const segment of saveTo.split('/')) {
    if (segment === '' || segment === '.' || segment === '..')
      return 'saveTo must be a plain relative path inside the workspace (no empty, . or .. parts).'
    if (/[<>:"|?*]/u.test(segment)) return 'saveTo may not contain any of < > : " | ? *.'
    if (utf8.encode(segment).byteLength > MAX_NAME_BYTES) return 'A saveTo name is longer than 255 bytes.'
  }
  return undefined
}

const notFound = (error: unknown) => (error as { code?: unknown } | null)?.code === 'ENOENT'

/**
 * What stands in the way of creating `target`: an existing entry of any kind at the target, or a
 * directory on the way that is a symbolic link or not a directory. Directories that do not exist
 * yet are fine (the write creates them). A stat that fails for any reason but absence refuses.
 */
async function obstacle(ctx: ToolContext, root: string, rel: string): Promise<string | undefined> {
  const segments = rel.split('/')
  let dir = root
  for (const segment of segments.slice(0, -1)) {
    dir = `${dir}/${segment}`
    let kind: string
    try {
      kind = (await ctx.fs.stat(dir)).kind
    } catch (error) {
      if (notFound(error)) return undefined
      return `saveTo cannot be checked: ${describeFailure(error)}`
    }
    if (kind === 'symlink') return 'saveTo may not pass through a symbolic link.'
    if (kind !== 'dir')
      return `saveTo passes through ${dir.slice(root.length + 1)}, which is not a directory.`
  }
  try {
    await ctx.fs.stat(`${root}/${rel}`)
  } catch (error) {
    if (notFound(error)) return undefined
    return `saveTo cannot be checked: ${describeFailure(error)}`
  }
  return 'saveTo target already exists; choose a new path.'
}

/**
 * Copies a session attachment's original bytes to a new file in the workspace, so shell tools can
 * open it. The path is confined lexically here and again by the file system port, which applies
 * the session's path policy and resolves links; an existing file is never replaced. The port writes
 * a file in one call and has no rename, so the copy cannot be published atomically: the size is
 * checked after the write and a short file is reported, not left for the model to trust.
 */
export async function saveAttachment(ctx: ToolContext, path: string, saveTo: string): Promise<ToolResult> {
  if (!SESSION_ORIGINAL.test(path))
    return failure('saveTo only copies a session-file://<seq>/<n> or session-image://<seq>/<n> original.')
  const bad = badTarget(saveTo)
  if (bad) return failure(bad)
  const target = normalizeWorkspacePath(saveTo, ctx.cwd)
  if (!target.inside || target.rel !== saveTo) return failure('saveTo must be a path inside the workspace.')
  const root = target.abs.slice(0, target.abs.length - saveTo.length - 1)
  const blocked = await obstacle(ctx, root, saveTo)
  if (blocked) return failure(blocked)
  let original: Awaited<ReturnType<NonNullable<ToolContext['session']['readAttachment']>>>
  try {
    original = await ctx.session.readAttachment?.({ path, maxBytes: SAVE_TO_MAX_BYTES })
  } catch (error) {
    if ((error as { detail?: { code?: unknown } } | null)?.detail?.code === 'ATTACHMENT_TOO_LARGE')
      return failure('The attachment is larger than 256 MiB; export it with `agh export --raw` instead.')
    return failure(`Attachment read failed: ${describeFailure(error)}`)
  }
  if (!original) return failure('Attachment not found in this session.')
  const size = original.bytes.byteLength
  if (size > SAVE_TO_MAX_BYTES)
    return failure('The attachment is larger than 256 MiB; export it with `agh export --raw` instead.')
  try {
    await ctx.fs.write(target.abs, original.bytes)
  } catch (error) {
    return failure(`saveTo write failed: ${describeFailure(error)}`)
  }
  const written = await ctx.fs.stat(target.abs).catch(() => undefined)
  if (written && written.size !== size)
    return failure(
      `saveTo wrote ${written.size} of ${size} bytes to ${saveTo}; the file there is incomplete.`,
    )
  return {
    content: [
      {
        type: 'text',
        text: `Saved ${JSON.stringify(original.name)} (${original.mimeType}, ${size} bytes) to ${saveTo}.`,
      },
    ],
  }
}
