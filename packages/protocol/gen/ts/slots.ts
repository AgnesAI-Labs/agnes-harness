// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const SlotsSchema = Type.Module({
  "UiSlotName": Type.Union([Type.Literal('tool.card.inline'), Type.Literal('sidebar.action'), Type.Literal('status.line'), Type.Literal('notification')]),
  "GoalSnapshot": Type.Object({ "id": Type.String({ maxLength: 256 }), "revision": Type.Integer({ minimum: 1 }), "objective": Type.String({ minLength: 1, maxLength: 8192 }), "phase": Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('blocked'), Type.Literal('complete')]), "rounds": Type.Integer({ minimum: 0 }), "maxRounds": Type.Integer({ minimum: 1, maximum: 100 }), "creditsUsed": Type.Number({ minimum: 0 }), "budgetCredits": Type.Optional(Type.Number({ minimum: 0 })), "reason": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
  "ToolCardInlinePayload": Type.Object({ "question": Type.Optional(Type.Object({ "id": Type.String({ maxLength: 256 }), "questions": Type.Array(Type.Object({ "id": Type.String({ maxLength: 64 }), "question": Type.String({ maxLength: 1024 }), "options": Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 12 })), "multiple": Type.Optional(Type.Boolean()), "allowFreeText": Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { minItems: 1, maxItems: 4 }) }, { additionalProperties: false })), "deliverables": Type.Optional(Type.Array(Type.Object({ "name": Type.String({ maxLength: 256 }), "description": Type.Optional(Type.String({ maxLength: 1024 })), "lane": Type.String(), "ref": Type.Object({ "sha256": Type.String({ pattern: "^[0-9a-f]{64}$" }), "size": Type.Integer({ minimum: 0 }), "mime": Type.Optional(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false }), { maxItems: 16 })), "title": Type.String({ maxLength: 256 }), "table": Type.Optional(Type.Object({ "columns": Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 }), "rows": Type.Array(Type.Array(Type.String({ maxLength: 1024 })), { maxItems: 500 }) }, { additionalProperties: false })), "chart": Type.Optional(Type.Object({ "kind": Type.Union([Type.Literal('bar'), Type.Literal('line')]), "series": Type.Array(Type.Object({ "name": Type.String({ maxLength: 64 }), "points": Type.Array(Type.Object({ "x": Type.String({ maxLength: 64 }), "y": Type.Number() }, { additionalProperties: false }), { maxItems: 1000 }) }, { additionalProperties: false }), { maxItems: 8 }) }, { additionalProperties: false })), "actions": Type.Optional(Type.Array(Type.Object({ "id": Type.String({ pattern: "^[a-z0-9_-]{1,64}$" }), "label": Type.String({ maxLength: 64 }) }, { additionalProperties: false }), { maxItems: 8 })) }, { additionalProperties: false }),
  "SidebarActionPayload": Type.Object({ "id": Type.String({ pattern: "^[a-z0-9_-]{1,64}$" }), "label": Type.String({ maxLength: 64 }), "icon": Type.Optional(Type.String({ maxLength: 32 })), "disabled": Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  "StatusLinePayload": Type.Object({ "goal": Type.Optional(Type.Ref('GoalSnapshot')), "text": Type.String({ maxLength: 512 }), "level": Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]) }, { additionalProperties: false }),
  "NotificationPayload": Type.Object({ "title": Type.String({ maxLength: 256 }), "body": Type.String({ maxLength: 4096 }), "link": Type.Optional(Type.String({ maxLength: 2048 })) }, { additionalProperties: false }),
})

export const UiSlotName = SlotsSchema.Import('UiSlotName')
export type UiSlotName = Static<typeof UiSlotName>
export const GoalSnapshot = SlotsSchema.Import('GoalSnapshot')
export type GoalSnapshot = Static<typeof GoalSnapshot>
export const ToolCardInlinePayload = SlotsSchema.Import('ToolCardInlinePayload')
export type ToolCardInlinePayload = Static<typeof ToolCardInlinePayload>
export const SidebarActionPayload = SlotsSchema.Import('SidebarActionPayload')
export type SidebarActionPayload = Static<typeof SidebarActionPayload>
export const StatusLinePayload = SlotsSchema.Import('StatusLinePayload')
export type StatusLinePayload = Static<typeof StatusLinePayload>
export const NotificationPayload = SlotsSchema.Import('NotificationPayload')
export type NotificationPayload = Static<typeof NotificationPayload>
export const X_AGNES_SLOT_TABLE = {
  "tool.card.inline": {
    "cardinality": "multi",
    "order": 100,
    "surfaces": [
      "tui",
      "web",
      "channel"
    ],
    "failPolicy": "open",
    "trigger": [
      "tool_result",
      "tool_call"
    ],
    "payload": "ToolCardInlinePayload"
  },
  "sidebar.action": {
    "cardinality": "multi",
    "order": 200,
    "surfaces": [
      "tui",
      "web"
    ],
    "failPolicy": "open",
    "trigger": [
      "turn_end",
      "tick"
    ],
    "payload": "SidebarActionPayload"
  },
  "status.line": {
    "cardinality": "multi",
    "order": 300,
    "surfaces": [
      "tui",
      "web",
      "channel"
    ],
    "failPolicy": "open",
    "trigger": [
      "tick"
    ],
    "payload": "StatusLinePayload"
  },
  "notification": {
    "cardinality": "multi",
    "order": 400,
    "surfaces": [
      "web",
      "channel"
    ],
    "failPolicy": "open",
    "trigger": [
      "turn_end"
    ],
    "payload": "NotificationPayload"
  }
} as const
export const X_AGNES_MAX_BYTES = 65536 as const
