import { type ManualRoute, PiAdapter } from './adapters/pi/index.js'
import { PI_ADAPTER_APIS } from './adapters/pi/wire.js'

const registrations = [...PI_ADAPTER_APIS, 'openai'].map((api) => ({
  id: api,
  api,
  version: '0.0.0',
  capabilities: { imageInput: true, tools: true, streaming: true },
  create: (config: { routes: readonly ManualRoute[] }) => new PiAdapter({ manualRoutes: [...config.routes] }),
}))

/** Builtin pi-ai protocols contribute through the same factory port as community packages. */
export const modelAdaptersPlugin = {
  inject: ['modelAdapters'],
  apply(ctx: { modelAdapters: { register(adapter: (typeof registrations)[number]): unknown } }) {
    for (const adapter of registrations) ctx.modelAdapters.register(adapter)
  },
}
