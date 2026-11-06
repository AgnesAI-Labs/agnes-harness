import { describe, expect, it, vi } from 'vitest'
import { authorizeMcpServer } from '../src/mcp-oauth-authorize.js'

const AUTHORIZE_URL = 'https://auth.example.com/authorize?state=s'

function setup(options: { origin: string; redirectUri: string; confirm?: boolean; response?: Response }) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      options.response ??
      new Response(JSON.stringify({ authorizeUrl: AUTHORIZE_URL, redirectUri: options.redirectUri }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const confirm = vi.fn(async (_text: string) => options.confirm ?? true)
  const navigate = vi.fn((_url: string) => undefined)
  const deps = {
    fetch: fetchMock as unknown as typeof fetch,
    location: { origin: options.origin },
    t: (key: string, vars?: Record<string, string | number>) => `${key}|${JSON.stringify(vars ?? {})}`,
    confirm,
    navigate,
  }
  return { deps, fetchMock, confirm, navigate }
}

describe('authorizeMcpServer', () => {
  it('asks the start endpoint for JSON', async () => {
    const { deps, fetchMock } = setup({
      origin: 'http://127.0.0.1:4177',
      redirectUri: 'http://127.0.0.1:4177/oauth/tracker/callback',
    })
    await authorizeMcpServer('tracker', deps)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/oauth/tracker/start')
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
  })

  it('same origin navigates without asking', async () => {
    const { deps, confirm, navigate } = setup({
      origin: 'http://127.0.0.1:4177',
      redirectUri: 'http://127.0.0.1:4177/oauth/tracker/callback',
    })
    await authorizeMcpServer('tracker', deps)
    expect(confirm).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL)
  })

  it.each([
    ['http://localhost:4177', 'http://127.0.0.1:4177/oauth/tracker/callback'],
    ['http://127.0.0.1:4177', 'http://localhost:4177/oauth/tracker/callback'],
    ['http://localhost:4177', 'http://[::1]:4177/oauth/tracker/callback'],
  ])(
    'localhost vs 127.0.0.1 on the same port navigates without asking (%s, %s)',
    async (origin, redirectUri) => {
      const { deps, confirm, navigate } = setup({ origin, redirectUri })
      await authorizeMcpServer('tracker', deps)
      expect(confirm).not.toHaveBeenCalled()
      expect(navigate).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL)
    },
  )

  it('different origin asks first and only navigates after confirm', async () => {
    const { deps, confirm, navigate } = setup({
      origin: 'https://agh.example.com',
      redirectUri: 'http://127.0.0.1:4177/oauth/tracker/callback',
    })
    let answer: (value: boolean) => void = () => undefined
    confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)))

    const running = authorizeMcpServer('tracker', deps)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(navigate).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0]?.[0]).toContain('http://127.0.0.1:4177/oauth/tracker/callback')
    expect(confirm.mock.calls[0]?.[0]).toContain('"id":"tracker"')

    answer(true)
    await running
    expect(navigate).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL)
  })

  it('a different port on a loopback host still asks', async () => {
    const { deps, confirm } = setup({
      origin: 'http://localhost:5000',
      redirectUri: 'http://127.0.0.1:4177/oauth/tracker/callback',
      confirm: false,
    })
    await authorizeMcpServer('tracker', deps)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('cancel does not navigate', async () => {
    const { deps, confirm, navigate } = setup({
      origin: 'https://agh.example.com',
      redirectUri: 'http://127.0.0.1:4177/oauth/tracker/callback',
      confirm: false,
    })
    await authorizeMcpServer('tracker', deps)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('an error answer opens the start page itself, which shows the reason', async () => {
    const { deps, confirm, navigate } = setup({
      origin: 'http://127.0.0.1:4177',
      redirectUri: '',
      response: new Response(JSON.stringify({ error: 'oauth_discovery_failed' }), { status: 502 }),
    })
    await authorizeMcpServer('tracker', deps)
    expect(confirm).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/oauth/tracker/start')
  })

  it('a failed request opens the start page too', async () => {
    const { deps, fetchMock, navigate } = setup({ origin: 'http://127.0.0.1:4177', redirectUri: '' })
    fetchMock.mockRejectedValue(new TypeError('network down'))
    await authorizeMcpServer('tracker', deps)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/oauth/tracker/start')
  })
})
