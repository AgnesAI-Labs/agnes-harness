const MAX_ROUTE_LENGTH = 8192
const pageId = /^[a-z][a-z0-9.-]{0,127}$/u
const routeId = /^[a-z][a-z0-9._-]{0,127}$/u
const packageId = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u
const settingsAnchor = /^#settings-subsection-[a-z0-9-]{1,128}$/u
const workspaceIdPattern = /^[a-f0-9]{64}$/u

const bounded = (value: string, max: number) =>
  value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)

export function isSkillsRoute(query: URLSearchParams): boolean {
  return (
    query.get('settings') === 'skills' ||
    (query.get('page') === 'plugins' && query.get('tab') === 'skills' && !query.has('pagePackage'))
  )
}

export function isDraftRoute(query: URLSearchParams): boolean {
  return query.get('new') === '1' && !query.has('session')
}

/** A draft's workspace belongs to the composer even when Skills is open. */
export function skillsWorkspaceId(query: URLSearchParams): string | undefined {
  const id = query.get('workspaceId')
  return id && workspaceIdPattern.test(id) && isSkillsRoute(query) && !isDraftRoute(query) ? id : undefined
}

/** Rebuild the local address using only fields consumed by the workbench routers. */
export function localWorkbenchRoute(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_ROUTE_LENGTH || !/^\/(?:[?#]|$)/u.test(value)) return
  const url = new URL(value, 'http://localhost')
  const query = url.searchParams
  const parts: string[] = []
  const copy = (key: string, valid: (value: string) => boolean) => {
    const v = query.get(key)
    if (v !== null && valid(v)) parts.push(`${key}=${encodeURIComponent(v)}`)
  }
  // Each path level may itself contain an encoded slash (for instance a scoped package name).
  const copyLevels = (key: 'settings' | 'view') => {
    const raw = new RegExp(`[?&]${key}=([^&]*)`, 'u').exec(url.search)?.[1]
    if (!raw) return
    const levels = raw.split('/').map((part) => new URLSearchParams(`v=${part}`).get('v') ?? '')
    if (levels.length > 8 || !levels.every((level) => bounded(level, 512))) return
    parts.push(`${key}=${levels.map(encodeURIComponent).join('/')}`)
    return levels
  }

  copy('session', (id) => bounded(id, 512))
  const draft = !parts.length && query.get('new') === '1'
  if (draft) parts.push('new=1')
  if (draft || skillsWorkspaceId(query)) copy('workspaceId', (id) => workspaceIdPattern.test(id))
  if (pageId.test(query.get('page') ?? '')) {
    copy('page', (id) => pageId.test(id))
    copy('tab', (tab) => routeId.test(tab))
    copy('pagePackage', (id) => id.length <= 214 && packageId.test(id))
    copyLevels('view')
  }
  const settings = copyLevels('settings')
  if (settings?.[0] === 'model' && settings[1] === 'account') copy('account', (id) => bounded(id, 512))
  const hash = settings && settingsAnchor.test(url.hash) ? url.hash : ''
  const route = `/${parts.length ? `?${parts.join('&')}` : ''}${hash}`
  return route.length <= MAX_ROUTE_LENGTH ? route : undefined
}
