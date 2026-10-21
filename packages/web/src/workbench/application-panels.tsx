import {
  applicationIdentity,
  applicationTimelineWork,
  effectiveApplication,
  type HomeEntry,
  homeEntries,
  resolveHomeEntry,
  sessionApplicationWork,
  type UiExtensionContext,
  type WorkbenchPanel,
} from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { ApplicationEvidence } from './application-evidence.js'
import { ApprovalMirror } from './approval-panel.js'

function Signatures() {
  return <ApprovalMirror signatures />
}
function pageComponent(page: HomeEntry, object: unknown): WorkbenchPanel['component'] {
  return function ApplicationPage({ context }) {
    return <page.component context={{ ...context, selection: { object, applicationPanel: true } }} />
  }
}
/** Effective consent + owner-qualified, ready page contributions are the only tab sources. */
export function useApplicationPanels(context: UiExtensionContext): readonly WorkbenchPanel[] {
  const application = useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const pages = useSyncExternalStore(homeEntries.subscribe, homeEntries.getSnapshot)
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  const workbench = (context.data ?? {}) as WorkbenchContext
  const work = sessionApplicationWork(workbench.session?.id)
  const request = applicationTimelineWork(workbench.timeline) ?? work?.request
  const objectKey = JSON.stringify(request?.object)
  const hasSession = Boolean(workbench.session)
  return useMemo(() => {
    void pages
    const object = objectKey ? JSON.parse(objectKey) : undefined
    const app = application?.status === 'active' ? application.effective : undefined
    return (app?.workbench?.tabs ?? []).flatMap((tab) => {
      const page = tab.page ? resolveHomeEntry(tab.page) : undefined
      if (tab.view === 'page' && !page) return []
      if (!hasSession || (tab.when === 'object' && !object)) return []
      return [
        {
          id: `application.${tab.id}`,
          order: tab.order,
          edge: 'right' as const,
          titleKey: '',
          title: () => tab.title[language] ?? tab.title.en,
          ...(tab.icon ? { icon: tab.icon } : {}),
          component:
            tab.view === 'signatures'
              ? Signatures
              : tab.view === 'evidence'
                ? ApplicationEvidence
                : pageComponent(page!, object),
        },
      ]
    })
  }, [application, pages, language, hasSession, objectKey])
}
/** Focus the declared object tab once after a reviewed launch, including an asynchronous page load. */
export function useApplicationPanelFocus(
  context: UiExtensionContext,
  panels: readonly WorkbenchPanel[],
  open: (id: string) => void,
) {
  const sessionId = ((context.data ?? {}) as WorkbenchContext).session?.id
  const focused = useRef<string>()
  const work = sessionApplicationWork(sessionId)
  const app = effectiveApplication()
  const request =
    applicationTimelineWork(((context.data ?? {}) as WorkbenchContext).timeline) ?? work?.request
  const action = app?.workbench?.actions?.find((item) => item.id === request?.actionId)
  const target = action?.focusTab && `application.${action.focusTab}`
  useEffect(() => {
    if (
      !sessionId ||
      focused.current === sessionId ||
      !target ||
      !panels.some((panel) => panel.id === target)
    )
      return
    focused.current = sessionId
    open(target)
  }, [sessionId, target, panels, open])
}
