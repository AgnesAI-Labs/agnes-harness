import { realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadContextRules, readContextConfig, writeContextConfig } from '@agnes/base'

/** Local administration of live resources; workspace authority comes from the daemon catalog. */
export function contextAdmin(
  origin: string,
  workspaces: () => Promise<{ path: string; available: boolean }[]>,
  home: string,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname !== '/api/context') return false
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(JSON.stringify(data))
    }
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.host !== new URL(origin).host ||
      request.headers.origin !== origin ||
      (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
    ) {
      request.resume()
      reply(403, { error: 'forbidden' })
      return true
    }
    try {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new Error('invalid content type')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > 65536) throw new Error('request too large')
        chunks.push(bytes)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { cwd?: string; config?: unknown }
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'cwd' && key !== 'config')
      )
        throw new Error('invalid input')
      const items = await workspaces()
      let cwd: string | undefined
      if (input.cwd !== undefined) {
        if (typeof input.cwd !== 'string' || !items.some((item) => item.available && item.path === input.cwd))
          throw new Error('workspace unavailable')
        cwd = await realpath(input.cwd)
      }
      const config =
        input.config === undefined ? readContextConfig(home) : writeContextConfig(input.config, home)
      const rules = cwd ? await loadContextRules(cwd, [], config, home) : undefined
      reply(200, { config, workspaces: items, ...(rules ? { rules } : {}) })
    } catch {
      reply(400, { error: 'context request refused' })
    }
    return true
  }
}
