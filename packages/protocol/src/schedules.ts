import { type Static, Type } from '@sinclair/typebox'
import { AgentRef as AgentRefSchema } from '../gen/ts/extension-manifest.js'

const AgentRef = AgentRefSchema.$defs.AgentRef

const sessionKey = Type.String({ minLength: 1, maxLength: 256 })
const title = Type.String({ minLength: 1, maxLength: 120 })
const prompt = Type.String({ minLength: 1, maxLength: 16000 })
const scheduleId = Type.String({ pattern: '^sched_[0-9a-f]{16}$' })
const time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
const zone = Type.String({ minLength: 1, maxLength: 128 })
const unattendedApproval = Type.Optional(Type.Union([Type.Literal('notify'), Type.Literal('refuse')]))
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

const id = Type.String({ minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })

/**
 * Where a scheduled task runs. `session` appends the prompt to one existing session; `new-session`
 * opens a fresh session in a registered workspace for every run, with an optional loop, bundles,
 * permission preset and model. Unset fields use the same defaults as a new chat.
 */
export const ScheduleTarget = Type.Union([
  Type.Object(
    { kind: Type.Literal('session'), sessionKey, unattendedApproval },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('new-session'),
      unattendedApproval,
      cwd: Type.String({ minLength: 1, maxLength: 4096 }),
      loop: Type.Optional(Type.Object({ id, version: id }, { additionalProperties: false })),
      bundles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 })),
      preset: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      model: Type.Optional(
        Type.Object(
          {
            route: Type.String({ minLength: 1, maxLength: 256 }),
            model: Type.String({ minLength: 1, maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
])

/**
 * One run of a scheduled task. `running`: a turn started and has not ended; `waiting_approval`: that
 * turn is waiting for a person to answer an approval; `needs_attention`: another human decision is required; `ran`: the turn completed; `delivered`: the prompt
 * joined a turn that was already running; `failed`: the run failed or its approval expired; `reason` says why.
 */
export const ScheduleRunOutcome = Type.Union([
  Type.Literal('running'),
  Type.Literal('waiting_approval'),
  Type.Literal('needs_attention'),
  Type.Literal('ran'),
  Type.Literal('delivered'),
  Type.Literal('failed'),
])
export const ScheduleRun = Type.Object(
  {
    at: Type.Integer(),
    outcome: ScheduleRunOutcome,
    needsAttention: Type.Optional(Type.Boolean()),
    sessionKey: Type.Optional(sessionKey),
    endedAt: Type.Optional(Type.Integer()),
    seq: Type.Optional(Type.Integer()),
    /** Stable code: workspace_missing, loop_missing, bundle_unavailable, preset_not_allowed, model_missing, session_unavailable, start_failed, turn_error, interrupted. */
    reason: Type.Optional(Type.String({ maxLength: 64 })),
    detail: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
)

export const ScheduleView = Type.Object(
  {
    id: scheduleId,
    title,
    prompt,
    selector: ScheduleSelector,
    target: ScheduleTarget,
    /** The session that created the task, when one did; the session-scope list reads by it. */
    origin: Type.Optional(sessionKey),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('paused'),
      Type.Literal('archived'),
      Type.Literal('ended'),
    ]),
    nextRunAt: Type.Union([Type.Integer(), Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    runs: Type.Array(ScheduleRun, { maxItems: 20 }),
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
  {
    id: Type.Optional(scheduleId),
    agent: Type.Optional(AgentRef),
    title,
    prompt,
    selector: ScheduleSelector,
    target: ScheduleTarget,
  },
  { additionalProperties: false },
)
const refused = Type.Object(
  { updated: Type.Literal(false), code: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
)
export const SchedulesUpsertResult = Type.Union([ScheduleView, refused])
export const SchedulesArchiveParams = Type.Object({ id: scheduleId }, { additionalProperties: false })
export const SchedulesArchiveResult = Type.Object(
  { deleted: Type.Boolean() },
  { additionalProperties: false },
)
/** Run a task now (its next run moves to now), pause it, or resume a paused one. */
export const SchedulesControlParams = Type.Object(
  {
    id: scheduleId,
    action: Type.Union([Type.Literal('run'), Type.Literal('pause'), Type.Literal('resume')]),
  },
  { additionalProperties: false },
)
export const SchedulesControlResult = Type.Union([ScheduleView, refused])

export type ScheduleTarget = Static<typeof ScheduleTarget>
export type ScheduleRun = Static<typeof ScheduleRun>
export type ScheduleRunOutcome = Static<typeof ScheduleRunOutcome>
export type ScheduleView = Static<typeof ScheduleView>
export type SchedulesListParams = Static<typeof SchedulesListParams>
export type SchedulesListResult = Static<typeof SchedulesListResult>
export type SchedulesUpsertParams = Static<typeof SchedulesUpsertParams>
export type SchedulesUpsertResult = Static<typeof SchedulesUpsertResult>
export type SchedulesArchiveParams = Static<typeof SchedulesArchiveParams>
export type SchedulesArchiveResult = Static<typeof SchedulesArchiveResult>
export type SchedulesControlParams = Static<typeof SchedulesControlParams>
export type SchedulesControlResult = Static<typeof SchedulesControlResult>
