import type { ModelAdapterConfig, ProviderPluginContext } from '@agnes/extension-api'
import { modelAdapterKind } from '@agnes/extension-api'
import { PiAdapter } from './adapters/pi/index.js'
import { PI_ADAPTER_APIS } from './adapters/pi/wire.js'

const registrations = [...PI_ADAPTER_APIS, 'openai'].map((api) => ({
  id: api,
  wireApi: api,
  version: '0.0.0',
  capabilities: { imageInput: true, tools: true, streaming: true },
  create: (config: ModelAdapterConfig, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const retryDirectory = (config as { retryDirectory?: unknown }).retryDirectory
    return new PiAdapter({
      manualRoutes: [...config.routes],
      ...(config.id ? { id: config.id } : {}),
      ...(config.providerId ? { providerId: config.providerId } : {}),
      ...(config.credentials ? { resolveCredential: config.credentials.resolve } : {}),
      ...(config.credentials?.recoverRejected
        ? { recoverRejectedAuth: config.credentials.recoverRejected }
        : {}),
      ...(typeof retryDirectory === 'string' ? { retryDirectory } : {}),
    })
  },
}))

/** Builtin pi-ai protocols contribute through the same factory port as community packages. */
export const modelAdaptersPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    for (const adapter of registrations) ctx.providers.register(modelAdapterKind, adapter)
  },
}
