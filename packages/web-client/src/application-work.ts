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
/** Uses the existing host launch admission; the request stays editable and is never auto-sent. */
export function openApplicationWork(actionId: string, object?: ApplicationWorkObject): void {
  homeNavigation.open('agents', { workAction: applicationWorkRequest(actionId, object) })
}
/** A composer message typed before the workbench's default agent has a session; the launch owns the consent review.
 * `workspace` is the composer's picked workspace path; absent means the launcher's own workspace. */
export type ComposerLaunch = Readonly<{
  agent: string
  prompt: string
  send: boolean
  workspace?: string
  /** Full access was picked before the first send: apply it to the opened session before sending. */
  yolo?: boolean
}>
export function openComposerLaunch(launch: ComposerLaunch): void {
  homeNavigation.open('agents', { composerLaunch: launch })
}
/** The launch is still the application's default agent; the application may have changed since the click. */
export function composerLaunchAgent(launch: ComposerLaunch): string | undefined {
  const app = effectiveApplication()
  return app?.defaultAgent === launch.agent && (!app.agents || app.agents.includes(launch.agent))
    ? launch.agent
    : undefined
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
    prompt: action.prompt[locale] ?? action.prompt.en,
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
  draftMemory.set(sessionId, request)
  try {
    sessionStorage.setItem(key(sessionId), JSON.stringify({ request, agent, title }))
    sessionStorage.setItem(`${key(sessionId)}:draft`, JSON.stringify(request))
  } catch {
    /* optional */
  }
  draftChanged()
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

/** Decode only the bounded explicit work envelope; ordinary user JSON stays ordinary text.
 * The persisted suffix is unchanged. This is presentation context, never authorization. */
export function applicationWorkText(text: string): { text: string; request?: ApplicationWorkRequest } {
  const start = text.lastIndexOf('\n\n{')
  const suffix = (start >= 0 ? text.slice(start + 2) : text).trim()
  if (!suffix.startsWith('{') || suffix.length > 8192) return { text }
  try {
    const value = JSON.parse(suffix)
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.applicationId !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.applicationId) ||
      typeof value.packageId !== 'string' ||
      !value.packageId ||
      value.packageId.length > 512 ||
      typeof value.actionId !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(value.actionId) ||
      Object.keys(value).some((key) => !['applicationId', 'packageId', 'actionId', 'object'].includes(key)) ||
      (value.object !== undefined &&
        (!value.object ||
          typeof value.object.type !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9.-]{0,63}$/.test(value.object.type) ||
          typeof value.object.id !== 'string' ||
          !value.object.id ||
          value.object.id.length > 128 ||
          Object.keys(value.object).some((key) => !['type', 'id'].includes(key))))
    )
      return { text }
    return { text: start >= 0 ? text.slice(0, start) : '', request: value }
  } catch {
    return { text }
  }
}
export function encodeApplicationWork(text: string, request?: ApplicationWorkRequest): string {
  return request ? `${text}\n\n${JSON.stringify(request)}` : text
}
const draftMemory = new Map<string, ApplicationWorkRequest | undefined>()
const draftListeners = new Set<() => void>()
let draftVersion = 0
function draftChanged() {
  draftVersion++
  for (const listener of draftListeners) listener()
}
/** Optional composer memory, separate from the submitted session object. */
export const applicationWorkDraft = {
  subscribe(listener: () => void) {
    draftListeners.add(listener)
    return () => {
      draftListeners.delete(listener)
    }
  },
  getSnapshot: () => draftVersion,
  read(sessionId: string | undefined): ApplicationWorkRequest | undefined {
    if (!sessionId) return undefined
    try {
      const value = draftMemory.has(sessionId)
        ? draftMemory.get(sessionId)
        : JSON.parse(sessionStorage.getItem(`${key(sessionId)}:draft`) ?? 'null')
      return value ? resolveApplicationWork(value, 'en')?.request : undefined
    } catch {
      return undefined
    }
  },
  remove(sessionId: string) {
    draftMemory.set(sessionId, undefined)
    try {
      sessionStorage.removeItem(`${key(sessionId)}:draft`)
    } catch {
      /* optional */
    }
    draftChanged()
  },
}
/** Recover submitted context in a fresh tab, qualified against the active application. */
export function applicationTimelineWork(
  timeline: UITimeline | undefined,
): ApplicationWorkRequest | undefined {
  for (const node of [...(timeline?.nodes ?? [])].reverse()) {
    if (node.kind !== 'user') continue
    for (const block of [...node.content].reverse()) {
      if (block.type !== 'text') continue
      const request = applicationWorkText(block.text).request
      if (request && resolveApplicationWork(request, 'en')) return request
    }
  }
  return undefined
}
