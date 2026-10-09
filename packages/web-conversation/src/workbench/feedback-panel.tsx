import type { UiExtensionContext } from '@agnes/web-client'
import { MessageFeedback } from '@agnes/web-units/message-feedback'
import { panelContext } from './context.js'
export function FeedbackPanel({ context }: { context: UiExtensionContext }) {
  const { session } = panelContext(context)
  return session ? (
    <MessageFeedback key={session.id} sessionId={session.id} target={{ messageSeq: null, turn: null }} />
  ) : null
}
