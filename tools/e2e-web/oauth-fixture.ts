import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ISSUED_VALUE = 'e2e-issued-value'

export type TestCertificate = Readonly<{ certPath: string; cert: string; key: string }>

let certificate: Promise<TestCertificate> | undefined

/**
 * A throwaway self-signed certificate for 127.0.0.1. The sign-in code only talks to `https:`
 * authorization servers, so the fake one needs TLS; the runtime trusts this certificate through
 * `NODE_EXTRA_CA_CERTS`, which must be set before it starts.
 */
export function testCertificate(): Promise<TestCertificate> {
  certificate ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-e2e-tls-'))
    const certPath = join(dir, 'cert.pem')
    const keyPath = join(dir, 'key.pem')
    await run('openssl', [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'],
      ...['-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1'],
      ...['-addext', 'subjectAltName=IP:127.0.0.1'],
    ])
    return { certPath, cert: await readFile(certPath, 'utf8'), key: await readFile(keyPath, 'utf8') }
  })()
  return certificate
}

export type OAuthFixture = Readonly<{
  /** The address a test passes as the MCP server URL. */
  serverUrl: string
  /** Token requests received, in order. */
  tokenRequests: readonly URLSearchParams[]
  close(): Promise<void>
}>

/**
 * One HTTPS origin that is both the MCP server address and its authorization server: RFC 8414
 * metadata, an `/authorize` that approves at once by redirecting back with a code, and a `/token`
 * that checks the PKCE verifier before issuing a token.
 */
export async function startOAuthFixture(): Promise<OAuthFixture> {
  const { cert, key } = await testCertificate()
  const challenges = new Map<string, { challenge: string; redirectUri: string }>()
  const tokenRequests: URLSearchParams[] = []
  let origin = ''
  const server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      if (!redirectUri || !challenge || url.searchParams.get('code_challenge_method') !== 'S256')
        return void res.writeHead(400).end()
      const code = `code-${challenges.size + 1}`
      challenges.set(code, { challenge, redirectUri })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      return void res.writeHead(302, { location: back.href }).end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        tokenRequests.push(form)
        const issued = challenges.get(form.get('code') ?? '')
        const verified =
          issued !== undefined &&
          issued.redirectUri === form.get('redirect_uri') &&
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') === issued.challenge
        if (!verified) return json(400, { error: 'invalid_grant' })
        json(200, { access_token: ISSUED_VALUE, token_type: 'Bearer', expires_in: 3600 })
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OAuth fixture did not bind')
  origin = `https://127.0.0.1:${address.port}`
  return {
    serverUrl: `${origin}/mcp`,
    tokenRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
