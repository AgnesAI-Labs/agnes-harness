import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHostRuntimeClientPorts } from '@agnes/host'
import { RuntimeClientTransportPolicy, RuntimeClientTransportWire } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryJournal } from '../../../sdk/src/journal.js'
import {
  RuntimeClientTransport,
  readOutcome,
  runtimeJournalKey,
} from '../../../sdk/src/runtime/client-transport.js'
import type { RuntimeClientPorts } from '../../src/runtime/transport.js'
import { runtimeClientBearer } from '../../src/supervisor/runtime-credential.js'
import { listenWebSocket } from '../../src/supervisor/ws.js'

// The runtime client routes on the daemon's real HTTP listener, spoken to as the SDK speaks: every
// generated route answers, admission is the listener's own, and refusals parse as typed Outcomes.

const { routes, jsonMime } = RuntimeClientTransportWire
type Served = Exclude<keyof typeof routes, 'websocket'>
const origin = 'http://127.0.0.1:4177'
const json = `${jsonMime}; charset=utf-8`
const header = { negotiatedSession: 's1', clientInstanceId: 'ci-1', catalogRevision: 1, callId: 'call-1' }
const scope = { installationId: 'inst-1', runtimeId: 'rt-1', workspaceId: 'ws-1', kind: 'workspace' }
const capabilities = {
  clientInstanceId: 'ci-1',
  target: 'sdk' as const,
  protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
  viewSchemaRanges: [],
  renderKeys: [],
  features: [RuntimeClientTransportWire.feature],
  capabilitiesRevision: 1,
  interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
  files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
  display: { plainText: true, markdown: true, maxTextBytes: 1024, inlinePreviewMimes: [] },
}
const hello = { capabilities, authorApi: [], loadedBundles: [] }
const welcome = {
  welcome: {
    negotiatedSession: 's1',
    wireVersion: { major: 2, minor: 0 },
    catalogRevision: 1,
    capabilities: { ...capabilities, negotiatedSession: 's1', effectivePolicyRevision: 1 },
    modules: [],
    domainSchemas: [],
    mode: 'compatible' as const,
    reasons: [],
    clientInstanceId: 'ci-1',
  },
  catalogPage: { nextCursor: null, complete: true },
}
const catalogStatus = { catalogRevision: 1, mode: 'compatible' as const, reasonCode: null }
const cancel = { sessionId: 'conv-1', runId: 'run-1', requestId: 'req-1' }
const nonce = `${'a'.repeat(42)}A`
const failure = (detailCode: string, code: string, kind = 'never') => ({
  ok: false,
  error: { code, detailCode, message: detailCode, retryAdvice: { kind }, diagnosticId: 'diag-1' },
})

/** One valid request per served route; a generated route missing here fails typecheck and the table. */
const valid: Record<Served, unknown> = {
  bootstrap: hello,
  clientQuery: { header, call: { operation: 'transport.catalogStatus', input: { header } } },
  clientCommand: { header, call: { operation: 'conversation.cancel', input: cancel } },
  catalogPage: {
    negotiatedSession: 's1',
    clientInstanceId: 'ci-1',
    catalogRevision: 1,
    cursor: null,
    limit: 100,
  },
  subscribe: { header, topic: 'interactions', input: { scope } },
  readSubscription: { header, subscriptionId: 'sub-1', cursor: null, limit: 256 },
  closeSubscription: { header, subscriptionId: 'sub-1' },
  catalogStatus: { header },
  streamStatus: { header, streamId: 'stream-1' },
  readRange: { header, input: { artifactId: 'art-1', version: 1, offset: 0, length: 16 } },
  openStream: { header, input: { artifactId: 'art-1', version: 1 } },
  download: `?nonce=${nonce}`,
}
/** The push socket is an upgrade; no plain HTTP route serves it. */
const unserved = new Set(['websocket'])

const closers = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.all([...closers].map((close) => close()))
  closers.clear()
})

async function local(runtimeClient: RuntimeClientPorts = {}) {
  const listener = await listenWebSocket({
    addr: '127.0.0.1:0',
    localOrigin: origin,
    token: 'test-local-token',
    endpoint: () => {
      throw new Error('no RPC session is expected')
    },
    runtimeClient,
  })
  closers.add(() => listener.close())
  return listener.url.replace(/^ws/, 'http')
}

/** A request as the SDK sends it from the page origin; text, bytes and streams go out verbatim. */
function send(base: string, path: string, body: unknown, init: RequestInit = {}) {
  const verbatim = typeof body === 'string' || ArrayBuffer.isView(body) || body instanceof ReadableStream
  return fetch(base + path, {
    method: 'POST',
    ...init,
    headers: { origin, 'content-type': json, ...(init.headers as Record<string, string>) },
    ...(init.method === 'GET' ? {} : { body: verbatim ? (body as BodyInit) : JSON.stringify(body) }),
  })
}

/** The route's request: the download ticket lives in its path and query, every other input in the body. */
function call(base: string, name: Served, input: unknown, init: RequestInit = {}) {
  const path = routes[name].path.replace('{ticketId}', 'ticket-1')
  return name === 'download'
    ? send(base, `${path}${input}`, undefined, { method: 'GET', ...init })
    : send(base, path, input, init)
}

async function refusal(response: Response) {
  const outcome = await readOutcome(response)
  return outcome && !outcome.ok ? { status: response.status, detailCode: outcome.error.detailCode } : outcome
}

/** Raw HTTP for what fetch will not send: a forged Host, a declared body never sent, a fixture CA. */
function raw(url: string, headers: Record<string, string>, body = '', ca?: string) {
  const target = new URL(url)
  const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
    method: 'POST',
    headers,
    ...(ca ? { ca } : {}),
  })
  return new Promise<{ status: number; connection: string | undefined; text: string }>((resolve, reject) => {
    request.once('response', (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        text += chunk
      })
      response.once('end', () =>
        resolve({ status: response.statusCode ?? 0, connection: response.headers.connection, text }),
      )
    })
    request.on('error', reject)
    if (body) request.end(body)
    else request.flushHeaders()
  })
}

describe('runtime client routes', () => {
  it('admits only the current runtime bearer before body reads, gates Host reads and refuses writes', async () => {
    const secret = 'local-secret'.repeat(5)
    const bearer = runtimeClientBearer(secret, 'generation-1')
    let current = true
    let permitted = true
    const caller = { principalId: 'local' as const, generation: 'generation-1' }
    const listener = await listenWebSocket({
      addr: '127.0.0.1:0',
      token: bearer,
      runtimeOnly: { current: async () => current },
      endpoint: () => {
        throw new Error('private HTTP must not admit RPC')
      },
      runtimeClient: createHostRuntimeClientPorts(
        {
          authorize: async (identity, request) => {
            expect(identity).toEqual(caller)
            expect(request.operation).toBe('transport.catalogStatus')
            return permitted
              ? { ok: true, value: true }
              : {
                  ok: false,
                  error: {
                    code: 'denied',
                    detailCode: 'c14_denied',
                    message: 'denied',
                    diagnosticId: 'synthetic-policy',
                    retryAdvice: { kind: 'never' },
                  },
                }
          },
          queries: { 'transport.catalogStatus': async () => ({ ok: true, value: catalogStatus }) },
        },
        caller,
      ),
    })
    closers.add(() => listener.close())
    // Content-Length without body: admission must reply immediately, not wait for route parsing.
    for (const token of ['', 'wrong', secret, runtimeClientBearer(secret, 'generation-0')]) {
      const denied = await raw(listener.url + routes.clientQuery.path, {
        'content-type': json,
        'content-length': '100',
        authorization: `Bearer ${token}`,
      })
      expect(denied).toMatchObject({ status: 401, connection: 'close', text: '' })
    }
    current = false
    expect(
      await raw(listener.url + routes.clientQuery.path, {
        'content-type': json,
        'content-length': '100',
        authorization: `Bearer ${bearer}`,
      }),
    ).toMatchObject({ status: 401, connection: 'close' })
    current = true
    const query = () =>
      call(listener.url, 'clientQuery', valid.clientQuery, {
        headers: { authorization: `Bearer ${bearer}`, origin: '' },
      })
    // The CLI sends no Origin; an authenticated browser page is not this private transport.
    expect((await query()).status).toBe(403)
    const headers = { authorization: `Bearer ${bearer}`, 'content-type': json }
    const read = () =>
      fetch(listener.url + routes.clientQuery.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(valid.clientQuery),
      })
    expect(await (await read()).json()).toMatchObject({
      ok: true,
      value: { reply: { value: catalogStatus } },
    })
    permitted = false
    expect(await refusal(await read())).toEqual({ status: 403, detailCode: 'c14_denied' })
    expect(
      await refusal(
        await fetch(listener.url + routes.clientCommand.path, {
          method: 'POST',
          headers,
          body: JSON.stringify(valid.clientCommand),
        }),
      ),
    ).toEqual({ status: 409, detailCode: 'operation_not_supported' })
    await listener.close()
    await expect(fetch(listener.url)).rejects.toThrow()
  })

  it('serves every generated route but the push socket', () => {
    expect(Object.keys(routes).filter((name) => !unserved.has(name))).toEqual(Object.keys(valid))
  })

  it.each(Object.keys(valid) as Served[])(
    '%s refuses a wrong method, a malformed input and, without a port, a valid one',
    async (name) => {
      const base = await local()
      const { method } = routes[name]
      const wrong = await call(base, name, '', { method: method === 'GET' ? 'POST' : 'GET' })
      expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, method])
      expect(await refusal(await call(base, name, name === 'download' ? '' : {}))).toEqual({
        status: 400,
        detailCode: 'invalid_request',
      })
      expect(await refusal(await call(base, name, valid[name]))).toEqual({
        status: 409,
        detailCode: 'operation_not_supported',
      })
    },
  )

  it('answers paths outside the generated table with 404', async () => {
    const base = await local()
    for (const path of [
      '/api/runtime/client/unknown',
      `${routes.bootstrap.path}/`,
      '/api/runtime/artifact/download/a/b',
      '/elsewhere',
    ])
      expect((await send(base, path, hello)).status).toBe(404)
  })

  it('bounds, types and parses the body before any port sees it', async () => {
    const seen: unknown[] = []
    const base = await local({
      bootstrap: async (value) => {
        seen.push(value)
        return { ok: true, value: welcome }
      },
    })
    const path = routes.bootstrap.path
    const limit = RuntimeClientTransportPolicy.maxJsonBytes
    const declared = await raw(`${base}${path}`, {
      origin,
      'content-type': json,
      'content-length': String(limit + 1),
    })
    expect([declared.status, declared.connection, JSON.parse(declared.text).error.detailCode]).toEqual([
      413,
      'close',
      'rpc_json_bytes',
    ])
    // Chunked, so only the bytes that arrive can tell.
    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    expect(await refusal(await send(base, path, chunked, { duplex: 'half' } as RequestInit))).toEqual({
      status: 413,
      detailCode: 'rpc_json_bytes',
    })
    for (const [body, init] of [
      [JSON.stringify(hello), { headers: { 'content-type': 'text/plain' } }],
      ['{"capabilities":', {}],
      [Uint8Array.of(0x7b, 0xff, 0x7d), {}],
    ] as const)
      expect(await refusal(await send(base, path, body, init))).toEqual({
        status: 400,
        detailCode: 'invalid_request',
      })
    expect(seen).toEqual([])
    expect((await send(base, path, hello)).status).toBe(200)
    expect(seen).toEqual([hello])
  })

  it('refuses unauthenticated requests with the upgrade statuses before any port runs', async () => {
    let calls = 0
    const ports: RuntimeClientPorts = {
      bootstrap: async () => {
        calls++
        return { ok: true, value: welcome }
      },
    }
    const base = await local(ports)
    const url = `${base}${routes.bootstrap.path}`
    const body = JSON.stringify(hello)
    for (const headers of [{}, { origin: 'http://evil.example' }, { origin, host: 'evil.example' }] as Record<
      string,
      string
    >[])
      expect(await raw(url, { 'content-type': json, ...headers }, body)).toEqual({
        status: 403,
        connection: 'close',
        text: '',
      })
    expect((await raw(`${base}/api/runtime/client/unknown`, {}, body)).status).toBe(403)

    const tls = (name: string) =>
      readFileSync(
        new URL(`../../../../tools/test-fixtures/tls/localhost-${name}.pem`, import.meta.url),
        'utf8',
      )
    const cert = tls('cert')
    const remote = await listenWebSocket({
      addr: '127.0.0.1:0',
      cert,
      key: tls('key'),
      token: 'test-remote-token',
      endpoint: () => {
        throw new Error('no RPC session is expected')
      },
      runtimeClient: ports,
    })
    closers.add(() => remote.close())
    const secure = `${remote.url.replace(/^wss/, 'https')}${routes.bootstrap.path}`
    for (const authorization of [undefined, 'Bearer wrong-token'])
      expect(
        await raw(secure, { 'content-type': json, ...(authorization ? { authorization } : {}) }, body, cert),
      ).toEqual({ status: 401, connection: 'close', text: '' })
    expect(calls).toBe(0)
    const admitted = await raw(
      secure,
      { 'content-type': json, authorization: 'Bearer test-remote-token' },
      body,
      cert,
    )
    expect([admitted.status, JSON.parse(admitted.text)]).toEqual([200, { ok: true, value: welcome }])
    expect(calls).toBe(1)
  })

  it('passes a port outcome on only in its registered shape', async () => {
    const outcomes = [
      { ok: true, value: catalogStatus },
      failure('catalog_changed', 'conflict', 'retry_read'),
      { ok: true, value: { catalogRevision: 'one' } },
      failure('catalog_changed', 'internal', 'retry_read'),
      'throw',
    ]
    let next = 0
    const base = await local({
      'transport.catalogStatus': async () => {
        const outcome = outcomes[next++]
        if (outcome === 'throw') throw new Error('backend fault')
        return outcome as never
      },
    })
    const answers = []
    for (let i = 0; i < outcomes.length; i++) {
      const response = await call(base, 'catalogStatus', valid.catalogStatus)
      const outcome = await readOutcome(response)
      answers.push([response.status, outcome?.ok ? outcome.value : outcome?.error.detailCode])
    }
    expect(answers).toEqual([
      [200, catalogStatus],
      [409, 'catalog_changed'],
      [500, 'internal_error'],
      [500, 'internal_error'],
      [500, 'internal_error'],
    ])
  })
})

describe('the SDK client against the runtime client routes', () => {
  const sdk = (baseUrl: string) => {
    const journal = memoryJournal('client-1')
    const client = new RuntimeClientTransport({
      baseUrl,
      hello,
      journal,
      journalPartitionKey: 'partition-1',
      fetch: (url, init) =>
        fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin } }),
    })
    return { client, journal }
  }

  it('reads the unported bootstrap as a typed refusal and stays closed', async () => {
    const { client } = sdk(await local())
    await client.connect()
    expect(client.mode).toBe('incompatible')
    expect(client.refusal).toMatchObject({ code: 'incompatible', detailCode: 'operation_not_supported' })
    expect(await client.query('transport.catalogStatus', {} as never)).toEqual({
      state: 'refused',
      reason: 'incompatible',
    })
  })

  it('hands a port the validated call and returns its outcome; an unported command is refused', async () => {
    const seen: unknown[] = []
    const { client, journal } = sdk(
      await local({
        bootstrap: async (value) => {
          seen.push(value)
          return { ok: true, value: welcome }
        },
        'transport.catalogStatus': async (input, callHeader) => {
          seen.push([input, callHeader])
          return { ok: true, value: catalogStatus }
        },
      }),
    )
    await client.connect()
    expect(client.mode).toBe('compatible')
    expect(await client.query('transport.catalogStatus', {} as never)).toEqual({
      state: 'ok',
      value: catalogStatus,
    })
    const [bootstrapped, [input, callHeader]] = seen as [unknown, [{ header: unknown }, { callId: string }]]
    expect(bootstrapped).toEqual(hello)
    expect(input).toEqual({ header: callHeader })
    expect(callHeader).toEqual({
      negotiatedSession: 's1',
      clientInstanceId: 'ci-1',
      catalogRevision: 1,
      callId: callHeader.callId,
    })

    const refused = await client.command('conversation.cancel', cancel)
    expect(refused).toMatchObject({ state: 'failed', error: { detailCode: 'operation_not_supported' } })
    // A typed refusal admitted nothing, so the journaled command is cleared.
    expect(await journal.pending(runtimeJournalKey('partition-1'))).toEqual([])
  })
})
