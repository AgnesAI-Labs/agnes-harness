import { defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'
import type { ShellJobs } from './registry.js'

export const ShellSchema = Type.Union([Type.Literal('bash'), Type.Literal('zsh'), Type.Literal('pwsh')])
const id = { jobId: Type.String({ minLength: 1 }) }
const size = {
  columns: Type.Integer({ minimum: 1, maximum: 1000 }),
  rows: Type.Integer({ minimum: 1, maximum: 1000 }),
}
export const SignalSchema = Type.Union([
  Type.Literal('SIGINT'),
  Type.Literal('SIGTERM'),
  Type.Literal('SIGHUP'),
])
const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: 'never' as const,
  costHint: {},
  deferLoading: false,
  requiresApproval: undefined,
}

export function createPtyTools(jobs: ShellJobs) {
  return [
    defineTool({
      name: 'pty_open',
      description:
        'Open a session-owned interactive PTY using bash, zsh or pwsh under the active sandbox preset. Returns a jobId; use pty_read/send/signal/resize/close. It survives calls, but not Host restart.',
      parameters: Type.Object(
        {
          shell: Type.Optional(ShellSchema),
          cwd: Type.Optional(Type.String()),
          columns: Type.Optional(size.columns),
          rows: Type.Optional(size.rows),
        },
        { additionalProperties: false },
      ),
      meta,
      async execute(args, ctx) {
        try {
          const job = await jobs.openTerminal(
            ctx,
            args.shell ?? (ctx.platform.shell === 'powershell' ? 'pwsh' : 'bash'),
            args.cwd ?? ctx.cwd,
            { columns: args.columns ?? 100, rows: args.rows ?? 30 },
          )
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(job) }],
            details: { jobId: job.id },
          }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'pty_read',
      description: 'Read retained terminal output/status. waitMs waits without terminating the PTY.',
      parameters: Type.Object(
        { ...id, waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })) },
        { additionalProperties: false },
      ),
      meta: {
        ...meta,
        isReadOnly: true,
        isDestructive: false,
        isOpenWorld: false,
        replay: 'safe' as const,
        requiresApproval: 'never' as const,
      },
      async execute(args, ctx) {
        try {
          const job = await jobs.wait(ctx, args.jobId, Math.min(args.waitMs ?? 0, ctx.timeoutMs))
          return {
            ...(await guardedResult(ctx, JSON.stringify(job))),
            details: { jobId: job.id, status: job.status },
          }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'pty_send',
      description: 'Send exact text to an interactive PTY. Include newline to submit a command.',
      parameters: Type.Object(
        { ...id, text: Type.String({ maxLength: 65536 }) },
        { additionalProperties: false },
      ),
      meta,
      async execute(args, ctx) {
        try {
          await jobs.send(ctx, args.jobId, args.text)
          return { content: [{ type: 'text' as const, text: 'sent' }] }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'pty_signal',
      description: 'Signal the PTY foreground process (SIGINT) or session (SIGTERM/SIGHUP).',
      parameters: Type.Object({ ...id, signal: SignalSchema }, { additionalProperties: false }),
      meta,
      async execute(args, ctx) {
        try {
          await jobs.signal(ctx, args.jobId, args.signal)
          return { content: [{ type: 'text' as const, text: 'signal sent' }] }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'pty_resize',
      description: 'Resize a PTY and notify its foreground process.',
      parameters: Type.Object({ ...id, ...size }, { additionalProperties: false }),
      meta,
      async execute(args, ctx) {
        try {
          await jobs.resize(ctx, args.jobId, args.columns, args.rows)
          return { content: [{ type: 'text' as const, text: 'resized' }] }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
    defineTool({
      name: 'pty_list',
      description: 'List this session/lane PTYs, including stopped terminals.',
      parameters: Type.Object({}, { additionalProperties: false }),
      meta: {
        ...meta,
        isReadOnly: true,
        isDestructive: false,
        isOpenWorld: false,
        replay: 'safe' as const,
        requiresApproval: 'never' as const,
      },
      async execute(_args, ctx) {
        return guardedResult(
          ctx,
          JSON.stringify(
            jobs
              .list(ctx)
              .filter((job) => job.kind === 'pty')
              .map(({ stdout, stderr, ...job }) => job),
          ),
        )
      },
    }),
    defineTool({
      name: 'pty_close',
      description: 'Kill a PTY and its processes and join cleanup. The closed job remains readable.',
      parameters: Type.Object(id, { additionalProperties: false }),
      meta,
      async execute(args, ctx) {
        try {
          const job = await jobs.kill(ctx, args.jobId)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ id: job.id, status: job.status }) }],
          }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      },
    }),
  ]
}
