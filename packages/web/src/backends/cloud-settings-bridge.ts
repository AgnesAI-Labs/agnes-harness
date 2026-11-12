import { remoteFrontendOrigin } from '@agnes/protocol'
import { backendFrame } from './frame-context.js'
import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'
import type { CloudConnectionState } from './workbench-state.js'

export const CLOUD_SETTINGS_SECTION = 'cloud-connection'
export type CloudConnectionAction =
  | { action: 'connect'; origin: string }
  | { action: 'disconnect' }
  | { action: 'reconnect' }

export function cloudConnectionAction(value: unknown): CloudConnectionAction | undefined {
  if (!value || typeof value !== 'object') return
  const message = value as Record<string, unknown>
  if (message.type !== BACKEND_FRAME_MESSAGE || message.kind !== 'cloud-action') return
  if (message.action === 'disconnect' || message.action === 'reconnect') return { action: message.action }
  if (message.action === 'connect' && typeof message.origin === 'string') {
    try {
      return { action: 'connect', origin: remoteFrontendOrigin(message.origin) }
    } catch {}
  }
}

let state: CloudConnectionState = { status: 'unconfigured' }
const listeners = new Set<() => void>()
export const cloudSettingsState = {
  read: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function installCloudSettingsProjection(): () => void {
  if (!backendFrame()) return () => {}
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const value = event.data
    if (value?.type !== BACKEND_FRAME_MESSAGE || value.kind !== 'cloud-state') return
    const next = value.state
    if (
      !next ||
      !['unconfigured', 'connecting', 'ready', 'disconnected', 'error'].includes(next.status) ||
      (next.error !== undefined && (typeof next.error !== 'string' || next.error.length > 4096))
    )
      return
    try {
      const origin = next.origin === undefined ? undefined : remoteFrontendOrigin(next.origin)
      if (next.status !== 'unconfigured' && !origin) return
      state = {
        status: next.status,
        ...(origin ? { origin } : {}),
        ...(next.error ? { error: next.error } : {}),
      }
      for (const listener of listeners) listener()
    } catch {}
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}

export function requestCloudConnection(action: CloudConnectionAction): void {
  if (backendFrame())
    window.parent.postMessage(
      { type: BACKEND_FRAME_MESSAGE, kind: 'cloud-action', ...action },
      location.origin,
    )
}
