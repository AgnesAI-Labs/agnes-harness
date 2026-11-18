import { closeSync, existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { REFINEMENT_SERVICE } from '@agnes/distribution'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { expect, vi } from 'vitest'

export const syntheticKey = 'synthetic-review-service-key'
export const reviewModel = 'company/review-a'
export function reviewCredential(
  dataDir: string,
  home = basename(dataDir) === 'data' ? dirname(dataDir) : dataDir,
) {
  const name = '00000000-0000-4000-8000-000000000001'
  const root = join(home, 'secrets')
  for (const dir of [home, root, join(root, 'generic')]) if (!existsSync(dir)) createPrivateDirectorySync(dir)
  const file = join(root, 'generic', name)
  if (!existsSync(file)) {
    const fd = createPrivateFileSync(file)
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          kind: 'api-key',
          provider: 'generic',
          label: 'Review fixture',
          createdAt: new Date(0).toISOString(),
          value: syntheticKey,
        }),
      )
    } finally {
      closeSync(fd)
    }
  }
  return `secret://generic/${name}`
}

/** Exercise the real review requests, redirecting the fixed gateway to an isolated loopback server. */
export function routeReviewToLoopback(loopback: string) {
  const localFetch = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).hostname === '127.0.0.1') return localFetch(input, init)
    const request = new Request(input, init)
    if (request.url === `${REFINEMENT_SERVICE.baseUrl}/models` && request.method === 'GET') {
      expect(request.redirect).toBe('error')
      return localFetch(`${loopback}/models`, {
        headers: request.headers,
        signal: request.signal,
      })
    }
    if (
      request.url !== `${REFINEMENT_SERVICE.baseUrl}/chat/completions` ||
      request.method !== 'POST' ||
      request.headers.get('authorization') !== `Bearer ${syntheticKey}`
    )
      throw new Error('Unexpected review request')
    const body = await request.text()
    const parsed = JSON.parse(body)
    if (!parsed.stream || !parsed.stream_options?.include_usage) throw new Error('Expected streamed usage')
    return localFetch(`${loopback}/chat/completions`, {
      method: 'POST',
      headers: request.headers,
      body,
      signal: request.signal,
    })
  })
}
