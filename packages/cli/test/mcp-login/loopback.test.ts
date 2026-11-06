import { connect, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { McpLoginPortBusy, startLoopbackCallback } from '../../src/mcp-login/loopback.js'
import { McpLoginRefused } from '../../src/mcp-login/paste.js'

const closers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function listening(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

async function start(port = 0, fixedPort = false) {
  const listener = await startLoopbackCallback({
    port,
    fixedPort,
    state: 'state-1',
    signal: new AbortController().signal,
  })
  closers.push(() => listener.close())
  return listener
}

const local = (redirectUri: string, query: string) =>
  `${redirectUri.replace('localhost', '127.0.0.1')}${query}`

describe('the loopback sign-in callback', () => {
  it('browser callback completes the login', async () => {
    const listener = await start()
    expect(listener.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    const page = fetch(local(listener.redirectUri, '?code=abc&state=state-1'))
    expect(await listener.code).toBe('abc')
    listener.finish('signed-in')
    const response = await page
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    )
    expect(await response.text()).toContain('You can close this page')
  })

  it('wrong path: 404', async () => {
    const listener = await start()
    const response = await fetch(local(listener.redirectUri, '/../other?code=abc&state=state-1'))
    expect(response.status).toBe(404)
  })

  it('unknown state on the callback: 400 and the login keeps waiting', async () => {
    const listener = await start()
    const refused = await fetch(local(listener.redirectUri, '?code=abc&state=other'))
    expect(refused.status).toBe(400)
    const page = fetch(local(listener.redirectUri, '?code=good&state=state-1'))
    expect(await listener.code).toBe('good')
    listener.finish('signed-in')
    expect((await page).status).toBe(200)
  })

  it('only the first valid callback counts', async () => {
    const listener = await start()
    const first = fetch(local(listener.redirectUri, '?code=first&state=state-1'))
    expect(await listener.code).toBe('first')
    const second = await fetch(local(listener.redirectUri, '?code=second&state=state-1'))
    expect(second.status).toBe(400)
    expect(await listener.code).toBe('first')
    listener.finish('signed-in')
    expect((await first).status).toBe(200)
  })

  it('an error from the authorization server ends the wait and shows on the page', async () => {
    const listener = await start()
    const caught = listener.code.catch((error: unknown) => error)
    const response = await fetch(local(listener.redirectUri, '?error=access_denied&state=state-1'))
    expect(response.status).toBe(400)
    expect(await caught).toBeInstanceOf(McpLoginRefused)
  })

  it('a request target no URL parser accepts is 400, and the wait goes on', async () => {
    const listener = await start()
    const port = Number(new URL(listener.redirectUri).port)
    const answer = await new Promise<string>((resolve, reject) => {
      let text = ''
      const socket = connect(port, '127.0.0.1', () =>
        socket.write('GET http://[/ HTTP/1.1\r\nHost: x\r\n\r\n'),
      )
      socket.on('data', (chunk) => {
        text += String(chunk)
        socket.end()
      })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    expect(answer).toMatch(/^HTTP\/1\.1 400/)
    const page = fetch(local(listener.redirectUri, '?code=abc&state=state-1'))
    expect(await listener.code).toBe('abc')
    listener.finish('signed-in')
    expect((await page).status).toBe(200)
  })

  it('fixed callbackPort busy: error, no other port', async () => {
    const { port } = await listening()
    await expect(start(port, true)).rejects.toBeInstanceOf(McpLoginPortBusy)
  })

  it('a preferred port that is busy falls back to a random one', async () => {
    const { port } = await listening()
    const listener = await start(port, false)
    expect(listener.redirectUri).not.toBe(`http://localhost:${port}/callback`)
  })

  it('no callbackPort: random port', async () => {
    const a = await start()
    const b = await start()
    expect(a.redirectUri).not.toBe(b.redirectUri)
  })

  it('close stops listening and answers a held callback', async () => {
    const listener = await start()
    const page = fetch(local(listener.redirectUri, '?code=abc&state=state-1'))
    await listener.code
    await listener.close()
    expect((await page).status).toBe(400)
    await expect(fetch(local(listener.redirectUri, '?code=abc&state=state-1'))).rejects.toThrow()
  })
})
