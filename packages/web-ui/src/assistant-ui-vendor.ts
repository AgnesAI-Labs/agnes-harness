/** One declared web-ui boundary for the headless conversation runtime and its vendor entry. */
export { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
export { ConversationMessages, type ConversationMessagesProps } from './conversation/messages.js'
export {
  type ConversationMessage,
  type ConversationProjection,
  type ConversationProjectionStore,
  createConversationProjectionStore,
  projectConversationMessages,
  useConversationRuntime,
} from './conversation/runtime.js'
