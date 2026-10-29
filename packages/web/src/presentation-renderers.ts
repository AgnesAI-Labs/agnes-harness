/** Public optional rendering helpers. State and operations are supplied through presentation ports.
 * Providers may use these renderers or implement the same public role contract independently.
 */

export { bindNavigationHistory } from './navigation-history.js'
export { type ComposerRegionMount, mountComposerRegion } from './regions/composer.js'
export { type ConversationRegionMount, mountConversationRegion } from './regions/conversation.js'
export { mountSidebarRegion, type SidebarRegionMount } from './regions/sidebar.js'
export { mountTranscriptRegion, type TranscriptRegionMount } from './regions/transcript.js'
