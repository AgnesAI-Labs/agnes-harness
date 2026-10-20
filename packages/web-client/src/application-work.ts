import type { ApplicationWorkObject, UITimeline } from '@agnes/protocol'
import { applicationIdentity, effectiveApplication } from './application-identity.js'
import { homeNavigation } from './ui-registries.js'

export type ApplicationWorkRequest = Readonly<{
  applicationId: string
  packageId: string
  actionId: string
  object?: ApplicationWorkObject
}>
/** Explicit presentation context, never a permission, actor or backend business fact. */
export function applicationWorkRequest(
  actionId: string,
  object?: ApplicationWorkObject,
): ApplicationWorkRequest {
  const app = effectiveApplication()
  const packageId = applicationIdentity.getSnapshot()?.selection?.packageId
  if (!packageId || !app?.workbench?.actions?.some((action) => action.id === actionId))
    throw new Error('Application action unavailable')
  if (
    object &&
    (typeof object.type !== 'string' ||
      typeof object.id !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9.-]{0,63}$/.test(object.type) ||
      !object.id ||
      object.id.length > 128)
  )
    throw new Error('Invalid application object')
  return {
    applicationId: app.id,
    packageId,
    actionId,
    ...(object ? { object: { type: object.type, id: object.id } } : {}),
  }
}
/** Uses the existing host launch review; the request stays editable and is never auto-sent. */
export function openApplicationWork(actionId: string, object?: ApplicationWorkObject): void {
  homeNavigation.open('agents', { workAction: applicationWorkRequest(actionId, object) })
}
export function resolveApplicationWork(request: ApplicationWorkRequest, locale: 'en' | 'zh-CN') {
  const app = effectiveApplication()
  if (
    !app ||
    app.id !== request.applicationId ||
    applicationIdentity.getSnapshot()?.selection?.packageId !== request.packageId
  )
    return undefined
  const action = app.workbench?.actions?.find((item) => item.id === request.actionId)
  const agent = action?.agent ?? app.defaultAgent
  if (!action || !agent || (app.agents && !app.agents.includes(agent))) return undefined
  const object = request.object ?? action.object
  if (object) applicationWorkRequest(action.id, object)
  return {
    agent,
    prompt:
      (action.prompt[locale] ?? action.prompt.en) +
      (object
        ? `\n\n${JSON.stringify({ applicationId: app.id, packageId: request.packageId, actionId: action.id, object })}`
        : ''),
    request: { ...request, ...(object ? { object } : {}) },
    focusTab: action.focusTab,
  }
}
const key = (id: string) => `agnes.application-work:${id}`
/** Bound only after the server returns the launched session id. Optional UI memory. */
export function rememberApplicationWork(
  sessionId: string,
  request: ApplicationWorkRequest,
  agent: string,
  title: { en: string; 'zh-CN'?: string },
): void {
  try {
    sessionStorage.setItem(key(sessionId), JSON.stringify({ request, agent, title }))
  } catch {
    /* optional */
  }
}
export function sessionApplicationWork(
  sessionId: string | undefined,
): { request: ApplicationWorkRequest; agent: string; title: string } | undefined {
  if (!sessionId) return undefined
  try {
    const value = JSON.parse(sessionStorage.getItem(key(sessionId)) ?? 'null')
    if (!value || !value.title || typeof value.title.en !== 'string' || typeof value.agent !== 'string')
      return undefined
    const resolved = resolveApplicationWork(
      value.request,
      document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en',
    )
    return resolved?.agent === value.agent
      ? { ...value, title: value.title[document.documentElement.lang] ?? value.title.en }
      : undefined
  } catch {
    return undefined
  }
}

export function rememberSessionAgent(
  sessionId: string,
  agent: string,
  title: { en: string; 'zh-CN'?: string },
): void {
  try {
    sessionStorage.setItem(`agnes.session-agent:${sessionId}`, JSON.stringify({ agent, title }))
  } catch {
    /* optional */
  }
}
export function sessionAgentAttribution(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  try {
    const saved = JSON.parse(sessionStorage.getItem(`agnes.session-agent:${sessionId}`) ?? 'null')
    const app = effectiveApplication()
    if (saved && app && (!app.agents || app.agents.includes(saved.agent)))
      return saved.title?.[document.documentElement.lang] ?? saved.title?.en
    return sessionApplicationWork(sessionId)?.title
  } catch {
    return undefined
  }
}

/** Recover the explicit submitted object from durable user content, including a fresh browser tab.
 * This is request context only: never infer an actor, approval or write authorization from it. */
export function applicationTimelineWork(
  timeline: UITimeline | undefined,
): ApplicationWorkRequest | undefined {
  const app = effectiveApplication()
  if (!app) return undefined
  for (const node of [...(timeline?.nodes ?? [])].reverse()) {
    if (node.kind !== 'user') continue
    for (const block of [...node.content].reverse()) {
      if (block.type !== 'text') continue
      const start = block.text.lastIndexOf('\n\n{')
      const text = (start >= 0 ? block.text.slice(start + 2) : block.text).trim()
      if (!text.startsWith('{') || text.length > 8192) continue
      try {
        const value = JSON.parse(text)
        if (
          value.applicationId !== app.id ||
          value.packageId !== applicationIdentity.getSnapshot()?.selection?.packageId ||
          typeof value.actionId !== 'string'
        )
          continue
        return applicationWorkRequest(value.actionId, value.object)
      } catch {
        /* Other user content is ordinary conversation, not structured work context. */
      }
    }
  }
  return undefined
}
