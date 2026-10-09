import type { UINode } from '@agnes/protocol'
import type { ReactNode } from 'react'
import { conversationLocaleCatalog } from '../locales/conversation.js'
import type { Translate } from '../locales/index.js'
import { SettingsDetails } from '../settings-layout.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>
const interactionKinds: Readonly<Record<string, string>> = {
  ask_user_question: 'question',
  update_plan: 'plan',
  present: 'present',
  job_list: 'jobs',
  job_output: 'jobOutput',
  job_kill: 'jobStop',
  schedule_list: 'schedules',
  schedule_upsert: 'scheduleSave',
  schedule_archive: 'scheduleArchive',
}
const english: Translate = (key, vars) =>
  (conversationLocaleCatalog.en?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    String(vars?.[name] ?? match),
  )

/** Presentation only: lifecycle facts still come from the tool projection. */
export function interactionToolPresentation(
  node: ToolNode,
  t: Translate = english,
): { name: string; summary: string } | undefined {
  const kind = interactionKinds[node.name]
  if (!kind) return undefined
  const summary =
    node.status === 'completed' ? t(`tool.interaction.${kind}.completed`) : t(`tool.status.${node.status}`)
  return { name: t(`tool.interaction.${kind}.name`), summary }
}

/** Raw interaction protocol remains inspectable, but is never the primary result. */
export function ConversationInteractionResult({
  summary,
  children,
  t = english,
}: {
  summary?: string | undefined
  children: ReactNode
  t?: Translate
}) {
  return (
    <div data-testid="interaction-result-summary" className="conversation-interaction-result">
      {summary && <p>{summary}</p>}
      <SettingsDetails title={t('tool.detail.expand')} data-testid="interaction-result-details">
        {children}
      </SettingsDetails>
    </div>
  )
}
