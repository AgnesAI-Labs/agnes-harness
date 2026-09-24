// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (value) => { const parts = value.split(/t/i); if (parts.length !== 2) return false; const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? ''); const time = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2}):(\d{2}))$/i.exec(parts[1] ?? ''); if (!date || !time) return false; const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; if (month < 1 || month > 12 || day < 1 || day > (days[month] ?? 0)) return false; const hour = Number(time[1]), minute = Number(time[2]), second = Number(time[3]); const offsetHour = Number(time[6] || 0), offsetMinute = Number(time[7] || 0); if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) return false; if (second < 60) return true; const sign = time[5] === '-' ? -1 : 1; const utcMinute = minute - offsetMinute * sign; const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0); return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61; })

export const ChannelSchema = Type.Module({
  "Credential": Type.Union([Type.Ref('JwtCredential'), Type.Ref('SourceAuthCredential'), Type.Ref('PortalIdentityCredential'), Type.Ref('LocalCredential'), Type.Ref('ChannelCredential')]),
  "ApprovalAction": Type.Union([Type.Object({ "ticket": Type.String({ maxLength: 128 }), "verdict": Type.Union([Type.Literal('allowed-once'), Type.Literal('allowed-session'), Type.Literal('allowed-permanent'), Type.Literal('rejected')]), "approverCredential": Type.Ref('Credential') }, { additionalProperties: false }), Type.Object({ "requestSeq": Type.Integer({ minimum: 1 }), "verdict": Type.Union([Type.Literal('allowed-once'), Type.Literal('allowed-session'), Type.Literal('allowed-permanent'), Type.Literal('rejected')]), "approverCredential": Type.Ref('Credential') }, { additionalProperties: false }), Type.Object({ "ticket": Type.String({ maxLength: 128 }), "requestSeq": Type.Integer({ minimum: 1 }), "verdict": Type.Union([Type.Literal('allowed-once'), Type.Literal('allowed-session'), Type.Literal('allowed-permanent'), Type.Literal('rejected')]), "approverCredential": Type.Ref('Credential') }, { additionalProperties: false })]),
  "DirectoryEntry": Type.Object({ "kind": Type.Union([Type.Literal('user'), Type.Literal('dept')]), "id": Type.String({ maxLength: 256 }), "name": Type.String({ maxLength: 256 }), "parentId": Type.Optional(Type.String({ maxLength: 256 })), "userIds": Type.Optional(Type.Array(Type.String({ maxLength: 256 }))), "attrs": Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 1024 }))), "deletedAt": Type.Optional(Type.String({ format: "date-time" })), "syncedAt": Type.String({ format: "date-time" }) }, { additionalProperties: false }),
  "ChannelCapabilities": Type.Object({ "edit": Type.Boolean(), "card": Type.Boolean(), "thread": Type.Boolean(), "attachment": Type.Boolean(), "reactions": Type.Optional(Type.Boolean()), "typing": Type.Optional(Type.Boolean()), "voice": Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  "ChannelManifest": Type.Object({ "id": Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }), "displayName": Type.String({ maxLength: 64 }), "version": Type.String({ maxLength: 32 }), "connection": Type.Object({ "modes": Type.Array(Type.Union([Type.Literal('stream'), Type.Literal('websocket'), Type.Literal('longpoll'), Type.Literal('webhook')]), { minItems: 1 }), "default": Type.Union([Type.Literal('stream'), Type.Literal('websocket'), Type.Literal('longpoll'), Type.Literal('webhook')]) }, { additionalProperties: false }), "capabilities": Type.Ref('ChannelCapabilities'), "credentials": Type.Object({ "required": Type.Array(Type.String()), "optional": Type.Array(Type.String()), "exposes": Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" })) }, { additionalProperties: false }), "limits": Type.Object({ "textChars": Type.Integer({ minimum: 1 }), "cardBytes": Type.Integer({ minimum: 1 }), "editWindowMs": Type.Integer({ minimum: 0 }), "rate": Type.Optional(Type.Object({ "perChatPerMin": Type.Optional(Type.Integer({ minimum: 1 })), "perAccountPerSec": Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false })) }, { additionalProperties: false }), "events": Type.Object({ "supported": Type.Array(Type.Union([Type.Literal('message'), Type.Literal('cardAction'), Type.Literal('groupJoin'), Type.Literal('reaction')])) }, { additionalProperties: false }), "directory": Type.Optional(Type.Object({ "supported": Type.Boolean(), "unit": Type.Optional(Type.Union([Type.Literal('dept'), Type.Literal('group')])) }, { additionalProperties: false })) }, { additionalProperties: false }),
  "JwtCredential": Type.Object({ "kind": Type.Literal('jwt'), "token": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "SourceAuthCredential": Type.Object({ "kind": Type.Literal('source-auth'), "timestamp": Type.Integer(), "signature": Type.String({ pattern: "^v0=[0-9a-f]{64}$" }), "nonce": Type.String({ pattern: "^[0-9a-f]{32}$" }) }, { additionalProperties: false }),
  "PortalIdentityCredential": Type.Object({ "kind": Type.Literal('portal-identity'), "token": Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
  "LocalCredential": Type.Object({ "kind": Type.Literal('local') }, { additionalProperties: false }),
  "SurfaceAuthCredential": Type.Object({ "kind": Type.Literal('surface'), "sourceId": Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]{0,63}$" }), "source": Type.Ref('SourceAuthCredential'), "subject": Type.Union([Type.Ref('JwtCredential'), Type.Ref('PortalIdentityCredential')]) }, { additionalProperties: false }),
  "Auth": Type.Union([Type.Ref('JwtCredential'), Type.Ref('SourceAuthCredential'), Type.Ref('PortalIdentityCredential'), Type.Ref('LocalCredential'), Type.Ref('SurfaceAuthCredential')]),
  "ChannelCredential": Type.Object({ "kind": Type.Literal('channel'), "channel": Type.String({ maxLength: 32 }), "accountId": Type.String({ maxLength: 128 }), "userId": Type.String({ maxLength: 256 }), "unionId": Type.Optional(Type.String({ maxLength: 256 })), "chatId": Type.String({ maxLength: 256 }), "chatType": Type.Union([Type.Literal('dm'), Type.Literal('group'), Type.Literal('thread')]), "displayName": Type.Optional(Type.String({ maxLength: 256 })), "raw": Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 1024 }))) }, { additionalProperties: false }),
})

export const Credential = ChannelSchema.Import('Credential')
export type Credential = Static<typeof Credential>
export const ApprovalAction = ChannelSchema.Import('ApprovalAction')
export type ApprovalAction = Static<typeof ApprovalAction>
export const DirectoryEntry = ChannelSchema.Import('DirectoryEntry')
export type DirectoryEntry = Static<typeof DirectoryEntry>
export const ChannelCapabilities = ChannelSchema.Import('ChannelCapabilities')
export type ChannelCapabilities = Static<typeof ChannelCapabilities>
export const ChannelManifest = ChannelSchema.Import('ChannelManifest')
export type ChannelManifest = Static<typeof ChannelManifest>
export const JwtCredential = ChannelSchema.Import('JwtCredential')
export type JwtCredential = Static<typeof JwtCredential>
export const SourceAuthCredential = ChannelSchema.Import('SourceAuthCredential')
export type SourceAuthCredential = Static<typeof SourceAuthCredential>
export const PortalIdentityCredential = ChannelSchema.Import('PortalIdentityCredential')
export type PortalIdentityCredential = Static<typeof PortalIdentityCredential>
export const LocalCredential = ChannelSchema.Import('LocalCredential')
export type LocalCredential = Static<typeof LocalCredential>
export const SurfaceAuthCredential = ChannelSchema.Import('SurfaceAuthCredential')
export type SurfaceAuthCredential = Static<typeof SurfaceAuthCredential>
export const Auth = ChannelSchema.Import('Auth')
export type Auth = Static<typeof Auth>
export const ChannelCredential = ChannelSchema.Import('ChannelCredential')
export type ChannelCredential = Static<typeof ChannelCredential>
