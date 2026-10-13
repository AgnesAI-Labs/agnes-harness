/**
 * Ant Design X behind the web-ui component layer. Applications and plugins import these names
 * from `@agnes/web-ui/x`; the library itself is never imported outside this package.
 *
 * The components are presentational: they render what the caller's store holds. The x-sdk chat
 * runtime, Mermaid and the syntax highlighter are intentionally not part of this surface.
 */
export {
  Actions,
  type ActionsFeedbackProps,
  type ActionsItemProps,
  type ActionsProps,
  Attachments,
  type AttachmentsProps,
  Bubble,
  type BubbleItemType,
  type BubbleListProps,
  type BubbleProps,
  type ConversationItemType,
  Conversations,
  type ConversationsProps,
  FileCard,
  type FileCardListProps,
  type FileCardProps,
  Prompts,
  type PromptsItemType,
  type PromptsProps,
  Sources,
  type SourcesProps,
  Suggestion,
  type SuggestionProps,
  Think,
  type ThinkProps,
  ThoughtChain,
  type ThoughtChainItemProps,
  type ThoughtChainItemType,
  type ThoughtChainProps,
  Welcome,
  type WelcomeProps,
} from '@ant-design/x'
export { Sender, type SenderInputAttributes, type SenderProps, type SenderRef } from '../ui/sender.js'
export { XProvider, type XProviderProps } from './provider.js'
