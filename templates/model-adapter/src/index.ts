import {
  type Context,
  defineAgnesPlugin,
  defineModelAdapter,
  type ModelAdapterConfig,
  type ModelAdapterInstance,
  modelAdapterKind,
  type ProviderPluginContext,
} from '@agnes/plugin-runtime'

// Route.api selects this registration. Use your own wire-protocol identifier.
export const adapter = defineModelAdapter({
  id: '__PACKAGE_NAME__',
  version: '0.1.0',
  wireApi: '__SKILL_NAME__-wire',
  capabilities: { imageInput: false, tools: false, streaming: true },
  create(config: ModelAdapterConfig): ModelAdapterInstance {
    const lifetime = new AbortController()
    return {
      id: '__PACKAGE_NAME__',
      routes: () => [...config.routes],
      models: (route) => config.routes.find((candidate) => candidate.route === route)?.models ?? [],
      async *stream(_route, _request, options) {
        const signal = AbortSignal.any([options.signal, lifetime.signal])
        signal.throwIfAborted()
        // Replace this deterministic reply with your wire protocol; pass signal to all I/O.
        yield { type: 'text_delta', delta: 'Hello from __PACKAGE_NAME__' }
        yield { type: 'done', reason: 'stop' }
      },
      dispose() {
        lifetime.abort()
      },
    }
  },
})

export const main = defineAgnesPlugin({
  apply(ctx: Context & ProviderPluginContext) {
    ctx.providers.register(modelAdapterKind, adapter)
  },
})
