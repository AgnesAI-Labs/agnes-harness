import type { ModelAdapter, ModelAdapterRegistration } from '@agnes/extension-api'

export const observations = {
  requests: [] as Array<{ model: string; image: boolean; credential?: string }>,
  disposed: false,
  cleaned: false,
}

const adapter: ModelAdapter = {
  id: 'community-fake',
  api: 'fake-wire-v1',
  version: '1.2.3',
  capabilities: { imageInput: true, tools: true, streaming: true },
  create(config) {
    let credential: string | undefined
    return {
      id: 'community-fake-wire',
      routes: () => [...config.routes],
      models: (route) => config.routes.find((candidate) => candidate.route === route)?.models ?? [],
      bindCredential(_route, value) {
        credential = value
      },
      async *stream(_route, request, options) {
        options.signal.throwIfAborted()
        observations.requests.push({
          model: request.model,
          image: request.messages.some((message) => message.content.some((part) => part.type === 'image')),
          ...(credential ? { credential } : {}),
        })
        yield { type: 'text_delta', delta: 'community adapter called' }
        yield { type: 'done', reason: 'stop' }
      },
      dispose() {
        observations.disposed = true
      },
    }
  },
  cleanup() {
    observations.cleaned = true
  },
}

export const plugin = {
  inject: ['modelAdapters'],
  apply(ctx: { modelAdapters: ModelAdapterRegistration }) {
    ctx.modelAdapters.register(adapter)
  },
}
