import type { ModelAdapterConfig, ProviderPluginContext } from '@agnes/extension-api'
import { modelAdapterKind } from '@agnes/extension-api'
import { JEV_ADAPTER_VERSION, JEV_WIRE_API, JevAdapter } from './adapters/jev/index.js'
import {
  OPENAI_AUDIO_ADAPTER_VERSION,
  OPENAI_AUDIO_WIRE_API,
  OpenAiAudioAdapter,
} from './adapters/openai-audio/index.js'
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

/**
 * TypeSafe System One answers a payload and nothing else: no messages, no tools, no streaming. It
 * declares `payloadOnly` so a model picker for conversations leaves its models out.
 */
const jevRegistration = {
  id: JEV_WIRE_API,
  wireApi: JEV_WIRE_API,
  version: JEV_ADAPTER_VERSION,
  capabilities: { imageInput: false, tools: false, streaming: false, payload: true, payloadOnly: true },
  create: (config: ModelAdapterConfig, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return new JevAdapter({ routes: config.routes })
  },
}

/** Speech to text and text to speech take a payload and answer with text: no messages, no tools. */
const openAiAudioRegistration = {
  id: OPENAI_AUDIO_WIRE_API,
  wireApi: OPENAI_AUDIO_WIRE_API,
  version: OPENAI_AUDIO_ADAPTER_VERSION,
  capabilities: { imageInput: false, tools: false, streaming: false, payload: true, payloadOnly: true },
  create: (config: ModelAdapterConfig, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return new OpenAiAudioAdapter({ routes: config.routes })
  },
}

/** Builtin adapters contribute through the same factory port as community packages. */
export const modelAdaptersPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    for (const adapter of registrations) ctx.providers.register(modelAdapterKind, adapter)
    ctx.providers.register(modelAdapterKind, jevRegistration)
    ctx.providers.register(modelAdapterKind, openAiAudioRegistration)
  },
}
