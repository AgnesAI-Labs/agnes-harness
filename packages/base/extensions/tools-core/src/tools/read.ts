import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../guards/output.js'
import { ReadParams } from './schemas.js'

// Ceiling on how much of a file is pulled into memory for one call. Without it a single read of a
// large file would both hold the whole file in the process and push the whole file into the
// artifact store, since the output guard stores what it truncates.
export const MAX_READ_BYTES = 4 * 1024 * 1024

// Only the first 8 KB are scanned for a NUL. That is enough to recognise the usual binary formats,
// whose headers are at the front, and it keeps the check independent of file size. A NUL further in
// is not detected; that is a fixed, known cost rather than a bound that grows with the file.
export const BINARY_SCAN_BYTES = 8192

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

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a text file. Returns lines prefixed with their 1-based line number. Use offset (first line) and limit (number of lines) to page through large files.',
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
    const lines = toLines(text)
    const start = (args.offset ?? 1) - 1
    const slice = lines.slice(start, args.limit === undefined ? undefined : start + args.limit)
    if (slice.length === 0)
      return {
        content: [
          {
            type: 'text',
            text: `${notes}[no lines at offset ${args.offset ?? 1}; the file has ${lines.length} lines]`,
          },
        ],
      }
    const numbered = notes + slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n')
    return guardedResult(ctx, numbered)
  },
})
