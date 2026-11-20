import { basename, dirname } from 'node:path'
import { DEFAULT_REFINEMENT_BASE_URL } from '@agnes/distribution/refinement-model'
import { createCredentialStore } from '@agnes/host-infrastructure/adapters/credential-store'
import { expect, vi } from 'vitest'

export const syntheticKey = 'synthetic-review-service-key'
export const reviewModel = 'company/review-a'
export async function reviewCredential(
  dataDir: string,
  home = basename(dataDir) === 'data' ? dirname(dataDir) : dataDir,
): Promise<string> {
  const ref = 'secret://generic/00000000-0000-4000-8000-000000000001'
  await createCredentialStore({ root: home }).putGeneric(ref, syntheticKey, {
    label: 'Review fixture',
    createdAt: new Date(0).toISOString(),
  })
  return ref
}

type ReviewGateway = { baseUrl: string; loopback: string; key: string }

/** Exercise the real review requests, mapping approved addresses to isolated loopback servers. */
export function routeReviewToLoopback(loopback: string, alternate?: ReviewGateway) {
  const gateways = [
    { baseUrl: DEFAULT_REFINEMENT_BASE_URL, loopback, key: syntheticKey },
    ...(alternate ? [alternate] : []),
  ]
  const localFetch = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).hostname === '127.0.0.1') return localFetch(input, init)
    const request = new Request(input, init)
    const gateway = gateways.find(({ baseUrl }) => request.url.startsWith(`${baseUrl}/`))
    if (!gateway) throw new Error('Unexpected review gateway')
    if (request.url === `${gateway.baseUrl}/models` && request.method === 'GET') {
      expect(request.redirect).toBe('error')
      return localFetch(`${gateway.loopback}/models`, {
        headers: request.headers,
        signal: request.signal,
      })
    }
    if (
      request.url !== `${gateway.baseUrl}/chat/completions` ||
      request.method !== 'POST' ||
      request.headers.get('authorization') !== `Bearer ${gateway.key}`
    )
      throw new Error('Unexpected review request')
    const body = await request.text()
    const parsed = JSON.parse(body)
    if (!parsed.stream || !parsed.stream_options?.include_usage) throw new Error('Expected streamed usage')
    return localFetch(`${gateway.loopback}/chat/completions`, {
      method: 'POST',
      headers: request.headers,
      body,
      signal: request.signal,
    })
  })
}
