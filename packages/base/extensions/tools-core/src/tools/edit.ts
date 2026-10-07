import { defineTool, type ToolResult } from '@agnes/extension-api'
import { withFileLock } from '../guards/mutation-queue.js'
import { observe, observedVersion, UNKNOWN_VERSION, versionOf } from '../guards/observed.js'
import { looksTruncated } from '../guards/truncation.js'
import { normalizeWorkspacePath } from '../paths.js'
import { isBinary, MAX_READ_BYTES } from './read.js'
import { EditParams } from './schemas.js'

// Keep the BOM in the decoded text so an unrelated edit preserves it on writeback.
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const enc = new TextEncoder()

function occurrences(hay: string, needle: string): number {
  let n = 0
  let i = 0
  for (;;) {
    const j = hay.indexOf(needle, i)
    if (j < 0) return n
    n++
    i = j + 1
  }
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export const editTool = defineTool({
  name: 'edit',
  description:
    'Apply exact text replacements to a file read in this session. Each oldText must occur exactly once in the current file content - include surrounding lines when a short string would match more than once - and the edits are applied in the order given. Build large generated files incrementally: aim for at most 8 KiB of new content per call, preserve the rest of the file, and split larger additions across multiple calls.',
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
  execute: (args, ctx): Promise<ToolResult> => {
    // Keyed on the resolved path rather than on the argument: `a.ts` and `/work/proj/a.ts` are one
    // file, and two spellings taking two locks is the same as taking no lock at all.
    const abs = normalizeWorkspacePath(args.path, ctx.cwd).abs
    return withFileLock(abs, async () => {
      let bytes: Uint8Array
      try {
        bytes = await ctx.fs.read(args.path)
      } catch (e) {
        return fail(`edit failed: ${(e as Error).message}`)
      }
      // Decoding bytes that are not text and writing the decoded form back replaces every invalid
      // sequence with U+FFFD, which destroys the file while reporting success.
      if (isBinary(bytes)) return fail(`binary file (${bytes.byteLength} bytes); edit only works on text`)
      let original: string
      try {
        original = dec.decode(bytes)
      } catch {
        return fail('edit failed: file is not valid UTF-8')
      }
      if (observedVersion(ctx.session.key, abs) === undefined)
        return {
          ...fail(`edit refused: read ${args.path} in this session before editing it`),
          details: { code: 'FS_NOT_OBSERVED', path: args.path },
        }
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
      try {
        await ctx.fs.write(args.path, text)
      } catch (e) {
        // See write: a read-only file is refused here, and the refusal has to stay a named one.
        if ((e as { code?: string }).code !== 'E_FS_DENIED') throw e
        return fail(`edit failed: ${(e as Error).message}`)
      }
      // An edit is never refused for a file that changed: its oldText must still match, which is
      // the check, and refusing here would make two sessions editing different parts of one file
      // fail each other. It does record what it wrote, so a later `write` of this session compares
      // against the file as this edit left it.
      observe(
        ctx.session.key,
        abs,
        (await versionOf(ctx, args.path, enc.encode(text), MAX_READ_BYTES)) ?? UNKNOWN_VERSION,
      )
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
    })
  },
})
