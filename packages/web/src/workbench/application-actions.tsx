import {
  type ApplicationWorkRequest,
  applicationIdentity,
  applicationWorkDraft,
  effectiveApplication,
  openApplicationWork,
  type SessionService,
  sessionAgentAttribution,
} from '@agnes/web-client'
import { Button, useDocumentLanguage } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { useWorkLaunchQuiet } from '../pages/work-launch.js'

export function ApplicationWorkActions() {
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  const launching = useWorkLaunchQuiet()
  const actions = effectiveApplication()?.workbench?.actions
  if (!actions?.length) return null
  return (
    <nav
      className="application-work-actions"
      aria-label={language === 'en' ? 'Work actions' : '工作快捷操作'}
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          size="small"
          disabled={launching}
          onClick={() => openApplicationWork(action.id)}
        >
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
    <span className="application-attribution" data-testid="application-attribution">
      {zh ? `由 ${title} 处理` : `Handled by ${title}`}
    </span>
  ) : null
}

export function ApplicationWorkChip({
  request,
  onRemove,
}: {
  request: ApplicationWorkRequest
  onRemove?: () => void
}) {
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  const app = effectiveApplication()
  const action =
    app?.id === request.applicationId &&
    applicationIdentity.getSnapshot()?.selection?.packageId === request.packageId
      ? app.workbench?.actions?.find((item) => item.id === request.actionId)
      : undefined
  const title =
    action?.title[language] ?? action?.title.en ?? (language === 'en' ? 'Application context' : '应用上下文')
  const label = [request.object?.id, title].filter(Boolean).join(' · ')
  return (
    <span className="application-work-chip" data-testid="application-work-chip">
      <span>{label}</span>
      {onRemove && (
        <Button
          size="small"
          aria-label={language === 'en' ? `Remove context: ${label}` : `移除上下文：${label}`}
          onClick={onRemove}
        >
          ×
        </Button>
      )}
    </span>
  )
}
export function ApplicationComposerContext({ sessionId }: { sessionId: string | undefined }) {
  useSyncExternalStore(applicationWorkDraft.subscribe, applicationWorkDraft.getSnapshot)
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const request = applicationWorkDraft.read(sessionId)
  return request && sessionId ? (
    <div className="application-composer-context">
      <ApplicationWorkChip request={request} onRemove={() => applicationWorkDraft.remove(sessionId)} />
    </div>
  ) : null
}
