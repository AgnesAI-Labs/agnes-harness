import { type Static, Type } from '@sinclair/typebox'

const sessionKey = Type.String({ minLength: 1, maxLength: 256 })
const title = Type.String({ minLength: 1, maxLength: 120 })
const prompt = Type.String({ minLength: 1, maxLength: 16000 })
const scheduleId = Type.String({ pattern: '^sched_[0-9a-f]{16}$' })
const time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
const zone = Type.String({ minLength: 1, maxLength: 128 })
const seconds = Type.Integer({ minimum: 60, maximum: 31622400 })

export const ScheduleSelector = Type.Union([
  Type.Object(
    { after_seconds: Type.Integer({ minimum: 1, maximum: 31622400 }) },
    { additionalProperties: false },
  ),
  Type.Object({ at: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
  Type.Object({ every_seconds: seconds }, { additionalProperties: false }),
  Type.Object(
    { daily: Type.Object({ time, timeZone: zone }, { additionalProperties: false }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      weekly: Type.Object(
        {
          time,
          timeZone: zone,
          weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 7 }), { minItems: 1, maxItems: 7 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      cron: Type.Object(
        { expr: Type.String({ minLength: 1, maxLength: 128 }), timeZone: Type.Optional(zone) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
])

export const ScheduleDelivery = Type.Object(
  {
    at: Type.Integer(),
    seq: Type.Optional(Type.Integer()),
    reason: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
)

export const ScheduleView = Type.Object(
  {
    id: scheduleId,
    sessionKey,
    title,
    prompt,
    selector: ScheduleSelector,
    status: Type.Union([Type.Literal('active'), Type.Literal('archived'), Type.Literal('ended')]),
    nextRunAt: Type.Union([Type.Integer(), Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    deliveries: Type.Array(ScheduleDelivery, { maxItems: 20 }),
  },
  { additionalProperties: false },
)

export const SchedulesListParams = Type.Object(
  {
    scope: Type.Union([Type.Literal('session'), Type.Literal('all')]),
    sessionKey: Type.Optional(sessionKey),
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export const SchedulesListResult = Type.Object(
  { schedules: Type.Array(ScheduleView, { maxItems: 500 }) },
  { additionalProperties: false },
)
export const SchedulesUpsertParams = Type.Object(
  { sessionKey, id: Type.Optional(scheduleId), title, prompt, selector: ScheduleSelector },
  { additionalProperties: false },
)
export const SchedulesUpsertResult = Type.Union([
  ScheduleView,
  Type.Object(
    { updated: Type.Literal(false), code: Type.String({ minLength: 1, maxLength: 64 }) },
    { additionalProperties: false },
  ),
])
export const SchedulesArchiveParams = Type.Object({ id: scheduleId }, { additionalProperties: false })
export const SchedulesArchiveResult = Type.Object(
  { deleted: Type.Boolean() },
  { additionalProperties: false },
)

export type ScheduleView = Static<typeof ScheduleView>
export type SchedulesListParams = Static<typeof SchedulesListParams>
export type SchedulesListResult = Static<typeof SchedulesListResult>
export type SchedulesUpsertParams = Static<typeof SchedulesUpsertParams>
export type SchedulesUpsertResult = Static<typeof SchedulesUpsertResult>
export type SchedulesArchiveParams = Static<typeof SchedulesArchiveParams>
export type SchedulesArchiveResult = Static<typeof SchedulesArchiveResult>
