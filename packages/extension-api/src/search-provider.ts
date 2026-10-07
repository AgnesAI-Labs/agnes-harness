/** Deployment-owned web search; tools never choose a vendor or receive its credentials. */
export interface SearchProvider {
  search(
    queries: readonly string[],
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<SearchResult[]>
}

export interface SearchResult {
  query: string
  title: string
  url: string
  snippet: string
}
