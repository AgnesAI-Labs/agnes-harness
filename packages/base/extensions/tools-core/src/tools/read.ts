import { defineTool, type ToolContext, type ToolResult } from '@agnes/extension-api'
import { observe, UNKNOWN_VERSION, versionOf } from '../guards/observed.js'
import { byteLength, describeFailure, parseSpillLocator, splitByBytes } from '../guards/output.js'
import { normalizeWorkspacePath } from '../paths.js'
import { ReadParams } from './schemas.js'

// Ceiling on how much of a file is pulled into memory for one call. Without it a single read of a
// large file would both hold the whole file in the process and push the whole file into the
// artifact store, since the output guard stores what it truncates.
export const MAX_READ_BYTES = 4 * 1024 * 1024

// Only the first 8 KB are scanned for a NUL. That is enough to recognise the usual binary formats,
// whose headers are at the front, and it keeps the check independent of file size. A NUL further in
// is not detected; that is a fixed, known cost rather than a bound that grows with the file.
export const BINARY_SCAN_BYTES = 8192

// The most an artifact may weigh for this tool to ask the store for it. The store returns an
// artifact whole, with no way to ask for a range, so the size from the locator is judged before the
// call rather than after the bytes are already in memory.
export const MAX_ARTIFACT_READ_BYTES = 32 * 1024 * 1024

// Longer lines are shown as several. A JSON result or a minified page is tens of KB on a handful of
// lines, and paging by line alone would show the start of each and leave the rest out of reach.
const WRAP_BYTES = 2048

// Room kept in a page for the continuation hint, so adding the hint cannot push a page over the
// output limit.
const HINT_RESERVE = 120

const dec = new TextDecoder('utf-8', { fatal: false })

// Shared with every other tool that decodes a file, so they all draw the line in the same place. A
// tool that decoded bytes this says are binary would hand the model replacement characters and, if
// it wrote them back, would corrupt the file.
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SCAN_BYTES).includes(0)
}

// Drops the terminator of the final line, so a file ending in a newline does not report a phantom
// empty last line, while a genuinely blank final line survives.
function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** Uploaded files can be mostly newlines. Keep only one line in memory while paging them. */
function* attachmentLines(text: string): Generator<string> {
  let start = 0
  for (;;) {
    const end = text.indexOf('\n', start)
    const line = text.slice(start, end < 0 ? text.length : end)
    if (line.length * 3 <= WRAP_BYTES) yield line
    else yield* splitByBytes(line, WRAP_BYTES)
    if (end < 0 || end === text.length - 1) return
    start = end + 1
  }
}

function clipLine(line: string): string {
  if (line.length * 3 <= WRAP_BYTES) return line
  const bytes = byteLength(line)
  if (bytes <= WRAP_BYTES) return line
  return `${splitByBytes(line, WRAP_BYTES)[0]} [line cut at ${WRAP_BYTES} of ${bytes} bytes]`
}

// `lines` are the rows read pages through. `logical` are the text's own lines, and `starts[i]` is the
// index in `lines` of the row where logical line i begins, so a search can run over whole lines and
// still report the row to read from.
export type SpilledLines =
  | { ok: true; lines: string[]; logical: string[]; starts: number[]; notes: string }
  | { ok: false; message: string }

/**
 * The text an output-guard locator names, as the lines `read` pages through and `grep` searches.
 * Both tools take the locator from the note the guard wrote, so they share what counts as one and
 * how it is refused: a locator that is not exactly the one the guard wrote is never sent to the
 * store, and content that is not text is never shown as text.
 */
export async function loadSpilledLines(ctx: ToolContext, path: string): Promise<SpilledLines> {
  const ref = parseSpillLocator(path)
  if (ref === undefined && /^artifact:\/\/[0-9a-f]{64}$/.test(path))
    // The resource link next to the note names the digest alone, so a bare digest is the likeliest
    // slip, and the fix is a short step the model can take at once.
    return {
      ok: false,
      message: 'artifact locator is missing its ?size=<bytes>; use the whole path from the truncation note',
    }
  if (ref === undefined)
    return {
      ok: false,
      message:
        'malformed artifact locator; use it exactly as the truncation note wrote it: artifact://<sha256>?size=<bytes>',
    }
  if (ref.size > MAX_ARTIFACT_READ_BYTES)
    return {
      ok: false,
      message: `artifact is ${ref.size} bytes, too large to read (limit ${MAX_ARTIFACT_READ_BYTES})`,
    }
  let bytes: Uint8Array
  try {
    bytes = await ctx.artifacts.get(ref)
  } catch (e) {
    return { ok: false, message: describeFailure(e) }
  }
  if (isBinary(bytes))
    return { ok: false, message: `binary content (${bytes.byteLength} bytes); it cannot be shown as text` }
  let notes = ''
  if (bytes.byteLength > MAX_READ_BYTES) {
    bytes = bytes.subarray(0, MAX_READ_BYTES)
    notes = `[showing only the first ${MAX_READ_BYTES} bytes of this output; the rest cannot be read here]\n`
  }
  let text = dec.decode(bytes)
  // The same reasoning as the file path: a cut at the ceiling lands mid-line, and a fragment shown
  // as a whole line is a line the text does not contain.
  if (notes !== '') text = text.slice(0, Math.max(text.lastIndexOf('\n') + 1, 0)) || text
  // A line that cannot be longer than the wrap width in bytes is left alone without encoding it.
  const logical = toLines(text)
  const lines: string[] = []
  const starts: number[] = []
  for (const l of logical) {
    starts.push(lines.length)
    lines.push(...(l.length * 3 <= WRAP_BYTES ? [l] : splitByBytes(l, WRAP_BYTES)))
  }
  return { ok: true, lines, logical, starts, notes }
}

// One page of numbered lines: from `offset`, at most `limit` of them, and no more than fit the
// output limit. When the limit of bytes ends the page early, the hint says where to continue. This
// is the whole of what `read` hands back, for a file as for a stored output, so a result is never
// cut into a head and a tail: the model reads on from the hint instead of losing the middle.
function pageOfLines(
  maxBytes: number,
  spilled: { lines: Iterable<string>; notes: string },
  offset: number,
  limit: number | undefined,
  what: 'file' | 'artifact',
): string {
  const { lines, notes } = spilled
  const start = offset - 1
  const budget = maxBytes - HINT_RESERVE - byteLength(notes)
  const rows: string[] = []
  let used = 0
  let at = start
  let total = 0
  let clipped = false
  for (const line of lines) {
    const index = total++
    if (index < start || (limit !== undefined && index >= start + limit) || clipped) continue
    const row = `${index + 1}\t${line}`
    const cost = byteLength(row) + 1
    // A page always holds at least one line. A line cannot outgrow the budget: it is at most the
    // wrap width, far under it.
    if (rows.length > 0 && used + cost > budget) {
      clipped = true
      continue
    }
    rows.push(row)
    used += cost
    at = index + 1
  }
  if (start >= total) return `${notes}[no lines at offset ${offset}; the ${what} has ${total} lines]`
  const hint = clipped
    ? `\n[lines ${start + 1}-${at} of ${total}; call read again with offset=${at + 1} to continue]`
    : ''
  return notes + rows.join('\n') + hint
}

export const readTool = defineTool({
  name: 'read',
  description:
    'Read an actual workspace file (relative paths use the session working directory), not packaged demo fixtures, with line numbers; offset and limit page through it. Also reads artifact:// truncated outputs. Read uploaded text files using session-file://message-seq/file-index; long lines wrap into paged rows. session-file://list lists saved attachments (offset/limit page entries). Binary files, PDF, audio and video may be unreadable with the current pi-ai input. For image originals, use session-image://list, then session-image://message-seq/image-index; combine references as session-image://12/1,34/2. Originals count toward the model image limit; inspect them before claiming unseen details.',
  parameters: ReadParams,
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (args.path.startsWith('session-file://')) {
      try {
        const file = await ctx.session.readAttachment?.({ ...args, maxBytes: ctx.outputMaxBytes })
        if (!file) throw new Error('This attachment is unavailable in the current session.')
        const header = String.fromCharCode(...file.bytes.subarray(0, 16))
        if (
          /^(audio|video)\//iu.test(file.mimeType) ||
          /^application\/(pdf|zip|gzip|x-7z-compressed)/iu.test(file.mimeType) ||
          // Office MIME labels can also describe plain CSV/TSV. Inspect the bytes before decoding.
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Match binary magic bytes, including mislabeled PDFs and archives.
          /^(%PDF-|PK\x03\x04|\x1f\x8b|\x89PNG|\xff\xd8|GIF8|RIFF|\xd0\xcf\x11\xe0)/u.test(header) ||
          header.slice(4, 8) === 'ftyp'
        )
          throw new Error(
            'The original was uploaded, but this plain-text read tool cannot parse this binary format. For PDF, Word or ZIP, try an available document-reading tool. Native pi-ai file/audio/video input is unavailable. If no suitable tool can read it, explain the limitation; do not claim to have read it.',
          )
        const encoding =
          file.bytes[0] === 0xff && file.bytes[1] === 0xfe
            ? 'utf-16le'
            : file.bytes[0] === 0xfe && file.bytes[1] === 0xff
              ? 'utf-16be'
              : 'utf-8'
        const text = new TextDecoder(encoding, { fatal: true }).decode(file.bytes)
        if (args.path === 'session-file://list') return { content: [{ type: 'text', text }] }
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Binary detection must reject embedded control bytes.
        if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text))
          throw new Error('Binary content cannot be read as text.')
        const lines = attachmentLines(text)
        return {
          content: [
            {
              type: 'text',
              text: pageOfLines(
                ctx.outputMaxBytes,
                { lines, notes: '' },
                args.offset ?? 1,
                args.limit,
                'file',
              ),
            },
          ],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Attachment read failed: ${describeFailure(error)}` }],
          isError: true,
        }
      }
    }
    if (args.path.startsWith('session-image://')) {
      if (!ctx.session.readImages)
        return { content: [{ type: 'text', text: 'Session image reloading is unavailable.' }], isError: true }
      return ctx.session.readImages(args)
    }
    if (args.path.startsWith('artifact://')) {
      const spilled = await loadSpilledLines(ctx, args.path)
      if (!spilled.ok)
        return { content: [{ type: 'text', text: `read failed: ${spilled.message}` }], isError: true }
      // A page is already within the output limit, and it is not put back into the store: the text
      // it came from is what the model reads on from, by offset.
      return {
        content: [
          {
            type: 'text',
            text: pageOfLines(ctx.outputMaxBytes, spilled, args.offset ?? 1, args.limit, 'artifact'),
          },
        ],
      }
    }
    const abs = normalizeWorkspacePath(args.path, ctx.cwd).abs
    let bytes: Uint8Array
    try {
      // The path is passed on exactly as given: whatever enforces the workspace boundary must see
      // the same string that gets opened, or the check and the open are about different files.
      // One byte over the ceiling is requested so a file sitting exactly on it is not misreported
      // as truncated.
      bytes = await ctx.fs.read(args.path, { offset: 0, limit: MAX_READ_BYTES + 1 })
    } catch (e) {
      // Having been told the file is not there is what a session now knows of it. Keeping an older
      // version would leave a write that creates the file refused for a change the model has seen.
      if ((e as { code?: string }).code === 'ENOENT') observe(ctx.session.key, abs, undefined)
      return { content: [{ type: 'text', text: `read failed: ${(e as Error).message}` }], isError: true }
    }
    if (isBinary(bytes))
      return {
        content: [
          {
            type: 'text',
            text: `binary file (${bytes.byteLength} bytes); use shell tools to inspect it`,
          },
        ],
        isError: true,
      }
    // What this session has now seen of the file, taken from the whole of what came back and before
    // the cut below, so that `write` can refuse to replace it once it has changed. A page of a file
    // counts as having read the file.
    observe(ctx.session.key, abs, (await versionOf(ctx, args.path, bytes, MAX_READ_BYTES)) ?? UNKNOWN_VERSION)
    let notes = ''
    if (bytes.byteLength > MAX_READ_BYTES) {
      bytes = bytes.subarray(0, MAX_READ_BYTES)
      notes = `[showing only the first ${MAX_READ_BYTES} bytes of this file; use a shell command to reach the rest]\n`
    }
    let text = dec.decode(bytes)
    // A cut at the byte ceiling almost certainly lands mid-line; showing that fragment as if it
    // were a whole line invites an edit against text that does not exist in the file.
    if (notes !== '') text = text.slice(0, Math.max(text.lastIndexOf('\n') + 1, 0)) || text
    // A file keeps its real line numbers, so a line too long for a page is cut and says so rather
    // than wrapped into extra numbers; a shell command reaches the rest of it.
    const lines = toLines(text).map(clipLine)
    return {
      content: [
        {
          type: 'text',
          text: pageOfLines(ctx.outputMaxBytes, { lines, notes }, args.offset ?? 1, args.limit, 'file'),
        },
      ],
    }
  },
})
