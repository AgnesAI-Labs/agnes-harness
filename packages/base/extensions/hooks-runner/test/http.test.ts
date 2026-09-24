import { createServer } from 'node:http'
import { type AddressInfo, isIP } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeHookHttpClient, type HookHttpClient, isPrivateAddress, runHttp } from '../src/http.js'

describe('HTTP hook address policy', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    'localhost',
    'api.localhost',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('classifies %s as private or non-routable', (host) => {
    expect(isPrivateAddress(host)).toBe(true)
  })

  it.each(['8.8.8.8', 'hooks.example.com', '2001:db8::1', '::ffff:8.8.8.8'])(
    'does not classify %s as private',
    (host) => expect(isPrivateAddress(host)).toBe(false),
  )

  it('requires a destination allowlist and rejects any private DNS answer not separately allowed', async () => {
    const requests: string[] = []
    const client: HookHttpClient = {
      resolve: async () => [
        { address: '203.0.113.7', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request: async (input) => {
        requests.push(input.address)
        return { status: 200, body: '{}' }
      },
    }
    const spec = { url: 'https://hooks.example.com/h', timeoutMs: 100, allowHosts: [] }
    await expect(runHttp(client, spec, {})).rejects.toThrow('E_NETWORK_DENIED')
    await expect(runHttp(client, { ...spec, allowHosts: ['hooks.example.com'] }, {})).rejects.toThrow(
      'E_SSRF',
    )
    expect(requests).toEqual([])
  })

  it('pins the approved resolved address and refuses redirects', async () => {
    const seen: Array<{ address: string; body: string }> = []
    const client: HookHttpClient = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (input) => {
        seen.push({ address: input.address, body: input.body })
        return input.url.endsWith('/redirect')
          ? { status: 302, body: '', location: 'http://127.0.0.1/admin' }
          : { status: 200, body: '{"hookSpecificOutput":{"additionalContext":"hi"}}' }
      },
    }
    const spec = {
      url: 'https://hooks.example.com/h',
      timeoutMs: 100,
      allowHosts: ['hooks.example.com'],
    }
    await expect(runHttp(client, spec, { a: 1 })).resolves.toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: { hookSpecificOutput: { additionalContext: 'hi' } },
    })
    expect(seen).toEqual([{ address: '8.8.8.8', body: '{"a":1}' }])
    await expect(runHttp(client, { ...spec, url: 'https://hooks.example.com/redirect' }, {})).rejects.toThrow(
      'E_SSRF_REDIRECT',
    )
  })

  describe('real pinned socket', () => {
    const servers: Array<ReturnType<typeof createServer>> = []
    afterEach(async () => {
      await Promise.all(
        servers
          .splice(0)
          .map(
            (server) =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
      )
    })

    it('does not connect when a hostname resolves to loopback unless that IP is explicit', async () => {
      let hits = 0
      const server = createServer((request, response) => {
        hits += 1
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const client = createNodeHookHttpClient({
        resolve: async (host) => {
          expect(host).toBe('hooks.test')
          return [{ address: '127.0.0.1', family: isIP('127.0.0.1') as 4 }]
        },
      })
      const spec = {
        url: `http://hooks.test:${port}/hook`,
        timeoutMs: 1_000,
        allowHosts: [`hooks.test:${port}`],
      }
      await expect(runHttp(client, spec, { real: true })).rejects.toThrow('E_SSRF')
      expect(hits).toBe(0)

      await expect(
        runHttp(client, { ...spec, allowHosts: [...spec.allowHosts, '127.0.0.1'] }, {}),
      ).resolves.toMatchObject({ exitCode: 0, output: { ok: true } })
      expect(hits).toBe(1)
    })

    it('rejects an oversized response without leaking a stream error', async () => {
      const server = createServer((request, response) => {
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('x'.repeat(65_537))
      })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const client = createNodeHookHttpClient({
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      })

      await expect(
        runHttp(
          client,
          {
            url: `http://hooks.test:${port}/hook`,
            timeoutMs: 1_000,
            allowHosts: [`hooks.test:${port}`, '127.0.0.1'],
          },
          {},
        ),
      ).rejects.toThrow('hook HTTP request failed')
    })
  })
})
