/**
 * The activity view: the brain's device calls in the current conversation, newest first, drawn
 * with the same cards as the conversation. The host supplies the calls; a page without a session
 * has no activity view.
 */
import { ToolCard, type ToolNode } from '../cards/cards.js'
import { t } from '../i18n/i18n.js'
import { useLocale } from '../react/hooks.js'

export function Activity(props: { calls: ToolNode[] | undefined }) {
  useLocale()
  if (!props.calls) return <div className="mhs-empty">{t('activity.nosession')}</div>
  if (props.calls.length === 0) return <div className="mhs-empty">{t('activity.empty')}</div>
  return (
    <div className="mhs-activity">
      {props.calls.map((node) => (
        <ToolCard key={node.toolUseId} owner={{ block: node }} />
      ))}
    </div>
  )
}
