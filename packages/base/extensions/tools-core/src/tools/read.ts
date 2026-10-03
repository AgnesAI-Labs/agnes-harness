import { defineTool, type ToolContext, type ToolResult } from '@agnes/extension-api'
import { byteLength, describeFailure, parseSpillLocator, splitByBytes } from '../guards/output.js'
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
  spilled: { lines: string[]; notes: string },
  offset: number,
  limit: number | undefined,
  what: 'file' | 'artifact',
): string {
  const { lines, notes } = spilled
  const start = offset - 1
  if (start >= lines.length)
    return `${notes}[no lines at offset ${offset}; the ${what} has ${lines.length} lines]`
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit)
  const budget = maxBytes - HINT_RESERVE - byteLength(notes)
  const rows: string[] = []
  let used = 0
  let at = start
  for (; at < end; at++) {
    const row = `${at + 1}\t${lines[at]}`
    const cost = byteLength(row) + 1
    // A page always holds at least one line. A line cannot outgrow the budget: it is at most the
    // wrap width, far under it.
    if (rows.length > 0 && used + cost > budget) break
    rows.push(row)
    used += cost
  }
  const hint =
    at < end
      ? `\n[lines ${start + 1}-${at} of ${lines.length}; call read again with offset=${at + 1} to continue]`
      : ''
  return notes + rows.join('\n') + hint
}

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a text file. Returns lines prefixed with their 1-based line number. Use offset (first line) and limit (number of lines) to page through large files. Also takes the artifact:// path from a truncated output note, to read the rest of that output the same way.',
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
    let bytes: Uint8Array
    try {
      // The path is passed on exactly as given: whatever enforces the workspace boundary must see
      // the same string that gets opened, or the check and the open are about different files.
      // One byte over the ceiling is requested so a file sitting exactly on it is not misreported
      // as truncated.
      bytes = await ctx.fs.read(args.path, { offset: 0, limit: MAX_READ_BYTES + 1 })
    } catch (e) {
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
