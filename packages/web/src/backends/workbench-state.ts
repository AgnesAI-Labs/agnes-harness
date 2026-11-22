import { remoteFrontendOrigin } from '@agnes/protocol'
import type { BackendId, BackendSnapshot } from './frame-contract.js'

export const CLOUD_ORIGIN_KEY = 'agnes.cloud.origin.v1'
export const CLOUD_DISCOVERY_KEY = 'agnes.cloud.auto-credential.v1'

export function isSharedCloudOrigin(origin: string | undefined, saved: string | null): boolean {
  if (!origin || !saved) return false
  try {
    return remoteFrontendOrigin(saved) === origin
  } catch {
    return saved === origin
  }
}

export function sessionFrameSearch(session: string | undefined): string | undefined {
  return session === undefined ? undefined : session ? `?session=${encodeURIComponent(session)}` : '?new=1'
}

export function errorCloudSnapshot(error: string, rows: BackendSnapshot['rows'] = []): BackendSnapshot {
  return { ready: false, connected: false, rows, activity: [], more: false, error }
}
export type CloudConnectionStatus = 'unconfigured' | 'connecting' | 'ready' | 'disconnected' | 'error'
export type CloudConnectionState = {
  status: CloudConnectionStatus
  origin?: string
  error?: string
  credentialRef?: string
  credentialOptions?: { id: string; label: string }[]
  credentialError?: boolean
}

export function cloudConnectionState(origin?: string, snapshot?: BackendSnapshot): CloudConnectionState {
  if (!origin) return { status: 'unconfigured' }
  if (!snapshot) return { origin, status: 'connecting' }
  if (snapshot.ready && snapshot.connected) return { origin, status: 'ready' }
  if (snapshot.error) return { origin, status: 'error', error: snapshot.error }
  return { origin, status: snapshot.ready ? 'disconnected' : 'connecting' }
}

export function initialWorkbench(search: string, saved?: string | null) {
  const params = new URLSearchParams(search)
  const requested = params.get('remote')
  let remote: string | undefined
  try {
    if (requested || saved) remote = remoteFrontendOrigin(requested || saved || '')
  } catch {}
  const active: BackendId = requested && remote ? 'cloud' : 'local'
  const session = params.get('session') || undefined
  return {
    remote,
    active,
    session: active === 'cloud' && params.get('new') === '1' ? '' : session,
    configure: params.has('connection'),
  }
}

export function backendFrameSource(remote?: string, sessionId?: string): string {
  const params = new URLSearchParams()
  if (remote) params.set('remote', remoteFrontendOrigin(remote))
  if (sessionId) params.set('session', sessionId)
  else if (remote && sessionId === '') params.set('new', '1')
  return `/${params.size ? `?${params}` : ''}`
}

/** The address identifies a backend/session pair; a raw session id never selects another backend. */
export function workbenchAddress(backend: BackendId, remote: string | undefined, sessionId?: string): string {
  return backendFrameSource(backend === 'cloud' ? remote : undefined, sessionId)
}

export function cloudFrameSource(
  remote: string,
  selected: boolean,
  search: string,
  frameOrigin: string,
): string {
  const url = new URL(backendFrameSource(remote), frameOrigin)
  if (selected) {
    const rest = search
      .slice(1)
      .split('&')
      .filter((part) => {
        const params = new URLSearchParams(part)
        return part && !params.has('remote') && !params.has('connection')
      })
    url.search = [url.search.slice(1), ...rest].filter(Boolean).join('&')
  }
  return url.href
}
