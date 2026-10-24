import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { failureCode, toolFailure } from '../../tools-core/src/guards/feedback.js'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import { shellGuidance, timeoutGuidance } from '../../tools-core/src/shell-guidance.js'
import type { ShellJobs } from './registry.js'

export async function runShellJob(
  jobs: ShellJobs,
  args: {
    command: string
    cwd?: string
    background?: boolean
    timeoutMs?: number
    timeoutToBackground?: boolean
    persistent?: boolean
    shell?: import('./persistent-shell.js').ShellName
    sessionId?: string
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  let id: string | undefined
  try {
    const started =
      args.persistent || args.sessionId
        ? await jobs.startPersistent(args.command, args.cwd, ctx, args.shell, args.sessionId)
        : await jobs.start(args.command, args.cwd ?? ctx.cwd, ctx)
    id = started.id
    const notes = shellGuidance(ctx, args.command)
    const requested = args.timeoutMs
    const waitMs = Math.min(
      typeof requested === 'number' && Number.isInteger(requested) && requested > 0
        ? requested
        : (ctx.defaultTimeoutMs ?? 120000),
      Math.max(1, ctx.timeoutMs - 25),
    )
    const job = args.background ? started : await jobs.wait(ctx, id, waitMs)
    if (job.status === 'running') {
      if (!args.background && args.timeoutToBackground === false) {
        await jobs.kill(ctx, id)
        return {
          content: [
            {
              type: 'text',
              text: `${job.stdout}${job.stderr ? `\n[stderr]\n${job.stderr}` : ''}\n${notes.join('\n')}\n${timeoutGuidance(ctx, args.command, args.cwd ?? ctx.cwd, !job.stdout && !job.stderr)}\n[timed out after ${waitMs}ms; job ${id} and its process group were killed]`,
            },
          ],
          isError: true,
          details: { code: 'SHELL_TIMEOUT' },
        }
      }
      return {
        structured: { jobId: id, status: 'running' },
        content: [
          {
            type: 'text',
            text: `${notes.length ? notes.join('\n') + '\n' : ''}background job ${id} started${args.background ? '' : ` (foreground wait reached ${waitMs}ms; the same process continues)`}; use job_output, job_list or job_kill`,
          },
        ],
        details: {
          jobId: id,
          status: 'running',
          ...(started.sessionId ? { sessionId: started.sessionId } : {}),
        },
      }
    }
    return {
      structured: { jobId: id, status: job.status },
      ...(await guardedResult(
        ctx,
        `${shellGuidance(ctx, args.command, job.stoppedProcesses)
          .map((note) => `${note}\n`)
          .join(
            '',
          )}${job.stdout}${job.stderr ? `\n[stderr]\n${job.stderr}` : ''}${job.code === 0 ? '' : '\nCommand failed; inspect job_output and current state, correct the command/arguments before retrying.'}\n[exit ${job.code}]${job.truncated ? ' [capture limit reached]' : ''}`,
      )),
      ...(job.code === 0 ? {} : { isError: true }),
      details: {
        jobId: id,
        status: job.status,
        code: job.code,
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      },
    }
  } catch (e) {
    if (id && ctx.signal.aborted) await jobs.kill(ctx, id)
    if (!id && (e as { code?: string }).code === 'SANDBOX_UNAVAILABLE')
      return toolFailure(
        ctx,
        'SHELL_JOB_BACKEND_UNAVAILABLE',
        'command backend unavailable; run a foreground command or ask the user to configure the jobs backend.',
      )
    const message = e instanceof Error ? e.message : ''
    const reason: [string, string] =
      message.startsWith('SHELL_BUSY:') || message === 'shell is busy'
        ? [
            'SHELL_BUSY',
            'persistent shell is busy; wait for its running job with job_output before submitting another command',
          ]
        : message === 'unsupported shell; choose bash, zsh or pwsh'
          ? ['SHELL_INVALID_INTERPRETER', 'unsupported interpreter; choose bash, zsh or pwsh']
          : message === 'shell session is closed or is not a persistent shell' ||
              message === 'persistent shell has exited'
            ? [
                'SHELL_SESSION_CLOSED',
                'persistent shell is closed; omit sessionId and start a new persistent shell',
              ]
            : message.startsWith('session job limit reached')
              ? [
                  'SHELL_JOB_LIMIT',
                  'session job limit reached; use job_list and stop an unneeded running job with job_kill',
                ]
              : message === 'job cwd must be readable'
                ? ['SHELL_CWD_UNREADABLE', 'cwd must be readable; use ls to choose an accessible directory']
                : [
                    'SHELL_JOB_FAILED',
                    'command could not be started or continued; inspect job_list/job_output and current state, then choose an accessible cwd and supported interpreter',
                  ]
    return toolFailure(ctx, failureCode(e, reason[0]), reason[1])
  }
}
