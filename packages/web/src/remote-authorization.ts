import { CLOUD_AUTHORIZATION_PATH, remoteFrontendSessionPath } from '@agnes/protocol'
import { readCloudCredentialRef } from './backends/cloud-key.js'

const sessions = new Map<string, { token: string; expiresAt: number }>()
export const remoteAccessPath = (remote: string): string => {
  const value = sessions.get(remote)
  return value ? remoteFrontendSessionPath(value.token) : ''
}
export function forgetRemoteAccess(remote: string): void {
  sessions.delete(remote)
}

export async function authorizeRemoteFrontend(remote: string, signal: AbortSignal, fetcher: typeof fetch) {
  const existing = sessions.get(remote)
  if (existing && existing.expiresAt > Date.now() + 30_000) return remoteFrontendSessionPath(existing.token)
  const credentialRef = readCloudCredentialRef(remote)
  if (!credentialRef)
    throw new Error(
      'Cloud Key is required. Open Settings → Advanced → Cloud connection. / 请在“设置 → 高级 → 云端连接”填写授权 Key。',
    )
  const response = await fetcher(new URL(CLOUD_AUTHORIZATION_PATH, location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: remote, credentialRef }),
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: unknown }
    if (failure.error === 'CONFIG_CREDENTIAL_REJECTED')
      throw new Error('Cloud Key is invalid / 云端授权 Key 不正确')
    if (failure.error === 'CONFIG_CREDENTIAL_NOT_FOUND')
      throw new Error(
        'Cloud credential was removed. Configure the Key again. / 云端凭证已删除，请重新配置 Key。',
      )
    throw new Error('Cloud Key verification is unavailable / 云端 Key 验证服务不可用')
  }
  const value = (await response.json()) as { token?: unknown; expiresAt?: unknown }
  if (
    typeof value.token !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw new Error('Invalid cloud authentication response / 云端认证响应无效')
  const path = remoteFrontendSessionPath(value.token)
  sessions.set(remote, { token: value.token, expiresAt: value.expiresAt })
  return path
}
