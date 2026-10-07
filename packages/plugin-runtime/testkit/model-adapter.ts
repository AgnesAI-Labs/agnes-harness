import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterEvent,
  ModelAdapterInstance,
  ModelAdapterStreamOptions,
} from '@agnes/extension-api'

export interface ModelAdapterTestOptions {
  config: ModelAdapterConfig
  route: string
  request: Parameters<ModelAdapterInstance['stream']>[1]
  signal?: AbortSignal
  /** Defaults to streaming; complete mode requires the optional complete entry point. */
  mode?: 'stream' | 'complete'
  toolNames?: string[]
  timeoutMs?: ModelAdapterStreamOptions['timeoutMs']
}

/** Run one instance, capture wire events, and dispose it even when streaming fails. */
export async function runModelAdapter(adapter: ModelAdapter, options: ModelAdapterTestOptions) {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const instance = await adapter.create(options.config)
  try {
    const streamOptions: ModelAdapterStreamOptions = {
      signal,
      sessionKey: options.request.sessionKey,
      toolNames: options.toolNames ?? [],
      retry: false,
      timeoutMs: options.timeoutMs ?? { firstToken: 1000, total: 10000 },
    }
    const events: ModelAdapterEvent[] = []
    signal.throwIfAborted()
    if (options.mode === 'complete') {
      if (!instance.complete) throw new Error('Adapter does not implement complete()')
      events.push(...(await instance.complete(options.route, options.request, streamOptions)))
    } else {
      for await (const event of instance.stream(options.route, options.request, streamOptions)) {
        signal.throwIfAborted()
        events.push(structuredClone(event))
      }
    }
    signal.throwIfAborted()
    return {
      events,
      routes: structuredClone(instance.routes()),
      models: structuredClone(instance.models(options.route)),
    }
  } finally {
    await instance.dispose?.()
  }
}
