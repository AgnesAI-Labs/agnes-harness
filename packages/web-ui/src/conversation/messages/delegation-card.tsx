import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { useContext } from 'react'
import { useDocumentLanguage } from '../../document-language.js'
import type { Translate } from '../../locales/index.js'
import { Disclosure } from '../../ui/disclosure.js'
import { Tag } from '../../ui/tag.js'
import type { ToolNode } from './context.js'
import { SubtaskDetailsButton, Subtasks, type SubtaskView } from './subtask-details.js'

export type DelegationStatus = NonNullable<ToolNode['delegatedTask']>['status']

/** Join durable child facts; successful creation alone never means the task has completed. */
export function delegationView(
  node: ToolNode,
  nodes: readonly UINode[] = [],
  turns: readonly UITurn[] = [],
): SubtaskView | undefined {
  const task = node.delegatedTask
  if (!task) return undefined
  let status = task.status
  let trace: UISpan[] = []
  for (const notice of nodes) {
    if (notice.kind !== 'user' || notice.system?.presentation?.kind !== 'child-completed') continue
    const data = notice.system.data
    if (data && typeof data === 'object' && !Array.isArray(data) && data.childKey === task.childKey)
      status = notice.system.presentation.status
  }
  const visit = (span: UISpan): void => {
    if (span.childSessionKey === task.childKey) {
      trace = span.children
      const latest = span.children.filter((child) => child.kind === 'turn').at(-1)
      if (latest)
        status =
          latest.status === 'running' || latest.status === 'waiting'
            ? 'running'
            : latest.status === 'completed'
              ? 'completed'
              : latest.status === 'cancelled'
                ? 'cancelled'
                : 'failed'
      return
    }
    for (const child of span.children) visit(child)
  }
  for (const turn of turns) if (turn.trace) visit(turn.trace)
  return {
    status,
    trace,
    task: task.task,
    role: node.delegatedRole,
    technical: [node.resultPreview, node.argsPreview].filter(Boolean).join('\n\n'),
  }
}

export function DelegationCard({
  node,
  status: initialStatus,
  t,
}: {
  node: ToolNode
  status: DelegationStatus
  t: Translate
}) {
  const view = useContext(Subtasks).get(node.delegatedTask?.childKey ?? '')
  const status = view?.status ?? initialStatus
  const language = useDocumentLanguage()
  const role = node.delegatedRole
  const task = node.delegatedTask
  if (!role || !task) return null
  const title = role.title[language === 'zh-CN' ? 'zh-CN' : 'en'] ?? role.title.en
  const summary = (task.task.trim().split('\n', 1)[0] ?? '').slice(0, 160)
  return (
    <section className="delegation-card" data-testid="delegation-card" data-status={status}>
      <div className="delegation-card-heading">
        <strong data-testid="delegated-role-attribution">{t('timeline.handledBy', { role: title })}</strong>
        <Tag tone={status === 'completed' || status === 'running' ? 'info' : 'bad'}>
          {t(`delegation.status.${status}`)}
        </Tag>
      </div>
      <p>{summary}</p>
      <SubtaskDetailsButton childKey={task.childKey} t={t} />
      <Disclosure variant="plain" summary={t('delegation.technical')}>
        <p>{task.childKey}</p>
        <p>{t('delegation.followUp')}</p>
        <pre>{node.resultPreview}</pre>
        {node.argsPreview && <pre>{node.argsPreview}</pre>}
      </Disclosure>
    </section>
  )
}
