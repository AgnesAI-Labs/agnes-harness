import type { LocaleCatalog } from './index.js'

/** 对话骨架的组件内文案。经 `ConversationProps.translate` 注入。 */
export const conversationLocaleCatalog: LocaleCatalog = {
  en: {
    'conversation.references': 'Referenced sources',
    'conversation.referenceTruncated': 'Excerpt truncated',
    'conversation.transcriptAria': 'Conversation',
    'conversation.newContent': 'New content',
  },
  'zh-CN': {
    'conversation.references': '引用来源',
    'conversation.referenceTruncated': '摘录已截断',
    'conversation.transcriptAria': '对话',
    'conversation.newContent': '有新内容',
  },
}
