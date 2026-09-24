import { UI_SLOT_NAMES } from '@agnes/protocol'
import type {
  NotificationPayload,
  SidebarActionPayload,
  StatusLinePayload,
  ToolCardInlinePayload,
} from '@agnes/protocol/gen/slots'
import type { SessionRef } from './common.js'
import type { ProjectionReader } from './projections.js'

export { isJsonPayload, SLOT_PAYLOAD_MAX_BYTES } from './json-payload.js'

export const SLOT_NAMES = Object.freeze([...UI_SLOT_NAMES] as const)
export type SlotName = (typeof SLOT_NAMES)[number]
export type SlotSpec = {
  cardinality: 'single' | 'multi'
  order: number
  surfaces: readonly ('tui' | 'web' | 'channel')[]
  failPolicy: 'open' | 'closed'
}
export interface SlotPayloadMap {
  'tool.card.inline': ToolCardInlinePayload
  'sidebar.action': SidebarActionPayload
  'status.line': StatusLinePayload
  notification: NotificationPayload
}
export interface SlotContext {
  readonly projections: ProjectionReader
  readonly session: SessionRef
  readonly surface: 'tui' | 'web' | 'channel'
  readonly trigger:
    | { readonly kind: 'tool_result'; readonly toolUseId: string }
    | { readonly kind: 'turn_end' }
    | { readonly kind: 'tick' }
}
export type SlotFill<S extends SlotName> = (
  ctx: SlotContext,
) => SlotPayloadMap[S] | null | Promise<SlotPayloadMap[S] | null>
