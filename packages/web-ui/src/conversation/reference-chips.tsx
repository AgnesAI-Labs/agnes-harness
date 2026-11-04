import type { UINode } from '@agnes/protocol'
import type { Translate } from '../locales/index.js'
import { Icon } from '../ui/icon.js'

/** Receipts travel with the user message; excerpts remain available in the execution trace. */
export function UserMessageReferences({
  node,
  t,
}: {
  node: Extract<UINode, { kind: 'user' }>
  t: Translate
}) {
  const references = node.content.flatMap((block) =>
    block.type === 'text' && block.reference ? [block.reference] : [],
  )
  if (!references.length) return null
  return (
    <ul
      className="reference-chips user-message-references"
      data-testid="reference-sent-chips"
      aria-label={t('conversation.references')}
    >
      {references.map((reference) => (
        <li
          key={`${reference.source}:${reference.id}:${reference.hash}`}
          data-testid="reference-sent-chip"
          data-source={reference.source}
          title={`${reference.id}\nSHA-256: ${reference.hash}`}
        >
          {reference.source === 'session' ? (
            <a href={`?session=${encodeURIComponent(reference.id)}`} data-testid="reference-session-link">
              <span className="reference-sent-icon" aria-hidden="true">
                <Icon name="message-square" size={16} />
              </span>
              <span className="reference-sent-label">{reference.label}</span>
            </a>
          ) : (
            <span className="reference-sent-static">
              <span className="reference-sent-icon" aria-hidden="true">
                <Icon name="link" size={16} />
              </span>
              <span className="reference-sent-label">{reference.label}</span>
            </span>
          )}
          {reference.truncated && <small>{t('conversation.referenceTruncated')}</small>}
        </li>
      ))}
    </ul>
  )
}
