import { type Bytes, defineTool, type ToolResult } from '@agnes/extension-api'
import type { FileChangeRecorder } from '../file-change.js'
import { withFileLock } from '../guards/mutation-queue.js'
import { ABSENT, observe, observedVersion, UNKNOWN_VERSION, versionOf } from '../guards/observed.js'
import { looksTruncated } from '../guards/truncation.js'
import { normalizeWorkspacePath } from '../paths.js'
import { MAX_READ_BYTES } from './read.js'
import { WriteParams } from './schemas.js'

const dec = new TextDecoder()
const enc = new TextEncoder()

export function createWriteTool(record?: FileChangeRecorder) {
  return defineTool({
    name: 'write',
    description:
      'Create or overwrite a file with the given content. For large generated files, first write a small valid scaffold with unique section markers, then fill the sections with multiple edit calls. Aim for at most 8 KiB of generated content per call to avoid model output truncation; do not generate a whole large file in one call. Read an existing file in this session before overwriting it. Overwriting an existing file is destructive, and content that looks like a partial copy of what is already there is refused rather than written.',
    parameters: WriteParams,
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
    execute: (args, ctx): Promise<ToolResult> => {
      // Keyed on the resolved path rather than on the argument: `a.ts` and `/work/proj/a.ts` are one
      // file, and two spellings taking two locks is the same as taking no lock at all.
      const abs = normalizeWorkspacePath(args.path, ctx.cwd).abs
      return withFileLock(abs, async () => {
        let old = ''
        let oldBytes: Bytes = new Uint8Array()
        let existed = true
        try {
          oldBytes = await ctx.fs.read(args.path)
          old = dec.decode(oldBytes)
        } catch (e) {
          // Only "the file is not there" means a new file. A permission error, a directory, or a
          // refusal from the sandbox arriving here as "no previous content" would switch the
          // truncation guard off on precisely the reads that failed for a reason, and the overwrite
          // would go ahead against a file nobody could look at. Anything else is a failed call.
          if ((e as { code?: string }).code !== 'ENOENT')
            return {
              content: [{ type: 'text', text: `write failed before writing: ${(e as Error).message}` }],
              isError: true,
            }
          existed = false
        }
        const seen = observedVersion(ctx.session.key, abs)
        if (existed && seen === undefined)
          return {
            content: [
              {
                type: 'text',
                text: `write refused: read ${args.path} in this session before overwriting it`,
              },
            ],
            isError: true,
            details: { code: 'FS_NOT_OBSERVED', path: args.path },
          }
        if (seen !== undefined) {
          const now = existed ? await versionOf(ctx, args.path, oldBytes, MAX_READ_BYTES) : ABSENT
          // No version to name (the file system could not say) is not a change.
          if (seen !== UNKNOWN_VERSION && now !== undefined && now !== seen)
            return {
              content: [
                {
                  type: 'text',
                  text: `write refused (stale read): ${args.path} changed after you last read it - another session, a shell command or an external process modified it, and writing now would discard those changes. Read the file again, merge your intended change into the current content, then write; or use edit to change only the part you mean to.`,
                },
              ],
              isError: true,
              details: { code: 'FS_STALE_VERSION', path: args.path },
            }
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
        try {
          await ctx.fs.write(args.path, args.content)
        } catch (e) {
          // A file the fence lets the model read but not replace fails here, not at the read above.
          // Left to propagate, a refusal that wrote nothing would reach the model as a call whose
          // outcome is unknown, and nothing in it would say the policy said no.
          if ((e as { code?: string }).code !== 'E_FS_DENIED') throw e
          return {
            content: [{ type: 'text', text: `write failed before writing: ${(e as Error).message}` }],
            isError: true,
          }
        }
        if (record)
          try {
            await record(
              {
                operation: 'write',
                path: args.path,
                before: oldBytes,
                after: enc.encode(args.content),
                existed,
              },
              ctx,
            )
          } catch {
            // A completed write stays completed if a bounded review receipt cannot be recorded.
            ctx.log.warn('File review receipt unavailable', { operation: 'write' })
          }
        // What was just written is what this session now knows of the file.
        observe(
          ctx.session.key,
          abs,
          (await versionOf(ctx, args.path, enc.encode(args.content), MAX_READ_BYTES)) ?? UNKNOWN_VERSION,
        )
        return {
          content: [
            {
              type: 'text',
              text: `${existed ? 'overwrote' : 'created'} ${args.path} (${args.content.length} chars)`,
            },
          ],
          details: { path: args.path, bytes: enc.encode(args.content).byteLength },
        }
      })
    },
  })
}
export const writeTool = createWriteTool()
