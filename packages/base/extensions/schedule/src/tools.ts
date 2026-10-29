import type { SchedulingService, ToolContext, ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { ScheduleRejected, type ScheduleTarget, type ScheduleView } from './rules.js'

const Time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', minLength: 5, maxLength: 5 })
const Zone = Type.String({ minLength: 1, maxLength: 64 })
const Title = Type.String({ minLength: 1, maxLength: 200 })
const Prompt = Type.String({ minLength: 1, maxLength: 16_000 })
const Id = Type.String({ minLength: 1, maxLength: 64 })
const baseMeta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  costHint: {},
  deferLoading: 'auto' as const,
  requiresApproval: 'never' as const,
}
const daily = Type.Object({ time: Time, timeZone: Zone }, { additionalProperties: false })
const weekly = Type.Object(
  {
    time: Time,
    timeZone: Zone,
    weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 7 }), { minItems: 1, maxItems: 7 }),
  },
  { additionalProperties: false },
)
const cron = Type.Object(
  { expr: Type.String({ minLength: 1, maxLength: 128 }), timeZone: Type.Optional(Zone) },
  { additionalProperties: false },
)

const atSelector = Type.Object(
  { at: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
)
const everySelector = Type.Object(
  { every_seconds: Type.Integer({ minimum: 60, maximum: 31_622_400 }) },
  { additionalProperties: false },
)
const dailySelector = Type.Object({ daily }, { additionalProperties: false })
const weeklySelector = Type.Object({ weekly }, { additionalProperties: false })
const cronSelector = Type.Object({ cron }, { additionalProperties: false })
const afterSelector = Type.Object(
  { after_seconds: Type.Integer({ minimum: 1, maximum: 31_622_400 }) },
  { additionalProperties: false },
)

function selectorSchema(includeAfter: boolean) {
  return includeAfter
    ? Type.Union([afterSelector, atSelector, everySelector, dailySelector, weeklySelector, cronSelector])
    : Type.Union([atSelector, everySelector, dailySelector, weeklySelector, cronSelector])
}

const Target = Type.Union([Type.Literal('current_session'), Type.Literal('new_session')], {
  description:
    "current_session: the prompt is sent into this conversation when due. new_session: every run opens a fresh session in this session's workspace and runs the prompt there.",
})

function jsonResult(value: unknown): ToolResult {
  const details = value as Exclude<ToolResult['details'], undefined>
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details }
}

type ToolSession = { key: string; depth?: number; toolUseId?: string; workspaceRoot?: string }

function targetFor(choice: 'current_session' | 'new_session', session: ToolSession): ScheduleTarget {
  if (choice === 'current_session') return { kind: 'session', sessionKey: session.key }
  if (!session.workspaceRoot) throw new ScheduleRejected('workspace_missing')
  return { kind: 'new-session', cwd: session.workspaceRoot }
}

/** Where the task runs, in words the reply can repeat to the user. */
function runsIn(target: ScheduleTarget, session: ToolSession): string {
  if (target.kind === 'new-session') return `a new session in ${target.cwd} for every run`
  return target.sessionKey === session.key ? 'this session' : `session ${target.sessionKey}`
}

function echo(value: ScheduleView | { updated: false; code: string }, session: ToolSession) {
  return 'target' in value ? { ...value, runsIn: runsIn(value.target, session) } : value
}

function refused(session: ToolSession) {
  return (session.depth ?? 0) > 0 ? jsonResult({ code: 'subagent_session' }) : undefined
}

function failed(error: unknown) {
  if (error instanceof ScheduleRejected) return jsonResult({ code: error.code })
  const data = (error as { data?: { code?: string } })?.data
  if (data?.code && /^[a-z_]+$/.test(data.code)) return jsonResult({ code: data.code })
  return jsonResult({ code: 'internal_error' })
}

export function createScheduleTools(open: ((ctx: ToolContext) => Promise<SchedulingService>) | undefined) {
  const write = (name: 'schedule_create' | 'schedule_update', description: string, includeAfter: boolean) =>
    defineTool({
      name,
      description,
      parameters: Type.Object(
        {
          ...(name === 'schedule_update' ? { id: Id } : {}),
          title: Title,
          prompt: Prompt,
          unattendedApproval: Type.Optional(Type.Union([Type.Literal('notify'), Type.Literal('refuse')])),
          selector: selectorSchema(includeAfter),
          ...(name === 'schedule_update' ? { target: Type.Optional(Target) } : { target: Target }),
        },
        { additionalProperties: false },
      ),
      meta: { ...baseMeta, replay: 'never' as const },
      async execute(args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!open) return jsonResult({ code: 'internal_error' })
        try {
          const {
            target: choice,
            unattendedApproval,
            ...rest
          } = args as typeof args & {
            target?: 'current_session' | 'new_session'
            id?: string
          }
          const service = await open(ctx)
          const selectedTarget = choice
            ? targetFor(choice, ctx.session)
            : unattendedApproval && rest.id
              ? (await service.get(rest.id))?.target
              : undefined
          const input = {
            ...rest,
            ...(selectedTarget
              ? { target: { ...selectedTarget, ...(unattendedApproval ? { unattendedApproval } : {}) } }
              : {}),
          }
          const value = await service.upsert(input)
          return jsonResult(echo(value, ctx.session))
        } catch (error) {
          return failed(error)
        }
      },
    })
  return [
    write(
      'schedule_create',
      [
        'Create a scheduled task. Pass exactly one of after_seconds, at, every_seconds, daily, weekly, or cron, and choose where it runs with target.',
        'Use new_session for recurring work the user wants done on a schedule ("every day/week, do X"): each run opens a fresh session in this workspace, so runs do not pile into this conversation.',
        'Use current_session for one-off reminders or follow-ups about this conversation ("remind me in 30 minutes", "continue this tomorrow morning"): the prompt is sent here, starting a turn if idle or joining the running one.',
        'If the request is ambiguous, ask the user which they want before creating it. The result says where it will run (runsIn); tell the user.',
      ].join(' '),
      true,
    ),
    defineTool({
      name: 'schedule_list',
      description:
        'List the active scheduled tasks this session created or receives, with where each runs, the next run and recent runs.',
      parameters: Type.Object({}, { additionalProperties: false }),
      meta: { ...baseMeta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' as const },
      async execute(_args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!open) return jsonResult({ code: 'internal_error' })
        try {
          const { schedules } = await (await open(ctx)).list()
          return jsonResult({
            schedules: schedules.map((row) => ({ ...row, runsIn: runsIn(row.target, ctx.session) })),
          })
        } catch (error) {
          return failed(error)
        }
      },
    }),
    write(
      'schedule_update',
      'Update a scheduled task this session created or receives. after_seconds is create-only. Omit target to keep where it runs. Changing the prompt, schedule or target while a run is in flight returns schedule_conflict.',
      false,
    ),
    defineTool({
      name: 'schedule_delete',
      description:
        'Archive a scheduled task. An unknown or already archived id returns deleted false. A message that is already queued is not retracted.',
      parameters: Type.Object({ id: Id }, { additionalProperties: false }),
      meta: { ...baseMeta, isDestructive: true, replay: 'idempotent' as const },
      async execute(args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!open) return jsonResult({ code: 'internal_error' })
        try {
          return jsonResult(await (await open(ctx)).archive({ id: args.id }))
        } catch (error) {
          return failed(error)
        }
      },
    }),
  ]
}
