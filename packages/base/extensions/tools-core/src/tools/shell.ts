import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../guards/output.js'
import { ShellParams } from './schemas.js'

// First element of the argv this tool hands to `ctx.exec`. It is a placeholder, not a program: the
// deployment's sandbox implementation replaces it with the interpreter it has chosen. Keeping the
// choice out of here is what lets the parameter schema, and therefore its hash, stay identical
// everywhere agnes runs, and it keeps the command line itself untouched — one argv element,
// exactly as the model wrote it, so what the policy layer inspects is what runs.
export const SHELL_SENTINEL = '$SHELL'

export const shellTool = defineTool({
  name: 'shell',
  description:
    'Run a command line in the session shell (the runtime context tells you which shell dialect is active). Output is captured; long output is stored as an artifact. timeoutMs may shorten the call but not extend it beyond the session limit. The background option is unavailable: run long commands in the foreground, in shorter steps.',
  parameters: ShellParams,
  meta: {
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: true,
    replay: 'never',
    costHint: {},
    deferLoading: false,
    requiresApproval: undefined,
  },
  async execute(args, ctx): Promise<ToolResult> {
    const cwd = args.cwd ?? ctx.cwd
    if (args.background) {
      // The tool call id is the idempotency key, so a retried call adopts the job the first one
      // submitted instead of starting a second copy of the command. The session is filled in by
      // the kernel, which knows it; a tool naming one would be asserting where its work belongs.
      try {
        const jobId = await ctx.artifacts.submitJob({
          idempotencyKey: ctx.session.toolUseId,
          payload: { kind: 'shell', command: args.command, cwd },
          schedule: { kind: 'once' },
        })
        return { content: [{ type: 'text', text: `background job ${jobId} started` }] }
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text:
                `background job could not be submitted: ${(e as Error).message}; ` +
                'background execution is unavailable here; run the command in the foreground, in shorter steps if it is long',
            },
          ],
          isError: true,
        }
      }
    }
    // A caller-supplied timeout can only shorten the call. Letting it raise the ceiling would hand
    // the model a way to hold a session open for as long as it likes; a genuinely long command goes
    // through background instead.
    // Only a positive whole number is a shortening request: `Math.min(NaN, ceiling)` is `NaN`, and
    // zero or a negative would ask for no time at all. The parameter schema rejects all three, but
    // this clamp exists precisely because the host is not trusted to have bounded the model before
    // `execute` runs, so it has to hold on its own.
    const asked = args.timeoutMs
    const timeoutMs =
      typeof asked === 'number' && Number.isInteger(asked) && asked > 0
        ? Math.min(asked, ctx.timeoutMs)
        : ctx.timeoutMs
    let r: Awaited<ReturnType<typeof ctx.exec>>
    const startedAt = Date.now()
    try {
      r = await ctx.exec([SHELL_SENTINEL, args.command], { cwd, timeoutMs })
    } catch (e) {
      // A refusal to launch (no interpreter, sandbox denial) is reported to the model as a failed
      // call, which it can react to, rather than as an exception that ends the turn.
      return {
        content: [{ type: 'text', text: `command could not be started: ${(e as Error).message}` }],
        isError: true,
      }
    }
    const parts: string[] = []
    if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''))
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`)
    // An executor that reports nothing (a third-party seam) still has the kernel's cut-off behind it,
    // so only then is a killed-looking result that took the whole limit read as the timeout it was.
    const timedOut = r.timedOut ?? (r.code < 0 && Date.now() - startedAt >= timeoutMs)
    if (timedOut) {
      // Last line on purpose, and no exit line: the code of a killed command says nothing, and the UI
      // reads an `[exit N]` line only when it ends the text.
      if (r.truncated) parts.push('[output truncated by sandbox]')
      parts.push(
        `[timed out after ${timeoutMs}ms: the command and the processes it started were killed; the output above is what was captured, and the command may have taken partial effect. Check the current state before retrying, and split the work into shorter steps or ask for a longer timeoutMs (capped by the deployment).]`,
      )
      return { ...(await guardedResult(ctx, parts.join('\n'))), isError: true }
    }
    parts.push(`[exit ${r.code}]${r.truncated ? ' [output truncated by sandbox]' : ''}`)
    const out = await guardedResult(ctx, parts.join('\n'))
    // Strictly zero, not "not positive": a process killed by a signal is reported with a negative
    // code, and `> 0` would call that a success.
    return r.code === 0 ? out : { ...out, isError: true }
  },
})
