import { defineTool, type ToolResult } from '@agnes/extension-api'
import { withFileLock } from '../guards/mutation-queue.js'
import { looksTruncated } from '../guards/truncation.js'
import { normalizeWorkspacePath } from '../paths.js'
import { WriteParams } from './schemas.js'

const dec = new TextDecoder()
const enc = new TextEncoder()

export const writeTool = defineTool({
  name: 'write',
  description:
    'Create or overwrite a file with the given content. Overwriting an existing file is destructive, and content that looks like a partial copy of what is already there is refused rather than written.',
  parameters: WriteParams,
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
      let old = ''
      try {
        old = dec.decode(await ctx.fs.read(args.path))
      } catch (e) {
        // Only "the file is not there" means a new file. A permission error, a directory, or a
        // refusal from the sandbox arriving here as "no previous content" would switch the
        // truncation guard off on precisely the reads that failed for a reason, and the overwrite
        // would go ahead against a file nobody could look at. Anything else is a failed call.
        if ((e as { code?: string }).code !== 'ENOENT') throw e
      }
      const t = looksTruncated(old, args.content)
      if (t.truncated)
        return {
          content: [
            {
              type: 'text',
              text: `write refused (truncation guard): ${t.reason}. Re-emit the full intended content, or use edit to change part of the file.`,
            },
          ],
          isError: true,
        }
      await ctx.fs.write(args.path, args.content)
      return {
        content: [
          {
            type: 'text',
            text: `${old === '' ? 'created' : 'overwrote'} ${args.path} (${args.content.length} chars)`,
          },
        ],
        details: { path: args.path, bytes: enc.encode(args.content).byteLength },
      }
    }),
})
