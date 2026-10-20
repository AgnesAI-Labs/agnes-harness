import {
  applicationIdentity,
  effectiveApplication,
  openApplicationWork,
  type SessionService,
  sessionAgentAttribution,
} from '@agnes/web-client'
import { Button, useDocumentLanguage } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'

export function ApplicationWorkActions() {
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  const actions = effectiveApplication()?.workbench?.actions
  if (!actions?.length) return null
  return (
    <nav
      className="application-work-actions"
      aria-label={language === 'en' ? 'Work actions' : '工作快捷操作'}
    >
      {actions.map((action) => (
        <Button key={action.id} size="small" onClick={() => openApplicationWork(action.id)}>
          {action.title[language] ?? action.title.en}
        </Button>
      ))}
    </nav>
  )
}

export function ApplicationAttribution({ session }: { session?: SessionService | undefined }) {
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const id = useSyncExternalStore(
    session?.subscribe ?? (() => () => {}),
    session?.getSnapshot ?? (() => undefined),
  )
  const title = sessionAgentAttribution(id)
  const zh = useDocumentLanguage() === 'zh-CN'
  return title ? (
    <p className="application-attribution" data-testid="application-attribution">
      {zh ? `由 ${title} 处理` : `Handled by ${title}`}
    </p>
  ) : null
}
