import { remoteFrontendOrigin } from '@agnes/protocol'
import type { BackendId, BackendSnapshot } from './frame-contract.js'

export const CLOUD_ORIGIN_KEY = 'agnes.cloud.origin.v1'
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
  return {
    remote,
    active: requested && remote ? ('cloud' as const) : ('local' as const),
    session: params.get('session') ?? undefined,
    configure: params.has('connection'),
  }
}

export function backendFrameSource(remote?: string, sessionId?: string): string {
  const params = new URLSearchParams()
  if (remote) params.set('remote', remoteFrontendOrigin(remote))
  if (sessionId) params.set('session', sessionId)
  return `/${params.size ? `?${params}` : ''}`
}

/** The address identifies a backend/session pair; a raw session id never selects another backend. */
export function workbenchAddress(backend: BackendId, remote: string | undefined, sessionId?: string): string {
  return backendFrameSource(backend === 'cloud' ? remote : undefined, sessionId)
}
