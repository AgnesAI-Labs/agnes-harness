// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const AuthzSchema = Type.Module({
  "Actor": Type.Object({ "id": Type.String({ minLength: 1, maxLength: 256 }), "org": Type.String({ maxLength: 256 }), "role": Type.String({ maxLength: 64 }), "deptPath": Type.Array(Type.String({ maxLength: 256 })), "attrs": Type.Record(Type.String(), Type.String({ maxLength: 1024 })) }, { additionalProperties: false }),
  "Target": Type.Object({ "kind": Type.Union([Type.Literal('datasource'), Type.Literal('db'), Type.Literal('table'), Type.Literal('field'), Type.Literal('model'), Type.Literal('skill'), Type.Literal('mcp'), Type.Literal('kb'), Type.Literal('menu'), Type.Literal('button')]), "id": Type.String({ maxLength: 256 }), "parent": Type.Optional(Type.String({ maxLength: 256 })) }, { additionalProperties: false }),
  "Action": Type.String({ pattern: "^(select|export|execute|discover|admin\\.[a-z_]{1,32})$" }),
  "RowScope": Type.Union([Type.Union([Type.Literal('all_org'), Type.Literal('self'), Type.Literal('own_dept'), Type.Literal('dept_subtree')]), Type.String({ maxLength: 271, pattern: "^named_regions\\[[a-z0-9_-]+(?:,[a-z0-9_-]+)*\\]$" }), Type.String({ pattern: "^ref\\([a-z0-9_-]{1,64}\\)$" })]),
  "Decision": Type.Object({ "decisionId": Type.String({ maxLength: 128 }), "effect": Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('require_approval')]), "rowFilter": Type.Optional(Type.Ref('RowScope')), "fieldMask": Type.Optional(Type.Object({ "visible": Type.Array(Type.String()), "masked": Type.Array(Type.String()) }, { additionalProperties: false })), "limits": Type.Optional(Type.Object({ "maxRows": Type.Optional(Type.Integer({ minimum: 0 })), "exportRequiresGrant": Type.Optional(Type.Boolean()) }, { additionalProperties: false })), "reason": Type.String({ maxLength: 1024 }), "expiresAt": Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }),
})

export const Actor = AuthzSchema.Import('Actor')
export type Actor = Static<typeof Actor>
export const Target = AuthzSchema.Import('Target')
export type Target = Static<typeof Target>
export const Action = AuthzSchema.Import('Action')
export type Action = Static<typeof Action>
export const RowScope = AuthzSchema.Import('RowScope')
export type RowScope = Static<typeof RowScope>
export const Decision = AuthzSchema.Import('Decision')
export type Decision = Static<typeof Decision>
