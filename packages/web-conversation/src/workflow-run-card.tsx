import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
import { ConversationCardLayout } from '@agnes/web-ui'

/** The workflow extension publishes ordinary public table data; execution stays in the backend. */
export function WorkflowRunCard({
  payload,
  t,
}: {
  payload: ToolCardInlinePayload
  t: (key: string) => string
}) {
  const groups = new Map<string, string[][]>()
  for (const row of payload.table?.rows ?? []) {
    const name = row[0] ?? ''
    const members = groups.get(name) ?? []
    members.push(row)
    groups.set(name, members)
  }
  return (
    <ConversationCardLayout
      className="conversation-native-card"
      data-testid="workflow-run-card"
      aria-label={t('cards.workflow.title')}
    >
      <strong>{payload.title}</strong>
      {payload.table?.rows[0]?.[4] && <p role="status">{t('cards.workflow.' + payload.table.rows[0][4])}</p>}
      {payload.table?.rows[0]?.[5] && <code>{payload.table.rows[0][5]}</code>}
      {[...groups].map(([stage, members]) => (
        <details key={stage} data-testid="workflow-stage">
          <summary>
            {stage} ({members.filter((m) => m[2] === 'completed').length}/{members.length})
          </summary>
          <ul>
            {members.map((member) => (
              <li key={member[1]} data-testid="workflow-member">
                <span>
                  {member[1]} · {t('cards.workflow.' + member[2])}
                </span>
                {member[3] && (
                  <a
                    data-testid="workflow-child-session"
                    href={'?session=' + encodeURIComponent(member[3])}
                    aria-label={t('cards.workflow.open') + ': ' + member[1]}
                  >
                    {' · '}
                    {t('cards.workflow.open')}
                  </a>
                )}
                {member[6] && <p data-testid="workflow-integration">{t('cards.workflow.' + member[6])}</p>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </ConversationCardLayout>
  )
}
