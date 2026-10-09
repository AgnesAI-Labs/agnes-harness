import type { UiExtensionContext } from '@agnes/web-client'
import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { SettingsState } from '@agnes/web-ui'
import { MessageFeedback } from '@agnes/web-units/message-feedback'
import { panelContext } from './context.js'
export function FeedbackPanel({ context }: { context: UiExtensionContext }) {
  const { session } = panelContext(context)
  return session ? (
    <MessageFeedback
      key={session.id}
      sessionId={session.id}
      target={{ messageSeq: null, turn: null }}
      openEvidence={(candidateId) => {
        if (
          !factChainLinks.open({
            sessionId: session.id,
            laneId: 'main',
            anchor: { kind: 'authoring', candidateId },
          })
        )
          workbenchNavigation.open('facts')
      }}
    />
  ) : (
    <SettingsState>{context.t('workbench.session')}</SettingsState>
  )
}
