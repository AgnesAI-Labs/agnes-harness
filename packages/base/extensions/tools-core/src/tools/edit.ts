import { defineTool, type ToolResult } from '@agnes/extension-api'
import { withFileLock } from '../guards/mutation-queue.js'
import { looksTruncated } from '../guards/truncation.js'
import { normalizeWorkspacePath } from '../paths.js'
import { isBinary } from './read.js'
import { EditParams } from './schemas.js'

const dec = new TextDecoder()
const enc = new TextEncoder()

function occurrences(hay: string, needle: string): number {
  let n = 0
  let i = 0
  for (;;) {
    const j = hay.indexOf(needle, i)
    if (j < 0) return n
    n++
    i = j + needle.length
  }
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export const editTool = defineTool({
  name: 'edit',
  description:
    'Apply exact text replacements to a file. Each oldText must occur exactly once in the current file content - include surrounding lines when a short string would match more than once - and the edits are applied in the order given.',
  parameters: EditParams,
  meta: {
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'idempotent',
    costHint: {},
    deferLoading: false,
    requiresApproval: 'destructive',
  },
  execute: (args, ctx): Promise<ToolResult> =>
    // Keyed on the resolved path rather than on the argument: `a.ts` and `/work/proj/a.ts` are one
    // file, and two spellings taking two locks is the same as taking no lock at all.
    withFileLock(normalizeWorkspacePath(args.path, ctx.cwd).abs, async () => {
      let bytes: Uint8Array
      try {
        bytes = await ctx.fs.read(args.path)
      } catch (e) {
        return fail(`edit failed: ${(e as Error).message}`)
      }
      // Decoding bytes that are not text and writing the decoded form back replaces every invalid
      // sequence with U+FFFD, which destroys the file while reporting success.
      if (isBinary(bytes)) return fail(`binary file (${bytes.byteLength} bytes); edit only works on text`)
      const original = dec.decode(bytes)
      let text = original
      for (const [i, e] of args.edits.entries()) {
        const n = occurrences(text, e.oldText)
        if (n === 0) return fail(`edit ${i + 1}: oldText not found`)
        if (n > 1) return fail(`edit ${i + 1}: ambiguous (${n} matches); include more context`)
        // A function replacement, so `$&` and the other replacement patterns in newText stay
        // literal text instead of expanding into content the model never wrote.
        text = text.replace(e.oldText, () => e.newText)
      }
      const t = looksTruncated(original, text)
      if (t.truncated) return fail(`edit refused (truncation guard): ${t.reason}`)
      await ctx.fs.write(args.path, text)
      const delta = text.split('\n').length - original.split('\n').length
      return {
        content: [
          {
            type: 'text',
            text: `applied ${args.edits.length} edit(s) to ${args.path} (${delta >= 0 ? '+' : ''}${delta} lines)`,
          },
        ],
        details: { path: args.path, bytes: enc.encode(text).byteLength },
      }
    }),
})
