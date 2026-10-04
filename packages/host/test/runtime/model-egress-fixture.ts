import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReferenceModelEgress } from '../../../../examples/runtime-reference/src/providers/model-egress.js'
import { createCredentialStore } from '../../src/adapters/credential-store.js'
import { createSecretsFile } from '../../src/adapters/secrets.js'
import {
  createModelEgress,
  type ModelEgressOptions,
  type ModelEgressPort,
} from '../../src/runtime/model/model-egress.js'
import {
  boundary,
  cleanup,
  loopback,
  must,
  rule,
  scan,
  scope,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

const MODEL = {
  contract: 'agh.model-adapter',
  logicalName: 'model',
  providerId: 'agh.default/model-adapter',
  bindingId: 'model-binding',
}
export const CONSUMER = {
  consumer: 'model' as const,
  secretId: 'credential',
  accountRef: 'model-account',
  serverRef: 'model-endpoint',
  audience: 'local-model',
  purpose: 'model-inference',
}
export type Recipe = 'default' | 'reference'
const make = (
  kind: Recipe,
  options: ModelEgressOptions,
  call: ReturnType<ReturnType<typeof boundary>['call']>,
): ModelEgressPort =>
  kind === 'default' ? createModelEgress(options, call) : createReferenceModelEgress(options, call)

export async function modelFixture(kind: Recipe, api = 'openai-completions', path = '/v1/chat/completions') {
  const root = scratch(),
    auth = boundary()
  const key = `sk-local-${randomBytes(24).toString('hex')}`
  const credentials = createCredentialStore({ root: join(root, 'home') })
  await credentials.putApiKey('secret://model/key', key)
  const logs: string[] = []
  const observations: { path: string; correctKey: boolean; body: string }[] = []
  let arrived!: () => void
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.on('data', (chunk) => {
      body += String(chunk)
    })
    incoming.on('end', () => {
      observations.push({
        path: incoming.url ?? '',
        body,
        correctKey:
          api === 'anthropic-messages'
            ? incoming.headers['x-api-key'] === key
            : incoming.headers.authorization === `Bearer ${key}`,
      })
      arrived()
      if (path === '/hang') return
      if (path === '/redirect') {
        response.writeHead(307, { location: '/other' })
        response.end()
      } else if (path === '/echo-key') {
        response.end(key)
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': key, 'x-secret': key })
        response.end('data: {"answer":"local-answer"}\n\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Peer did not bind')
  const call = auth.call({ bindingId: MODEL.bindingId })
  const broker = secrets(kind, join(root, 'broker'), auth, {
    source: createSecretsFile({ dir: join(root, 'home', 'secrets') }),
    entries: [{ secretId: 'credential', versions: [{ version: 'v1', ref: 'secret://model/key' }] }],
    grants: [{ principalRef: call.principalRef, scope, binding: CONSUMER }],
  })
  const handle = must(
    await broker.resolve(
      { secretId: CONSUMER.secretId, audience: CONSUMER.audience, purpose: CONSUMER.purpose },
      call,
    ),
  )
  const target = {
    targetId: 'model-peer',
    scheme: 'http' as const,
    host: 'localhost',
    port: address.port,
    path,
  }
  let current = true,
    networkAllowed = true
  const endpoint = { endpointRef: 'model-endpoint', target, method: 'POST' as const }
  const networkRule = rule(address.port, { targetId: target.targetId })
  const options = {
    installation: {
      binding: MODEL,
      route: 'local-model',
      api,
      endpointRef: 'model-endpoint',
      consumer: CONSUMER,
      handle,
    },
    endpoints: [endpoint],
    current: (input) => current && input === call,
    network: {
      identity: auth.identity,
      tenantId: 'tenant',
      authorize: () => networkAllowed,
      rules: [networkRule],
      resolver: loopback,
    },
    secrets: broker,
  } satisfies ModelEgressOptions
  const ports: ModelEgressPort[] = []
  function port(patch: Partial<ModelEgressOptions> = {}, context = call) {
    const service = make(kind, { ...options, ...patch }, context)
    ports.push(service)
    return service
  }
  const url = `http://localhost:${address.port}${path}`
  const request = (destination = url, patch: RequestInit = {}) =>
    new Request(destination, {
      method: 'POST',
      body: '{"model":"local","messages":[]}',
      headers: { 'content-type': 'application/json' },
      ...patch,
    })
  async function code(job: Promise<unknown>) {
    try {
      await job
      throw new Error('Expected refusal')
    } catch (problem) {
      const error = problem as Error & { code?: string; detailCode?: string }
      assert.equal(error.message, 'Model egress request refused')
      const snapshot = {
        name: error.name,
        message: error.message,
        code: error.code,
        detailCode: error.detailCode,
        cause: error.cause,
        stack: error.stack,
      }
      logs.push(JSON.stringify(snapshot))
      return `${error.code}/${error.detailCode}`
    }
  }
  return {
    endpoint,
    networkRule,
    root,
    key,
    auth,
    broker,
    call,
    options,
    target,
    url,
    arrival,
    observations,
    logs,
    request,
    port,
    code,
    retire: () => {
      current = false
    },
    denyNetwork: () => {
      networkAllowed = false
    },
    async close() {
      for (const transport of ports) await transport.close()
      await broker.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      scan(join(root, 'broker'), [key], logs)
      cleanup(root)
    },
  }
}

export async function coldModelEgress(kind: Recipe) {
  const f = await modelFixture(kind)
  async function child() {
    const file = fileURLToPath(new URL('./model-egress-child.ts', import.meta.url))
    const input = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        file,
        kind,
        f.root,
        String(f.target.port),
        JSON.stringify(f.options.installation.handle),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = '',
      diagnostic = ''
    input.stdout.on('data', (data) => {
      output += String(data)
    })
    input.stderr.on('data', (data) => {
      diagnostic += String(data)
    })
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        input.kill('SIGKILL')
        reject(new Error('Cold consumer timed out'))
      }, 10000)
      input.once('error', reject)
      input.once('exit', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })
    f.logs.push(output, diagnostic)
    assert.equal(exit, 0)
    return JSON.parse(output)
  }
  try {
    assert.deepEqual(await child(), { status: 200 })
    assert.deepEqual(
      f.observations.map((item) => item.correctKey),
      [true],
    )
    must(await f.broker.revoke({ secretId: CONSUMER.secretId, reason: 'test' }, f.auth.call({}, true)))
    const refused = await child()
    assert.deepEqual(refused, { code: 'denied', detailCode: 'model_egress_credential' })
    assert.equal(f.observations.length, 1)
    return { initialStatus: 200, refusal: `${refused.code}/${refused.detailCode}`, requests: 1 }
  } finally {
    await f.close()
  }
}
