import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { createModelAdapterFactory } from '@agnes/ai/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type JsonValue,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { modelFixture } from '../../../ai/test/runtime/model-fixture.js'
import { createCredentialStore } from '../../src/adapters/credential-store.js'
import { createSecretsFile } from '../../src/adapters/secrets.js'
import { createHostModelAdapterDeployment } from '../../src/runtime/model/model-deployment.js'
import type { ModelEgressOptions } from '../../src/runtime/model/model-egress.js'
import { openModelSourceStore } from '../../src/runtime/model/model-source-store.js'
import { boundary, cleanup, loopback, must, rule, scan, scratch, secrets } from './network-secrets-fixture.js'

function inline(schema: DataRef['schema'], input: unknown): DataRef {
  const parsed = validateRuntime('JsonValue', input)
  if (!parsed.ok) throw new Error('Invalid fixture input')
  const body = boundedCanonicalJson(parsed.value, { maxBytes: 262144, maxDepth: 128, maxMembers: 10000 })
  if (!body.ok) throw new Error('Oversized fixture input')
  return {
    kind: 'inline',
    schema,
    value: body.value.json,
    digest: canonicalJsonDigest(body.value.json),
    bytes: body.value.bytes,
  }
}

/** Synthetic source/identity owners, real legacy credential store/C22 broker, Pi and HTTP peer. */
export async function modelJointFixture(
  api: 'openai-completions' | 'anthropic-messages' = 'openai-completions',
  mode:
    | 'normal'
    | 'redirect'
    | 'hang'
    // Peer behaviours for the wire joint: the response is cut after the request was read, the peer
    // closes or resets the connection before reading, or nothing listens on the endpoint port.
    | 'cut-mid'
    | 'cut-silent'
    | 'close-first'
    | 'reset-first'
    | 'refused' = 'normal',
  patch: Partial<ModelEgressOptions> | ((options: ModelEgressOptions) => Partial<ModelEgressOptions>) = {},
  injected = true,
  extra: {
    /** Use the real Host source store for the fence, save and lookup instead of the journal stand-in. */
    store?: boolean
    /** The egress fetch throws before it writes anything. */
    throwEgress?: boolean
  } = {},
) {
  const root = scratch(),
    auth = boundary(),
    key = `sk-local-${randomBytes(24).toString('hex')}`
  const observations: { path: string; body: string; correctKey: boolean }[] = []
  const diagnostics: unknown[] = [],
    hashes: string[] = []
  const wire: { hash: string; redirect: RequestRedirect; markerOnly: boolean }[] = []
  let arrived!: () => void
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const peerStats = { bytes: 0, connections: 0 }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    observations.push({
      path: request.url ?? '',
      body,
      correctKey:
        api === 'anthropic-messages'
          ? request.headers['x-api-key'] === key
          : request.headers.authorization === `Bearer ${key}`,
    })
    arrived()
    if (mode === 'hang') return
    if (mode === 'cut-silent') return void request.socket.destroy()
    if (mode === 'redirect') {
      response.writeHead(307, { location: '/escaped' }).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'joint-response' })
    const send = (value: unknown, event?: string) =>
      response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`)
    const model = JSON.parse(body).model
    if (api === 'anthropic-messages') {
      send(
        {
          type: 'message_start',
          message: {
            id: 'joint-response',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        },
        'message_start',
      )
      send(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        'content_block_start',
      )
      send(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'joint answer' } },
        'content_block_delta',
      )
      if (mode === 'cut-mid') return void setTimeout(() => request.socket.destroy(), 20)
      send({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      send(
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        'message_delta',
      )
      send({ type: 'message_stop' }, 'message_stop')
    } else {
      send({
        id: 'joint-response',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'joint answer' }, finish_reason: null }],
      })
      if (mode === 'cut-mid') return void setTimeout(() => request.socket.destroy(), 20)
      send({
        id: 'joint-response',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
  server.on('connection', (socket: Socket) => {
    peerStats.connections++
    if (mode === 'close-first') return void socket.destroy()
    if (mode === 'reset-first') return void socket.resetAndDestroy()
    socket.on('data', (chunk) => {
      peerStats.bytes += chunk.length
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Peer did not bind')
  const template = await modelFixture(
    api,
    `http://localhost:${address.port}${api === 'anthropic-messages' ? '' : '/v1'}`,
    join(root, 'effect.json'),
  )
  await template.action.close('shutdown')
  await template.provider.close('shutdown')
  const abort = new AbortController(),
    call = auth.call({ ...template.context, signal: abort.signal })
  const store = createCredentialStore({ root: join(root, 'home') })
  await store.putApiKey('secret://model/key', key)
  const consumer = template.source.prepared.target.credentialBinding
  if (!consumer) throw new Error('Missing model consumer')
  const broker = secrets('default', join(root, 'broker'), auth, {
    source: createSecretsFile({ dir: join(root, 'home', 'secrets') }),
    entries: [{ secretId: consumer.secretId, versions: [{ version: 'v1', ref: 'secret://model/key' }] }],
    grants: [{ principalRef: call.principalRef, scope: call.scope, binding: consumer }],
  })
  const handle = must(
    await broker.resolve(
      { secretId: consumer.secretId, audience: consumer.audience, purpose: consumer.purpose },
      call,
    ),
  )
  template.source.prepared.credentialRef = handle
  const sourceDigest = canonicalJsonDigest(template.source as never)
  const frame = { ...template.frame }
  if (frame.input.kind !== 'inline') throw new Error('Missing inline fixture locator')
  const locator = (frame.input.value as { preparedCallRef: DataRef }).preparedCallRef
  frame.input = inline(frame.input.schema, {
    preparedCallRef: inline(locator.schema, {
      preparedDigest: canonicalJsonDigest(template.source.prepared as never),
      inputDigest: template.source.prepared.inputDigest,
    }),
    externalIdempotencyKey: frame.requestIdentity?.idempotencyKey,
  })
  frame.inputDigest = canonicalJsonDigest(frame.input.kind === 'inline' ? frame.input.value : null)
  const { signal: _signal, ...wireCall } = call
  frame.context = wireCall
  const context = { ...template.call, call }
  let live = true,
    uses = 0
  const sourceStore = extra.store
    ? openModelSourceStore({
        path: join(root, 'model-source.sqlite'),
        soleSendFence: true,
        calls: {
          attempt: (attemptId) =>
            attemptId === frame.attemptId && frame.requestIdentity
              ? {
                  runId: frame.runId,
                  actionId: frame.actionId,
                  attemptId,
                  bindingId: frame.bindingId,
                  inputDigest: frame.inputDigest,
                  requestIdentity: frame.requestIdentity,
                }
              : undefined,
        },
      })
    : undefined
  const owner = {
    ...template.deployment,
    ...(sourceStore ? { save: sourceStore.deployment.save, lookup: sourceStore.deployment.lookup } : {}),
    installed: (input: typeof call) => live && input === call,
    current: (source: typeof template.source, input: typeof frame, actual: typeof call) =>
      live &&
      source === template.source &&
      actual === call &&
      input === frame &&
      canonicalJsonDigest(source as never) === sourceDigest,
    load: async (ref: DataRef) => {
      const expected = (frame.input.kind === 'inline' ? frame.input.value : null) as {
        preparedCallRef: JsonValue
      }
      if (canonicalJsonDigest(ref as never) !== canonicalJsonDigest(expected.preparedCallRef))
        throw new Error('Fixture locator refused')
      return { ok: true as const, value: template.source }
    },
    beforeSend: (
      _source: typeof template.source,
      _frame: typeof frame,
      _context: typeof context,
      hash: string,
    ) => {
      hashes.push(hash)
      return live && (sourceStore ? sourceStore.fence(_frame, hash) : true)
    },
  }
  const path = api === 'anthropic-messages' ? '/v1/messages?beta=true' : '/v1/chat/completions'
  const defaults: ModelEgressOptions = {
    installation: {
      binding: template.source.prepared.target.adapter,
      route: template.source.route.route,
      api,
      endpointRef: 'fixture-endpoint',
      consumer,
      handle,
    },
    endpoints: [
      {
        endpointRef: 'fixture-endpoint',
        method: 'POST',
        target: { targetId: 'joint-peer', scheme: 'http', host: 'localhost', port: address.port, path },
      },
    ],
    current: (input) => live && input === call,
    network: {
      identity: auth.identity,
      tenantId: 'tenant',
      authorize: () => true,
      rules: [rule(address.port, { targetId: 'joint-peer' })],
      resolver: loopback,
    },
    secrets: {
      use: async (...args) => {
        uses++
        return broker.use(...args)
      },
    },
  }
  const options = { ...defaults, ...(typeof patch === 'function' ? patch(defaults) : patch) }
  const deployment = createHostModelAdapterDeployment(owner, [options])
  const egress = deployment.egress
  const fetches: (typeof globalThis.fetch)[] = []
  if (injected)
    deployment.egress = (source, input, actual) => {
      const fetch = egress?.(source, input, actual)
      const wrapped: typeof globalThis.fetch | undefined =
        fetch &&
        (async (request, init) => {
          const sent = new Request(request, init)
          wire.push({
            hash: createHash('sha256')
              .update(Buffer.from(await sent.clone().arrayBuffer()))
              .digest('hex'),
            redirect: sent.redirect,
            markerOnly: ![...sent.headers.values()].some((value) => value.includes(key)),
          })
          try {
            if (extra.throwEgress) throw new TypeError('fetch failed before any write')
            return await fetch(sent)
          } catch (problem) {
            const error = problem as Error & { code: string; detailCode: string }
            diagnostics.push({
              name: error.name,
              message: error.message,
              code: error.code,
              detailCode: error.detailCode,
              stack: error.stack,
              cause: error.cause,
              headerNames: [...sent.headers.keys()],
            })
            throw problem
          }
        })
      if (wrapped) fetches.push(wrapped)
      return wrapped
    }
  else delete deployment.egress
  const factory = createModelAdapterFactory(deployment)
  const provider = await factory.create(
    must(deployment.config.encode({})),
    createTestServiceContainer().dependencies,
    {
      instanceId: 'joint',
      bindingId: call.bindingId,
      scope: call.scope,
      signal: new AbortController().signal,
    },
  )
  must(await provider.ready(call))
  if (mode === 'refused') {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  const invoke = provider.actions?.invoke
  if (!invoke) throw new Error('Missing joint invoke factory')
  const action = await invoke.create({
    instanceId: 'joint-leaf',
    actionId: frame.actionId,
    runId: frame.runId,
    bindingId: call.bindingId,
    scope: {
      kind: 'action',
      installationId: 'fixture-installation',
      runtimeId: 'fixture-runtime',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: frame.runId,
      actionId: frame.actionId,
    },
    signal: new AbortController().signal,
  })
  if (action.kind !== 'leaf') throw new Error('Unexpected joint action')
  must(await action.ready(call))
  return {
    root,
    key,
    options,
    owner,
    deployment,
    broker,
    auth,
    call,
    context,
    frame,
    source: template.source,
    arrival,
    observations,
    diagnostics,
    hashes,
    wire,
    action,
    provider,
    abort,
    store: sourceStore,
    fetches,
    peerStats,
    uses: () => uses,
    retire: () => {
      live = false
    },
    async execute(): Promise<EffectResult> {
      const result = await action.execute(frame, context)
      diagnostics.push(result)
      return result
    },
    async close() {
      await action.close('shutdown')
      await provider.close('shutdown')
      await broker.close()
      sourceStore?.close()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      scan(join(root, 'broker'), [key], diagnostics)
      cleanup(root)
    },
  }
}
