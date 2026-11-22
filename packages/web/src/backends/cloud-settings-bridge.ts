import { remoteFrontendOrigin } from '@agnes/protocol'
import { CREDENTIALS_CHANGED } from '@agnes/resource-control-web/credentials-api'
import { bumpCloudCredentialGeneration } from './cloud-key.js'
import { backendFrame } from './frame-context.js'
import { BACKEND_FRAME_MESSAGE } from './frame-contract.js'
import { dispatchWorkbenchCloudAction, localCloudSettings } from './local-workbench-bus.js'

export const CLOUD_SETTINGS_SECTION = 'cloud-connection'
export type CloudConnectionAction =
  | { action: 'connect'; origin?: string; credentialRef: string }
  | { action: 'disconnect' }
  | { action: 'reconnect' }
  | { action: 'refresh-credentials' }
  | { action: 'manage-credentials' }
  | { action: 'credential-replaced'; credentialRef: string; generation?: string }

export const credentialReference = (value: unknown): value is string =>
  typeof value === 'string' && /^secret:\/\/generic\/[a-f0-9-]{36}$/u.test(value)

export function cloudConnectionAction(value: unknown): CloudConnectionAction | undefined {
  if (!value || typeof value !== 'object') return
  const message = value as Record<string, unknown>
  if (message.type !== BACKEND_FRAME_MESSAGE || message.kind !== 'cloud-action') return
  if (message.action === 'credential-replaced') {
    if ('key' in message || !credentialReference(message.credentialRef)) return
    const generation =
      typeof message.generation === 'string' &&
      message.generation.length > 0 &&
      message.generation.length <= 128
        ? message.generation
        : undefined
    if (message.generation !== undefined && !generation) return
    return {
      action: message.action,
      credentialRef: message.credentialRef,
      ...(generation ? { generation } : {}),
    }
  }
  if (
    message.action === 'disconnect' ||
    message.action === 'reconnect' ||
    message.action === 'refresh-credentials' ||
    message.action === 'manage-credentials'
  )
    return { action: message.action }
  if (message.action === 'connect') {
    if ('key' in message || !credentialReference(message.credentialRef)) return
    try {
      return {
        action: 'connect',
        ...(message.origin === undefined ? {} : { origin: remoteFrontendOrigin(message.origin as string) }),
        credentialRef: message.credentialRef,
      }
    } catch {}
  }
}

export const cloudSettingsState = {
  read: () => localCloudSettings.read(),
  subscribe: (listener: () => void) => localCloudSettings.subscribe(listener),
}

export function installCloudSettingsProjection(): () => void {
  if (backendFrame()) return () => {}
  const replaced = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: unknown; id?: unknown }>).detail
    if (detail?.mode !== 'replace' || !credentialReference(detail.id)) return
    const generation = bumpCloudCredentialGeneration(detail.id)
    if (detail.id !== localCloudSettings.read().credentialRef) return
    requestCloudConnection({ action: 'credential-replaced', credentialRef: detail.id, generation })
  }
  window.addEventListener(CREDENTIALS_CHANGED, replaced)
  return () => {
    window.removeEventListener(CREDENTIALS_CHANGED, replaced)
    localCloudSettings.reset()
  }
}

export function requestCloudConnection(action: CloudConnectionAction): void {
  if (!backendFrame()) dispatchWorkbenchCloudAction(action)
}
