import { type PackageAdminContext, validateMethod, validatePackageAdminData } from '@agnes/protocol'
import type { AdminCredentialDelete, AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'

export type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
export type CredentialFailure =
  | 'readOnly'
  | 'denied'
  | 'unavailable'
  | 'referenced'
  | 'confirmation'
  | 'missing'
  | 'invalid'
export class CredentialError extends Error {
  constructor(readonly reason: CredentialFailure) {
    super(reason)
  }
}
/** Never render arbitrary response messages or retain error payloads at this write-only boundary. */
function failure(body: unknown, status: number): CredentialFailure {
  const error = (
    body as { error?: { code?: unknown; data?: { code?: unknown; cause?: { code?: unknown } } } } | null
  )?.error
  const codes = [error?.code, error?.data?.code, error?.data?.cause?.code]
  if (codes.some((code) => ['E_ADMIN_READ_ONLY', 'CONFIG_CREDENTIAL_READ_ONLY'].includes(String(code))))
    return 'readOnly'
  if (status === 403 || codes.includes('CAPABILITY_DENIED')) return 'denied'
  if (codes.includes('CONFIG_CREDENTIAL_REFERENCED')) return 'referenced'
  if (codes.includes('CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED')) return 'confirmation'
  if (codes.includes('CONFIG_CREDENTIAL_NOT_FOUND')) return 'missing'
  if (status === 400 || codes.includes('INVALID_PARAMS')) return 'invalid'
  return 'unavailable'
}
export const credentialFailure = (cause: unknown): CredentialFailure =>
  cause instanceof CredentialError ? cause.reason : 'unavailable'
export class CredentialsApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async context(signal?: AbortSignal): Promise<PackageAdminContext> {
    const fetcher = this.fetcher
    const response = await fetcher('/admin/plugins/api/context', {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
    const body: unknown = await response.json()
    if (!response.ok) throw new CredentialError(failure(body, response.status))
    if (!validatePackageAdminData('PackageAdminContext', body).ok) throw new CredentialError('unavailable')
    return body as PackageAdminContext
  }
  async list(signal?: AbortSignal): Promise<AdminCredentialMetadata[]> {
    const result = (await this.request('list', {}, signal)) as { items: AdminCredentialMetadata[] }
    return result.items
  }
  async create(label: string, value: string): Promise<AdminCredentialMetadata> {
    return this.request('create', { label, value }) as Promise<AdminCredentialMetadata>
  }
  async set(id: string, value: string): Promise<AdminCredentialMetadata> {
    return this.request('set', { id, value }) as Promise<AdminCredentialMetadata>
  }
  async rename(id: string, label: string): Promise<AdminCredentialMetadata> {
    return this.request('rename', { id, label }) as Promise<AdminCredentialMetadata>
  }
  async delete(input: AdminCredentialDelete): Promise<void> {
    await this.request('delete', input)
  }
  private async request(
    action: 'list' | 'create' | 'set' | 'rename' | 'delete',
    input: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const method = `_agnes/v1/admin.credentials.${action}` as const
    if (!validateMethod(method, 'params', input).ok) throw new CredentialError('invalid')
    const fetcher = this.fetcher
    const response = await fetcher(`/admin/api/credentials${action === 'list' ? '' : `/${action}`}`, {
      method: action === 'list' ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(action === 'list'
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
    })
    const body: unknown = await response.json()
    if (!response.ok) throw new CredentialError(failure(body, response.status))
    // Strict result schemas reject accidental value echoes, including unknown properties.
    if (!validateMethod(method, 'result', body).ok) throw new CredentialError('unavailable')
    return body
  }
}
export function credentialWriteFailure(
  context: PackageAdminContext | undefined,
): CredentialFailure | undefined {
  if (!context) return 'unavailable'
  if (context.readOnly) return 'readOnly'
  if (
    !context.permissions.includes('credentials.write') ||
    !context.permissions.includes('packages.activate')
  )
    return 'denied'
  return undefined
}
export const CREDENTIALS_CHANGED = 'agnes:credentials-changed'
