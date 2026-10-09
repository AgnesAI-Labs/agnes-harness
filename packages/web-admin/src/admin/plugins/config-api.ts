import {
  type PackageAdminMethodName,
  type PluginConfigSaveResult,
  type PluginConfigSnapshot,
  type PluginConfigValidation,
  validatePackageAdminCall,
} from '@agnes/protocol'
import type { AdminContext } from './types.js'

export class PluginConfigApi {
  constructor(
    private readonly context: Pick<AdminContext, 'profile' | 'clientId'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request<T>(
    action: 'get' | 'validate' | 'save',
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const method = `_agnes/v1/plugins.config.${action}` as PackageAdminMethodName
    const response = await this.fetcher(`/admin/plugins/api/config/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, profile: this.context.profile }),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new Error('Plugin configuration unavailable')
    const body: unknown = await response.json()
    if (!validatePackageAdminCall(method, 'result', body).ok)
      throw new Error('Invalid plugin configuration response')
    return body as T
  }
  get(id: string, signal?: AbortSignal): Promise<PluginConfigSnapshot> {
    return this.request('get', { id }, signal)
  }
  validate(id: string, rowId: string, value: unknown, signal?: AbortSignal): Promise<PluginConfigValidation> {
    return this.request('validate', { id, rowId, value }, signal)
  }
  save(id: string, rowId: string, value: unknown, expectedRevision: string): Promise<PluginConfigSaveResult> {
    return this.request('save', {
      id,
      rowId,
      value,
      expectedRevision,
      clientId: this.context.clientId,
      commandId: `config-${crypto.randomUUID()}`,
    })
  }
}
