import type { ProviderConfig } from './types.js'

/** Tool-aware first-run teaching route, supplied only by local boot readers. */
export function demoProvider(): ProviderConfig {
  return {
    package: '@agnes/ai',
    adapters: ['@agnes/ai', 'scripted'],
    routes: [
      {
        route: 'demo',
        api: 'scripted',
        baseUrl: 'https://demo.invalid',
        keyless: true,
        compat: {
          demo: true,
        },
        models: [
          {
            id: 'demo-model',
            name: 'Demo (local tool-aware, no API key)',
            route: 'demo',
            api: 'scripted',
            baseUrl: 'https://demo.invalid',
            reasoning: false,
            input: ['text'],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: 128000,
            maxTokens: 8192,
            toolCallFormats: ['native'],
            thinkingReplay: 'native',
            contract_id: null,
          },
        ],
      },
    ],
  }
}
