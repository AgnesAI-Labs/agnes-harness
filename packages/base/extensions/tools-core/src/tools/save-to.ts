import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { withFileLock } from '../guards/mutation-queue.js'
import { describeFailure } from '../guards/output.js'
import { normalizeWorkspacePath } from '../paths.js'

/**
 * The largest original `read` copies into the workspace. The tool file system writes a file whole
 * from memory, so a larger one is downloaded through the client instead, which reads attachments of
 * any size in windows (`session.attachmentRead`).
 */
export const SAVE_TO_MAX_BYTES = 256 * 1024 * 1024
const TOO_LARGE =
  'The attachment is larger than 256 MiB, too large to copy into the workspace; download it through the client instead, which reads attachments of any size in windows.'

/** Copies a session may have in flight at once, and the process as a whole: each holds the whole file. */
export const SAVE_TO_PER_SESSION = 2
export const SAVE_TO_PER_PROCESS = 4

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

const SESSION_ORIGINAL = /^session-(file|image):\/\/[1-9][0-9]*\/[1-9][0-9]*$/u
const MAX_NAME_BYTES = 255
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu
const utf8 = new TextEncoder()

/**
 * Why `saveTo` cannot name a new file, if it cannot. Only a plain relative path is accepted: no
 * absolute or drive path, no `.`/`..`/empty segment, no backslash, no control character (NUL
 * included), none of the characters some file systems reserve, no device name Windows reserves
 * (with or without an extension) and no name ending in a dot or a space, so the name means one thing
 * on every platform and to every layer below this one.
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
    if (RESERVED.test(segment))
      return `saveTo may not use the reserved device name ${JSON.stringify(segment)}.`
    if (/[. ]$/u.test(segment)) return 'A saveTo name may not end in a dot or a space.'
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

class Permits {
  active = 0
  readonly #waiting: Array<() => void> = []
  constructor(readonly limit: number) {}
  async take(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    // The releasing holder hands its permit straight over, so the count never dips in between.
    await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }
  release(): void {
    const next = this.#waiting.shift()
    if (next) next()
    else this.active--
  }
}

const processPermits = new Permits(SAVE_TO_PER_PROCESS)
const sessionPermits = new Map<string, Permits>()

/** Holds a session permit, then a process permit (always in that order), for the whole copy. */
async function bounded<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
  let session = sessionPermits.get(sessionKey)
  if (!session) {
    session = new Permits(SAVE_TO_PER_SESSION)
    sessionPermits.set(sessionKey, session)
  }
  const permits = session
  await permits.take()
  try {
    await processPermits.take()
    try {
      return await run()
    } finally {
      processPermits.release()
    }
  } finally {
    permits.release()
    if (permits.active === 0 && sessionPermits.get(sessionKey) === permits) sessionPermits.delete(sessionKey)
  }
}

/**
 * Copies a session attachment's original bytes to a new file in the workspace, so shell tools can
 * open it. The path is confined lexically here and again by the file system port, which applies
 * the session's path policy and resolves links.
 *
 * A target that exists when it is checked is refused. The check runs once before the attachment is
 * read (to fail fast) and again inside the same per-file lock `write` takes, right before the write,
 * so two copies (or a copy and a `write`) to one path in this process cannot both go ahead. The port
 * offers no exclusive create, so a file another process creates between that check and the write
 * is not detected. Each copy holds the whole file in memory, so copies are bounded per session and
 * per process. The port writes a file in one call and has neither rename nor remove: the copy cannot
 * be published atomically, a short file is reported after the write, and a partial file left by a
 * failed write is named in the error so it can be removed.
 */
export async function saveAttachment(ctx: ToolContext, path: string, saveTo: string): Promise<ToolResult> {
  if (!SESSION_ORIGINAL.test(path))
    return failure('saveTo only copies a session-file://<seq>/<n> or session-image://<seq>/<n> original.')
  const bad = badTarget(saveTo)
  if (bad) return failure(bad)
  const target = normalizeWorkspacePath(saveTo, ctx.cwd)
  if (!target.inside || target.rel !== saveTo) return failure('saveTo must be a path inside the workspace.')
  const root = target.abs.slice(0, target.abs.length - saveTo.length - 1)
  const early = await obstacle(ctx, root, saveTo)
  if (early) return failure(early)
  return bounded(ctx.session.key, async () => {
    let original: Awaited<ReturnType<NonNullable<ToolContext['session']['readAttachment']>>>
    try {
      original = await ctx.session.readAttachment?.({ path, maxBytes: SAVE_TO_MAX_BYTES })
    } catch (error) {
      if ((error as { detail?: { code?: unknown } } | null)?.detail?.code === 'ATTACHMENT_TOO_LARGE')
        return failure(TOO_LARGE)
      return failure(`Attachment read failed: ${describeFailure(error)}`)
    }
    if (!original) return failure('Attachment not found in this session.')
    const { bytes, name, mimeType } = original
    const size = bytes.byteLength
    if (size > SAVE_TO_MAX_BYTES) return failure(TOO_LARGE)
    return withFileLock(target.abs, async () => {
      const blocked = await obstacle(ctx, root, saveTo)
      if (blocked) return failure(blocked)
      try {
        await ctx.fs.write(target.abs, bytes)
      } catch (error) {
        const left = await ctx.fs.stat(target.abs).catch(() => undefined)
        return failure(
          `saveTo write failed: ${describeFailure(error)}${
            left ? ` A partial file may be left at ${saveTo}; remove it before trying again.` : ''
          }`,
        )
      }
      const written = await ctx.fs.stat(target.abs).catch(() => undefined)
      if (written && written.size !== size)
        return failure(
          `saveTo wrote ${written.size} of ${size} bytes to ${saveTo}; the file there is incomplete. Remove it before trying again.`,
        )
      return {
        content: [
          {
            type: 'text',
            text: `Saved ${JSON.stringify(name)} (${mimeType}, ${size} bytes) to ${saveTo}.`,
          },
        ],
      }
    })
  })
}
