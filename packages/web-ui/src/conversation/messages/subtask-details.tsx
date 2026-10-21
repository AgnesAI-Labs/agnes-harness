import type { UISpan } from '@agnes/protocol'
import { createContext, useContext } from 'react'
import { useDocumentLanguage } from '../../document-language.js'
import type { Translate } from '../../locales/index.js'
import { baseToolTitle } from '../../tool-presentation.js'
import { Button } from '../../ui/button.js'
import { Disclosure } from '../../ui/disclosure.js'
import { PushPage, usePushStack } from '../../ui/push-stack.js'
import type { ToolNode } from './context.js'

export type SubtaskView = {
  status: NonNullable<ToolNode['delegatedTask']>['status']
  trace: UISpan[]
  task: string
  role: ToolNode['delegatedRole']
  technical: string
}
export const Subtasks = createContext<ReadonlyMap<string, SubtaskView>>(new Map())

/** Children remain parent-owned: inspect the existing projection, never admit them as root sessions. */
export function SubtaskDetailsButton({ childKey, t }: { childKey: string; t: Translate }) {
  const navigation = usePushStack()
  return (
    <Button appearance="link" onClick={() => navigation.open(`subtask:${childKey}`)}>
      {t('delegation.open')}
    </Button>
  )
}

/** One page per backend child, shared by its delegation card and completion notice. */
export function SubtaskPages({ t }: { t: Translate }) {
  const tasks = useContext(Subtasks)
  const navigation = usePushStack()
  const language = useDocumentLanguage()
  const selected = [...tasks].find(([childKey]) => navigation.stack.at(-1) === `subtask:${childKey}`)
  if (!selected) return null
  const [childKey, view] = selected
  const title =
    view.role?.title[language === 'zh-CN' ? 'zh-CN' : 'en'] ?? view.role?.title.en ?? t('delegation.open')
  const tools: UISpan[] = []
  const visit = (span: UISpan): void => {
    if (span.kind === 'tool') tools.push(span)
    for (const child of span.children) visit(child)
  }
  for (const span of view.trace) visit(span)
  return (
    <PushPage id={`subtask:${childKey}`} title={title}>
      <div className="delegation-subtask" data-testid="delegation-subtask">
        <p>{view.task}</p>
        <p role="status">{t(`delegation.status.${view.status}`)}</p>
        {tools.length ? (
          <ol>
            {tools.map((span) => (
              <li key={span.id} data-testid="subtask-tool">
                {baseToolTitle(span.name, t) ?? span.name} ·{' '}
                {t(`tool.status.${span.status === 'waiting' ? 'awaitingApproval' : span.status}`)}
              </li>
            ))}
          </ol>
        ) : (
          <p>{t('delegation.noSteps')}</p>
        )}
        <Disclosure variant="plain" summary={t('delegation.technical')}>
          <pre>{view.technical}</pre>
          <pre>{JSON.stringify(view.trace, null, 2)}</pre>
        </Disclosure>
      </div>
    </PushPage>
  )
}
