import type { ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import type { LspSessions } from '../../../lsp/src/registry.js'
import type { FileChangeRecorder } from '../file-change.js'
import { displayPath, fsFailure, toolFailure } from '../guards/feedback.js'
import { withFileLock } from '../guards/mutation-queue.js'
import { observe, observedVersion, UNKNOWN_VERSION, versionOf } from '../guards/observed.js'
import { crlf, usesCrlf } from '../line-endings.js'
import { normalizeWorkspacePath } from '../paths.js'
import { matchLocations, mismatchFeedback } from './edit-feedback.js'
import { withLspNote } from './lsp-note.js'
import { isBinary, MAX_READ_BYTES } from './read.js'
import { EditParams } from './schemas.js'

// Keep the BOM in the decoded text so an unrelated edit preserves it on writeback.
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const enc = new TextEncoder()

export function createEditTool(record?: FileChangeRecorder, lsp?: LspSessions) {
  return defineTool({
    name: 'edit',
    description:
      'Apply exact text replacements to a file read in this session. Each oldText must occur exactly once in the current file content - include surrounding lines when a short string would match more than once - and the edits are applied in the order given. Build large generated files incrementally: aim for at most 8 KiB of new content per call, preserve the rest of the file, and split larger additions across multiple calls.',
    parameters: EditParams,
    meta: {
      paths: [{ arg: 'path', access: 'write' }],
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'idempotent',
      costHint: {},
      deferLoading: false,
      requiresApproval: 'destructive',
    },
    execute: async (args, ctx): Promise<ToolResult> => {
      // Keyed on the resolved path rather than on the argument: `a.ts` and `/work/proj/a.ts` are one
      // file, and two spellings taking two locks is the same as taking no lock at all.
      const abs = normalizeWorkspacePath(args.path, ctx.cwd).abs
      const wrote: { text?: string } = {}
      const result = await withFileLock<ToolResult>(abs, async () => {
        let bytes: Uint8Array
        try {
          bytes = await ctx.fs.read(args.path)
        } catch (e) {
          return fsFailure(ctx, 'edit', args.path, e)
        }
        // Decoding bytes that are not text and writing the decoded form back replaces every invalid
        // sequence with U+FFFD, which destroys the file while reporting success.
        if (isBinary(bytes))
          return toolFailure(
            ctx,
            'FS_BINARY',
            `edit refused: binary file (${bytes.byteLength} bytes); use a format-aware tool or ask for a text version.`,
          )
        let original: string
        try {
          original = dec.decode(bytes)
        } catch {
          return toolFailure(
            ctx,
            'FS_ENCODING',
            'edit failed: file is not valid UTF-8; inspect its encoding with shell and convert a copy to UTF-8 before editing.',
          )
        }
        if (observedVersion(ctx.session.key, abs) === undefined)
          return {
            ...(await toolFailure(
              ctx,
              'FS_NOT_OBSERVED',
              `edit refused: read ${displayPath(ctx, args.path)} in this session before editing it`,
            )),
            details: { code: 'FS_NOT_OBSERVED', path: args.path },
          }
        let text = original
        const normalize = usesCrlf(original) ? crlf : (value: string) => value
        for (const [i, e] of args.edits.entries()) {
          const oldText = normalize(e.oldText)
          const newText = normalize(e.newText)
          const { count: n, lines } = matchLocations(text, oldText)
          if (n === 0) {
            const seen = observedVersion(ctx.session.key, abs)
            const now = await versionOf(ctx, args.path, bytes, MAX_READ_BYTES)
            const stale =
              seen !== UNKNOWN_VERSION && now !== undefined && seen !== now
                ? ' File changed since the session last read it; read the current range and merge your change.'
                : ''
            const earlier =
              i > 0 && original.includes(oldText)
                ? ' Text already replaced by an earlier edit in this same call; later edits must target the intermediate content. Candidate excerpts below show that intermediate content, not the on-disk file.'
                : ''
            return toolFailure(
              ctx,
              'FS_EDIT_NOT_FOUND',
              `edit ${i + 1}: oldText not found.${stale}${earlier} No edits from this call were written; correct and resend the whole batch.\n${mismatchFeedback(text, oldText)}`,
            )
          }
          if (n > 1)
            return toolFailure(
              ctx,
              'FS_AMBIGUOUS_EDIT',
              `edit ${i + 1}: ambiguous (${n} matches); match start lines: ${lines.join(', ')}${n > lines.length ? ' (first 20 shown)' : ''}. Include distinguishing surrounding lines in oldText. No edits from this call were written; resend the whole batch.`,
            )
          // A function replacement, so `$&` and the other replacement patterns in newText stay
          // literal text instead of expanding into content the model never wrote.
          text = text.replace(oldText, () => newText)
        }
        // No truncation guard here, unlike write. That guard catches a rewrite that silently lost
        // the end of a file, and an edit cannot lose anything silently: every removed byte is named
        // in an oldText that had to match exactly. A size ratio would refuse large intended
        // deletions (one side of a merge conflict, a dead section), and a bracket count would refuse
        // a batch split across calls, while splitting the same change into smaller edits does not
        // change either total. Nor is a newText cut off by the output limit a case for this tool:
        // the turn drops every tool call of a response that stopped at max_tokens, because its
        // arguments were cut off mid-serialisation.
        try {
          await ctx.fs.write(args.path, text)
        } catch (e) {
          // See write: a read-only file is refused here, and the refusal has to stay a named one.
          if ((e as { code?: string }).code !== 'E_FS_DENIED') throw e
          return fsFailure(ctx, 'edit', args.path, e)
        }
        if (record)
          try {
            await record(
              { operation: 'edit', path: args.path, before: bytes, after: enc.encode(text), existed: true },
              ctx,
            )
          } catch {
            // A completed write stays completed if a bounded review receipt cannot be recorded.
            ctx.log.warn('File review receipt unavailable', { operation: 'edit' })
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
        wrote.text = text
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
      return wrote.text === undefined ? result : withLspNote(lsp, ctx, abs, wrote.text, result)
    },
  })
}
export const editTool = createEditTool()
