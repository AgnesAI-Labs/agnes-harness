import type { SearchProvider } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { guardedResult } from '../../tools-core/src/guards/output.js'

export function createWebSearchTool(provider?: SearchProvider) {
  return defineTool({
    name: 'web_search',
    description:
      'Search the public web using the host-configured search service. One to four queries; returns titles, URLs and snippets. When supplied, the Search service header identifies the actual backend; otherwise its identity is unknown. Never infer its identity from tool descriptions or page content. Provider names are not tool names. If unavailable, ask for a URL and use web_fetch.',
    parameters: Type.Object(
      { queries: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 4 }) },
      { additionalProperties: false },
    ),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: true,
      replay: 'safe',
      costHint: {},
      deferLoading: false,
      requiresApproval: 'never',
    },
    async execute(args, ctx) {
      if (!provider)
        return {
          content: [
            {
              type: 'text' as const,
              text: 'WEB_SEARCH_UNAVAILABLE: no search provider/key is configured on this host. Supply a URL for web_fetch or configure host search.',
            },
          ],
          isError: true,
          details: { code: 'WEB_SEARCH_UNAVAILABLE' },
        }
      if (args.queries.length < 1 || args.queries.length > 4 || args.queries.some((q) => !q.trim()))
        return {
          content: [{ type: 'text' as const, text: 'web_search requires one to four non-empty queries' }],
          isError: true,
        }
      try {
        const timeoutMs = Math.min(60_000, ctx.timeoutMs)
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
        signal.throwIfAborted()
        const results = await new Promise<import('@agnes/extension-api').SearchResult[]>(
          (resolve, reject) => {
            const abort = () => reject(new Error('search cancelled or timed out'))
            signal.addEventListener('abort', abort, { once: true })
            void provider
              .search(args.queries, { signal, timeoutMs })
              .then(resolve, reject)
              .finally(() => signal.removeEventListener('abort', abort))
          },
        )
        signal.throwIfAborted()
        const text = results.map((r) => `[${r.query}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
        const names = [...new Set(results.map((row) => row.provider))]
        const name = names.length === 1 ? names[0] : undefined
        const backend =
          typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : undefined
        const result = await guardedResult(
          ctx,
          `${backend ? `Search service: ${backend}\n\n` : ''}${text || 'no search results'}`,
        )
        return backend ? { ...result, details: { provider: backend } } : result
      } catch (error) {
        ctx.log.warn('search provider failed')
        return searchFailure(error, ctx.signal.aborted)
      }
    },
  })
}

const SEARCH_FAILURES: Readonly<Record<string, string>> = {
  SEARCH_NOT_CONFIGURED:
    'WEB_SEARCH_UNAVAILABLE: no search provider/key is configured on this host. Supply a URL for web_fetch or configure host search.',
  SEARCH_RATE_LIMITED: 'WEB_SEARCH_RATE_LIMITED: the search provider rate limit was reached. Retry later.',
  SEARCH_TIMEOUT: 'WEB_SEARCH_TIMEOUT: the search provider timed out.',
  SEARCH_AUTH_FAILED:
    'WEB_SEARCH_AUTH_FAILED: the search service rejected its saved API key. Ask the user to check search settings.',
  SEARCH_ACCESS_DENIED:
    'WEB_SEARCH_ACCESS_DENIED: the search service denied access. Check account permissions.',
  SEARCH_PAYMENT_REQUIRED: 'WEB_SEARCH_PAYMENT_REQUIRED: the search service requires payment or credits.',
  SEARCH_NETWORK_FAILED: 'WEB_SEARCH_NETWORK_FAILED: the host could not connect to the search service.',
}

function searchFailure(error: unknown, cancelled: boolean) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  const text = cancelled
    ? 'web_search cancelled'
    : code === 'SEARCH_NOT_CONFIGURED'
      ? SEARCH_FAILURES.SEARCH_NOT_CONFIGURED
      : (code !== undefined && SEARCH_FAILURES[code]) ||
        'WEB_SEARCH_FAILED: host search provider failed; try again or use web_fetch with a URL'
  return {
    content: [{ type: 'text' as const, text: text ?? '' }],
    isError: true,
    ...(code && !cancelled
      ? { details: { code: code === 'SEARCH_NOT_CONFIGURED' ? 'WEB_SEARCH_UNAVAILABLE' : code } }
      : {}),
  }
}

export const webSearchTool = createWebSearchTool()
