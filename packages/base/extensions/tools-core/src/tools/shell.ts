import { SHELL_SENTINEL, type ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { type ShellJobs, standaloneShellJobs } from '../../../jobs/src/registry.js'
import { runShellJob } from '../../../jobs/src/shell.js'
import { failureCode, toolFailure } from '../guards/feedback.js'
import { guardedResult } from '../guards/output.js'
import {
  DEADLINE_ADVICE,
  deadlineStop,
  deadlineWait,
  shellGuidance,
  timeoutGuidance,
} from '../shell-guidance.js'
import { ShellParams } from './schemas.js'

export { SHELL_SENTINEL }

// Used only when the host states no default, so an older host keeps the default it always had.
const DEFAULT_FOREGROUND_MS = 120_000

export function createShellTool(jobs?: ShellJobs) {
  return defineTool({
    name: 'shell',
    description:
      'Run a command line in the session shell (the runtime context tells you which shell dialect is active). Output is captured; long output is stored as an artifact. timeoutMs sets how long the call may run: without it a default applies, a longer value is granted up to a maximum the deployment sets, and a larger request is capped there. background starts a session-owned job. A foreground wait ends at the timeout or after 2 minutes, whichever is first, and the same process then continues as a background job unless timeoutToBackground is false (then it is killed at the timeout). Processes the command starts with & or nohup keep running as its job after the command ends; any other process it leaves behind is stopped with it. Use job_output, job_list and job_kill to monitor or stop jobs. Set persistent to preserve cwd/env/variables across calls; choose a supported interpreter. sessionId selects an existing persistent shell. A busy shell refuses another command until the previous job finishes. Killing a persistent command closes its shell.',
    parameters: ShellParams,
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: {},
      deferLoading: false,
      commandArg: 'command',
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (jobs && (ctx.platform.shell === 'posix' || ctx.sandbox.openProcess)) {
        const result = await runShellJob(jobs, args, ctx)
        const details = result.details
        const unavailable =
          details &&
          typeof details === 'object' &&
          !Array.isArray(details) &&
          details.code === 'SHELL_JOB_BACKEND_UNAVAILABLE'
        if (args.background || args.persistent || args.sessionId || !unavailable) return result
      }
      const cwd = args.cwd ?? ctx.cwd
      if (args.background)
        return {
          content: [
            {
              type: 'text',
              text: 'background execution is unavailable here; configure the session jobs extension or run the command in the foreground',
            },
          ],
          isError: true,
          details: { code: 'SHELL_BACKGROUND_UNAVAILABLE' },
        }
      // The call runs for the preset default unless the caller asks for time, and a caller may ask for
      // up to the call's limit (`ctx.timeoutMs`, which the deployment sets for this tool); a request
      // beyond it is capped, never refused. There is no background mode to fall back on, so this is
      // how a long command gets its time, and the limit is what keeps one command from holding a
      // session open for as long as the model likes.
      // Only a positive whole number is a request: `Math.min(NaN, limit)` is `NaN`, and zero or a
      // negative would ask for no time at all. The parameter schema rejects all three, but this clamp
      // exists precisely because the host is not trusted to have bounded the model before `execute`
      // runs, so it has to hold on its own.
      const asked = args.timeoutMs
      const requested = typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? asked : undefined
      const ownTimeoutMs = Math.min(requested ?? ctx.defaultTimeoutMs ?? DEFAULT_FOREGROUND_MS, ctx.timeoutMs)
      // In a turn with a time limit the command also stops short of the turn's deadline.
      const { waitMs: timeoutMs, capped: deadlineCapped } = deadlineWait(ctx, ownTimeoutMs)
      let r: Awaited<ReturnType<typeof ctx.exec>>
      const startedAt = Date.now()
      try {
        r = await ctx.exec([SHELL_SENTINEL, args.command], {
          cwd,
          timeoutMs,
          env: { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
        })
      } catch (e) {
        // A refusal to launch (no interpreter, sandbox denial) is reported to the model as a failed
        // call, which it can react to, rather than as an exception that ends the turn.
        return toolFailure(
          ctx,
          failureCode(e, 'SHELL_START_FAILED'),
          `command could not be started (${failureCode(e, 'SHELL_START_FAILED')}); check the selected interpreter and cwd with available file tools; choose an allowed command or ask the user to adjust access.`,
        )
      }
      const parts: string[] = shellGuidance(ctx, args.command, r.stoppedProcesses)
      if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''))
      if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`)
      // An executor that reports nothing (a third-party seam) still has the kernel's cut-off behind it,
      // so only then is a killed-looking result that took the whole limit read as the timeout it was.
      const timedOut = r.timedOut ?? (r.code < 0 && Date.now() - startedAt >= timeoutMs)
      if (timedOut) {
        // Last line on purpose, and no exit line: the code of a killed command says nothing, and the UI
        // reads an `[exit N]` line only when it ends the text.
        if (r.truncated) parts.push('[output truncated by sandbox]')
        if (deadlineCapped) {
          parts.push(
            `[${deadlineStop(ctx, timeoutMs)}. The command and the processes in its process group were killed; the output above is what was captured, and the command may have taken partial effect. ${DEADLINE_ADVICE}]`,
          )
          return {
            ...(await guardedResult(ctx, parts.join('\n'))),
            isError: true,
            details: { code: 'SHELL_TURN_DEADLINE' },
          }
        }
        parts.push(timeoutGuidance(ctx, args.command, cwd, !r.stdout && !r.stderr))
        parts.push(
          `[timed out after ${timeoutMs}ms${requested !== undefined && requested > timeoutMs ? ` (requested ${requested}ms, capped)` : ''}: the command and the processes in its process group were killed; the output above is what was captured, and the command may have taken partial effect. Check the current state before retrying, and split the work into shorter steps or ask for a longer timeoutMs (capped by the deployment).]`,
        )
        return {
          ...(await guardedResult(ctx, parts.join('\n'))),
          isError: true,
          details: { code: 'SHELL_TIMEOUT' },
        }
      }
      if (r.code !== 0)
        parts.push(
          'Command failed; inspect the output and current state, correct the command/arguments, then retry.',
        )
      parts.push(`[exit ${r.code}]${r.truncated ? ' [output truncated by sandbox]' : ''}`)
      const out = await guardedResult(ctx, parts.join('\n'))
      // Strictly zero, not "not positive": a process killed by a signal is reported with a negative
      // code, and `> 0` would call that a success.
      return r.code === 0 ? out : { ...out, isError: true, details: { code: 'SHELL_EXIT', exitCode: r.code } }
    },
  })
}
export const shellTool = createShellTool(standaloneShellJobs)
