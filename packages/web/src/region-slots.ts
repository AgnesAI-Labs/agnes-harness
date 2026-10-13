export type { ConversationChildContainers, ConversationHandle } from '@agnes/web-units'
export { type ApprovalRegionMount, mountApprovalRegion } from './regions/approval.js'
export { type ComposerRegionMount, mountComposerRegion } from './regions/composer.js'
export {
  APPROVAL_SLOT,
  COMPOSER_SLOT,
  CONVERSATION_CHILD_SLOTS,
  CONVERSATION_SLOT,
  EMPTY_STATE_SLOT,
  type EmptyStateRegionMount,
  SETTINGS_PANE_SLOT,
  SIDEBAR_SLOT,
  settingsPaneSlot,
  TOPBAR_SLOT,
  TRACE_SLOT,
  TRANSCRIPT_SLOT,
} from './regions/contracts.js'
export {
  type ConversationRegionMount,
  type ConversationRegionOptions,
  mountConversationRegion,
} from './regions/conversation.js'
export { mountEmptyStateRegion } from './regions/empty-state.js'
export {
  mountRightbarRegion,
  type RightbarDocument,
  type RightbarRegionMount,
  type RightbarRegionOptions,
} from './regions/rightbar.js'
export {
  mountSettingsPaneRegion,
  type SettingsRegionMount,
  type SettingsRegionOptions,
} from './regions/settings.js'
export { type DshShellRegionMount, mountDshShellRegion } from './regions/shell.js'
export { mountSidebarRegion, type SidebarRegionMount } from './regions/sidebar.js'
export { mountTopbarRegion, type TopbarRegionMount } from './regions/topbar.js'
export { mountTraceRegion, type TraceRegionMount, type TraceRegionOptions } from './regions/trace.js'
export { mountTranscriptRegion, type TranscriptRegionMount } from './regions/transcript.js'
