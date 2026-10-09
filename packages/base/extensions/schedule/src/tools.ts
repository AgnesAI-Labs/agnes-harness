import { defineTool, type ToolResult } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { type ScheduleCatalog, ScheduleRejected, type ScheduleWrite } from './catalog.js'

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
  deferLoading: false,
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

function jsonResult(value: unknown): ToolResult {
  const details = value as Exclude<ToolResult['details'], undefined>
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details }
}

type ToolSession = { key: string; depth?: number; toolUseId?: string }

function refused(session: ToolSession) {
  return (session.depth ?? 0) > 0 ? jsonResult({ code: 'subagent_session' }) : undefined
}

function failed(error: unknown) {
  if (error instanceof ScheduleRejected) return jsonResult({ code: error.code })
  return jsonResult({ code: 'internal_error' })
}

export function createScheduleTools(catalog: ScheduleCatalog | undefined) {
  const write = (name: 'schedule_create' | 'schedule_update', description: string, includeAfter: boolean) =>
    defineTool({
      name,
      description,
      parameters: Type.Object(
        {
          ...(name === 'schedule_update' ? { id: Id } : {}),
          title: Title,
          prompt: Prompt,
          selector: selectorSchema(includeAfter),
        },
        { additionalProperties: false },
      ),
      meta: { ...baseMeta, replay: 'never' as const },
      async execute(args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!catalog) return jsonResult({ code: 'internal_error' })
        try {
          const input = { ...args, sessionKey: ctx.session.key } as ScheduleWrite
          const value =
            name === 'schedule_update' && input.id
              ? catalog.update({ ...input, id: input.id })
              : catalog.create(input)
          return jsonResult(value)
        } catch (error) {
          return failed(error)
        }
      },
    })
  return [
    write(
      'schedule_create',
      'Create a reminder on this session. Pass exactly one of after_seconds, at, every_seconds, daily, weekly, or cron. When it is due, the prompt starts this session if it is idle, or resumes it if a turn is already running.',
      true,
    ),
    defineTool({
      name: 'schedule_list',
      description: 'List active reminders for this session, including the next run and recent deliveries.',
      parameters: Type.Object({}, { additionalProperties: false }),
      meta: { ...baseMeta, isReadOnly: true, isConcurrencySafe: true, replay: 'safe' as const },
      async execute(_args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!catalog) return jsonResult({ code: 'internal_error' })
        const schedules = catalog.list({ sessionKey: ctx.session.key })
        return jsonResult({ schedules })
      },
    }),
    write(
      'schedule_update',
      'Update a reminder owned by this session. after_seconds is create-only. Changing the prompt or schedule while a run is in flight returns schedule_conflict.',
      false,
    ),
    defineTool({
      name: 'schedule_delete',
      description:
        'Archive a reminder. An unknown or already archived id returns deleted false. A message that is already queued is not retracted.',
      parameters: Type.Object({ id: Id }, { additionalProperties: false }),
      meta: { ...baseMeta, isDestructive: true, replay: 'idempotent' as const },
      async execute(args, ctx) {
        const blocked = refused(ctx.session)
        if (blocked) return blocked
        if (!catalog) return jsonResult({ code: 'internal_error' })
        const row = catalog.read(args.id)
        if (row && row.sessionKey !== ctx.session.key) return jsonResult({ deleted: false })
        const value = catalog.archive(args.id)
        return jsonResult(value)
      },
    }),
  ]
}
