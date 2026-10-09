// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const JsonValue = Type.Recursive((This) => Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(This), Type.Record(Type.String(), This)]))
export type JsonValue = Static<typeof JsonValue>

export const IntelligentUiSchema = Type.Module({
  "UiKey": Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" }),
  "UiRevision": Type.Integer({ minimum: 1, maximum: 9007199254740991 }),
  "UiJsonSchema": Type.Union([Type.Boolean(), Type.Record(Type.String(), JsonValue)]),
  "UiPlacement": Type.Object({ "inline": Type.Literal(true), "workbench": Type.Literal(true), "preferred": Type.Optional(Type.Union([Type.Literal('inline'), Type.Literal('workbench')])) }, { additionalProperties: false }),
  "UiColumn": Type.Object({ "key": Type.Ref('UiKey'), "label": Type.String({ minLength: 1, maxLength: 256 }), "format": Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('number'), Type.Literal('currency'), Type.Literal('date'), Type.Literal('status')])) }, { additionalProperties: false }),
  "UiChartSeries": Type.Object({ "key": Type.Ref('UiKey'), "label": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  "UiComponent": Type.Union([Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('form'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "dataKey": Type.Ref('UiKey'), "schema": Type.Ref('UiJsonSchema'), "actionIds": Type.Optional(Type.Array(Type.Ref('UiKey'), { minItems: 0, maxItems: 16 })) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('table'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "dataKey": Type.Ref('UiKey'), "rowKey": Type.Ref('UiKey'), "columns": Type.Array(Type.Ref('UiColumn'), { minItems: 1, maxItems: 32 }), "selection": Type.Union([Type.Literal('none'), Type.Literal('single'), Type.Literal('multiple')]), "rowActionIds": Type.Optional(Type.Array(Type.Ref('UiKey'), { minItems: 0, maxItems: 16 })) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('chart'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "dataKey": Type.Ref('UiKey'), "chartType": Type.Union([Type.Literal('bar'), Type.Literal('line'), Type.Literal('pie')]), "categoryKey": Type.Ref('UiKey'), "series": Type.Array(Type.Ref('UiChartSeries'), { minItems: 1, maxItems: 8 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('button-group'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "actionIds": Type.Array(Type.Ref('UiKey'), { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('text'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "dataKey": Type.Ref('UiKey') }, { additionalProperties: false }), Type.Object({ "id": Type.Ref('UiKey'), "kind": Type.Literal('status'), "title": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "dataKey": Type.Ref('UiKey') }, { additionalProperties: false })]),
  "UiArgument": Type.Union([Type.Object({ "literal": JsonValue }, { additionalProperties: false }), Type.Object({ "from": Type.Union([Type.Literal('data'), Type.Literal('input'), Type.Literal('row'), Type.Literal('selection')]), "key": Type.Ref('UiKey'), "pointer": Type.Optional(Type.String({ maxLength: 256, pattern: "^(?:/(?:[^~]|~[01])*)*$" })) }, { additionalProperties: false })]),
  "UiAction": Type.Object({ "id": Type.Ref('UiKey'), "label": Type.String({ minLength: 1, maxLength: 256 }), "tool": Type.String({ minLength: 1, maxLength: 128 }), "argsTemplate": Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }), Type.Ref('UiArgument'), { additionalProperties: false, maxProperties: 32 }), "paramsSchema": Type.Ref('UiJsonSchema'), "confirm": Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })), "style": Type.Optional(Type.Union([Type.Literal('primary'), Type.Literal('secondary'), Type.Literal('danger')])) }, { additionalProperties: false }),
  "UiSurface": Type.Object({ "id": Type.Ref('UiKey'), "revision": Type.Ref('UiRevision'), "title": Type.String({ minLength: 1, maxLength: 256 }), "placement": Type.Ref('UiPlacement'), "components": Type.Array(Type.Ref('UiComponent'), { minItems: 1, maxItems: 32 }), "data": Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }), JsonValue, { additionalProperties: false, maxProperties: 64 }), "actions": Type.Array(Type.Ref('UiAction'), { minItems: 0, maxItems: 32 }) }, { additionalProperties: false }),
  "UiRowContext": Type.Object({ "tableId": Type.Ref('UiKey'), "rowId": Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  "UiActionParams": Type.Object({ "sessionId": Type.String({ minLength: 1, maxLength: 256 }), "surfaceId": Type.Ref('UiKey'), "revision": Type.Ref('UiRevision'), "actionId": Type.Ref('UiKey'), "commandId": Type.String({ minLength: 1, maxLength: 128 }), "input": Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }), JsonValue, { additionalProperties: false, maxProperties: 32 }), "selection": Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$' }), Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 0, maxItems: 1000, uniqueItems: true }), { additionalProperties: false, maxProperties: 32 }), "row": Type.Optional(Type.Ref('UiRowContext')), "confirmed": Type.Optional(Type.Boolean()), "retryOf": Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
  "UiActionStatus": Type.Union([Type.Literal('received'), Type.Literal('rejected'), Type.Literal('pending-approval'), Type.Literal('executing'), Type.Literal('succeeded'), Type.Literal('failed')]),
  "UiRefusal": Type.Object({ "reason": Type.Union([Type.Literal('invalid'), Type.Literal('stale'), Type.Literal('closed'), Type.Literal('duplicate'), Type.Literal('unauthorized')]), "code": Type.Union([Type.Literal('UI_INVALID'), Type.Literal('UI_STALE'), Type.Literal('UI_CLOSED'), Type.Literal('UI_COMMAND_CONFLICT'), Type.Literal('UI_UNAUTHORIZED')]), "message": Type.String({ minLength: 1, maxLength: 1024 }), "currentRevision": Type.Optional(Type.Ref('UiRevision')) }, { additionalProperties: false }),
  "UiFailure": Type.Object({ "code": Type.String({ minLength: 1, maxLength: 128 }), "message": Type.String({ minLength: 1, maxLength: 1024 }), "retryable": Type.Boolean(), "outcomeUnknown": Type.Boolean() }, { additionalProperties: false }),
  "UiActionReceipt": Type.Object({ "sessionId": Type.String({ minLength: 1, maxLength: 256 }), "surfaceId": Type.Ref('UiKey'), "revision": Type.Ref('UiRevision'), "actionId": Type.Ref('UiKey'), "commandId": Type.String({ minLength: 1, maxLength: 128 }), "status": Type.Ref('UiActionStatus'), "seq": Type.Integer({ minimum: 1, maximum: 9007199254740991 }), "duplicate": Type.Boolean(), "invocationId": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "approvalId": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "refusal": Type.Optional(Type.Ref('UiRefusal')), "failure": Type.Optional(Type.Ref('UiFailure')), "resultSeq": Type.Optional(Type.Integer({ minimum: 1, maximum: 9007199254740991 })), "summary": Type.Optional(Type.String({ maxLength: 4096 })), "retryOf": Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
  "UiSurfaceRecord": Type.Object({ "surface": Type.Ref('UiSurface'), "status": Type.Union([Type.Literal('open'), Type.Literal('closed')]), "createdSeq": Type.Integer({ minimum: 1 }), "updatedSeq": Type.Integer({ minimum: 1 }), "owner": Type.String({ minLength: 1, maxLength: 256 }), "lane": Type.String({ minLength: 1, maxLength: 128 }), "taskId": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  "UiReadParams": Type.Object({ "sessionId": Type.String({ minLength: 1, maxLength: 256 }), "surfaceId": Type.Optional(Type.Ref('UiKey')), "commandId": Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), "cursor": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), "limit": Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })) }, { additionalProperties: false }),
  "UiReadResult": Type.Object({ "sessionId": Type.String({ minLength: 1, maxLength: 256 }), "lastSeq": Type.Integer({ minimum: 0 }), "surfaces": Type.Array(Type.Ref('UiSurfaceRecord'), { minItems: 0, maxItems: 16 }), "actions": Type.Array(Type.Ref('UiActionReceipt'), { minItems: 0, maxItems: 64 }), "nextCursor": Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false }),
  "UiRenderParams": Type.Object({ "surface": Type.Ref('UiSurface') }, { additionalProperties: false }),
  "UiUpdateParams": Type.Object({ "surfaceId": Type.Ref('UiKey'), "expectedRevision": Type.Ref('UiRevision'), "surface": Type.Ref('UiSurface') }, { additionalProperties: false }),
  "UiCloseParams": Type.Object({ "surfaceId": Type.Ref('UiKey'), "expectedRevision": Type.Ref('UiRevision'), "reason": Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, { additionalProperties: false }),
})

export const UiKey = IntelligentUiSchema.Import('UiKey')
export type UiKey = Static<typeof UiKey>
export const UiRevision = IntelligentUiSchema.Import('UiRevision')
export type UiRevision = Static<typeof UiRevision>
export const UiJsonSchema = IntelligentUiSchema.Import('UiJsonSchema')
export type UiJsonSchema = Static<typeof UiJsonSchema>
export const UiPlacement = IntelligentUiSchema.Import('UiPlacement')
export type UiPlacement = Static<typeof UiPlacement>
export const UiColumn = IntelligentUiSchema.Import('UiColumn')
export type UiColumn = Static<typeof UiColumn>
export const UiChartSeries = IntelligentUiSchema.Import('UiChartSeries')
export type UiChartSeries = Static<typeof UiChartSeries>
export const UiComponent = IntelligentUiSchema.Import('UiComponent')
export type UiComponent = Static<typeof UiComponent>
export const UiArgument = IntelligentUiSchema.Import('UiArgument')
export type UiArgument = Static<typeof UiArgument>
export const UiAction = IntelligentUiSchema.Import('UiAction')
export type UiAction = Static<typeof UiAction>
export const UiSurface = IntelligentUiSchema.Import('UiSurface')
export type UiSurface = Static<typeof UiSurface>
export const UiRowContext = IntelligentUiSchema.Import('UiRowContext')
export type UiRowContext = Static<typeof UiRowContext>
export const UiActionParams = IntelligentUiSchema.Import('UiActionParams')
export type UiActionParams = Static<typeof UiActionParams>
export const UiActionStatus = IntelligentUiSchema.Import('UiActionStatus')
export type UiActionStatus = Static<typeof UiActionStatus>
export const UiRefusal = IntelligentUiSchema.Import('UiRefusal')
export type UiRefusal = Static<typeof UiRefusal>
export const UiFailure = IntelligentUiSchema.Import('UiFailure')
export type UiFailure = Static<typeof UiFailure>
export const UiActionReceipt = IntelligentUiSchema.Import('UiActionReceipt')
export type UiActionReceipt = Static<typeof UiActionReceipt>
export const UiSurfaceRecord = IntelligentUiSchema.Import('UiSurfaceRecord')
export type UiSurfaceRecord = Static<typeof UiSurfaceRecord>
export const UiReadParams = IntelligentUiSchema.Import('UiReadParams')
export type UiReadParams = Static<typeof UiReadParams>
export const UiReadResult = IntelligentUiSchema.Import('UiReadResult')
export type UiReadResult = Static<typeof UiReadResult>
export const UiRenderParams = IntelligentUiSchema.Import('UiRenderParams')
export type UiRenderParams = Static<typeof UiRenderParams>
export const UiUpdateParams = IntelligentUiSchema.Import('UiUpdateParams')
export type UiUpdateParams = Static<typeof UiUpdateParams>
export const UiCloseParams = IntelligentUiSchema.Import('UiCloseParams')
export type UiCloseParams = Static<typeof UiCloseParams>
export const Root = UiSurface
export type Root = UiSurface
export const X_AGNES_UI_LIMITS = {
  "surfaceBytes": 32768,
  "actionBytes": 16384,
  "factBytes": 65536,
  "projectionBytes": 262144,
  "jsonDepth": 16,
  "schemaDepth": 16,
  "tableRows": 1000,
  "chartPoints": 1000,
  "liveSurfaces": 16,
  "receiptsPerPage": 64,
  "newCommandsPerMinute": 30,
  "pendingCommandsPerSession": 8
} as const
export const X_AGNES_UI_METHODS = {
  "_agnes/v1/ui.action": {
    "params": "UiActionParams",
    "result": "UiActionReceipt"
  },
  "_agnes/v1/ui.read": {
    "params": "UiReadParams",
    "result": "UiReadResult"
  }
} as const
