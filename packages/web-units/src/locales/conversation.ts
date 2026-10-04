import type { LocaleCatalog } from './index.js'

/** 对话骨架的组件内文案（W4）。经 `ConversationProps.translate` 注入。 */
export const conversationLocaleCatalog: LocaleCatalog = {
  en: {
    'conversation.transcriptAria': 'Conversation',
    'conversation.newContent': 'New content',
  },
  'zh-CN': {
    'conversation.transcriptAria': '对话',
    'conversation.newContent': '有新内容',
  },
}
