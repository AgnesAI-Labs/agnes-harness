import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../../tools-core/src/guards/output.js'
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
              text: `[timed out after ${waitMs}ms; job ${id} and its process group were killed]`,
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `background job ${id} started${args.background ? '' : ` (foreground wait reached ${waitMs}ms; the same process continues)`}; use job_output, job_list or job_kill`,
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
      ...(await guardedResult(
        ctx,
        `${job.stdout}${job.stderr ? `\n[stderr]\n${job.stderr}` : ''}\n[exit ${job.code}]${job.truncated ? ' [capture limit reached]' : ''}`,
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
    return {
      content: [{ type: 'text', text: `command could not be started or continued: ${String(e)}` }],
      isError: true,
      ...(!id && (e as { code?: string }).code === 'SANDBOX_UNAVAILABLE'
        ? { details: { code: 'SHELL_JOB_BACKEND_UNAVAILABLE' } }
        : {}),
    }
  }
}
