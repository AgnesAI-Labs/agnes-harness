import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import { canonicalJsonDigest, type EffectResult, type ReconcileResult } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReferenceModelAdapterFactory } from '../../../../examples/runtime-reference/src/providers/model-adapter.js'
import { referenceModelFixture } from '../../../../examples/runtime-reference/test/runtime/reference-model-fixture.js'
import type { ModelEgressOptions } from '../../src/runtime/model/model-egress.js'
import { openModelSourceStore } from '../../src/runtime/model/model-source-store.js'
import { modelJointFixture } from './model-joint-fixture.js'
import { cleanup, must, scratch } from './network-secrets-fixture.js'

/**
 * Controlled-peer joint of the model request path over the two real wire formats. Real links: the
 * default adapter, the Pi OpenAI and Anthropic wire, the Host deployment and restricted egress, the
 * network and secret services, and the Host source store (send fence, save, lookup). Stand-ins: the
 * source owner (load/current) and the call identity registry. The peer is a loopback server in this
 * process.
 */
const APIS = ['openai-completions', 'anthropic-messages'] as const
type Api = (typeof APIS)[number]
type Joint = Awaited<ReturnType<typeof modelJointFixture>>
type Mode = Parameters<typeof modelJointFixture>[1]

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture value')
  return value
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const key = (f: Joint) => ({ runId: f.frame.runId, actionId: f.frame.actionId, attemptId: f.frame.attemptId })
const stored = (f: Joint) => f.store?.admin.read(key(f))

type Shape = {
  outcome: EffectResult['outcome']
  detail: string | undefined
  externals: number
  usage: string[]
  text: string | null
  finish: string | null
  tokens: string[]
}
function shape(effect: EffectResult): Shape {
  const output = effect.result?.kind === 'inline' ? (effect.result.value as Record<string, unknown>) : null
  const content = output?.outputRef as { value: { content: { text: string }[] } } | undefined
  const quantities = effect.usage.flatMap((fact) =>
    fact.dimensions.kind === 'inline'
      ? ((fact.dimensions.value as { quantities: { value: string }[] }).quantities ?? [])
          .map((q) => q.value)
          .filter((value) => value !== '0')
      : [],
  )
  return {
    outcome: effect.outcome,
    detail: effect.error?.detailCode,
    externals: effect.externalRequests.length,
    usage: effect.usage.map((fact) => fact.certainty),
    text: content?.value.content[0]?.text ?? null,
    finish: (output?.finishReason as string | undefined) ?? null,
    tokens: quantities,
  }
}

const open: Joint[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (open.length) await open.pop()?.close()
})
async function joint(
  api: Api,
  mode: Mode = 'normal',
  patch: Parameters<typeof modelJointFixture>[2] = {},
  injected = true,
  extra: Parameters<typeof modelJointFixture>[4] = {},
) {
  const f = await modelJointFixture(api, mode, patch, injected, { store: true, ...extra })
  open.push(f)
  return f
}
const reconcile = (f: Joint): Promise<ReconcileResult> => f.action.reconcile(f.frame, [], f.context)

describe.each(APIS)('default adapter over the %s wire', (api) => {
  it('sends once, completes with usage, and the digest, receipt and usage trace back to the input', async () => {
    const f = await joint(api)
    const effect = await f.execute()
    expect(effect.outcome, JSON.stringify(f.diagnostics)).toBe('succeeded')
    expect(shape(effect)).toMatchObject({
      text: 'joint answer',
      finish: 'stop',
      usage: ['measured'],
      tokens: expect.arrayContaining(['7', '3']),
    })
    expect(f.observations).toHaveLength(1)
    expect(f.peerStats.connections).toBe(1)
    const peer = required(f.observations[0])
    expect(peer.correctKey).toBe(true)
    // The digest the adapter reported before the send, the fence stored, and what the peer read agree.
    const digest = sha(peer.body)
    expect(f.hashes).toEqual([digest])
    expect(stored(f)).toMatchObject({ state: 'saved', bodyDigest: digest })
    // Original input -> prepared source -> external request body.
    const locator = f.frame.input.kind === 'inline' ? JSON.stringify(f.frame.input.value) : ''
    expect(locator).toContain(f.source.prepared.inputDigest)
    expect(f.source.request.derivedHash).toBe(f.source.prepared.inputDigest)
    expect(JSON.parse(peer.body).model).toBe(f.source.prepared.target.model)
    expect(peer.body).toContain('hello')
    // External request -> receipt -> usage.
    const identity = f.frame.requestIdentity
    expect(effect.externalRequests).toEqual([
      expect.objectContaining({
        requestId: identity?.aghRequestId,
        requestDigest: identity?.requestDigest,
        idempotencyKey: identity?.idempotencyKey,
      }),
    ])
    const fact = required(effect.usage[0])
    expect(fact.externalRequest).toEqual(effect.externalRequests[0])
    expect(fact.attemptId).toBe(f.frame.attemptId)
    expect(fact.actionId).toBe(f.frame.actionId)
    const output = effect.result?.kind === 'inline' ? (effect.result.value as Record<string, unknown>) : null
    expect(output?.providerReceipt).toMatchObject({ kind: 'inline' })
    expect(output?.usageFactRefs).toEqual([
      expect.objectContaining({ usageId: fact.usageId, digest: canonicalJsonDigest(fact as never) }),
    ])
    expect(f.uses()).toBe(1)
  })

  it('reconcile after success returns the saved result without a second send or credential use', async () => {
    const f = await joint(api)
    const effect = await f.execute()
    const again = await reconcile(f)
    expect(again.kind).toBe('resolved')
    if (again.kind === 'resolved') expect(again.result).toEqual(effect)
    expect([f.observations.length, f.uses()]).toEqual([1, 1])
  })

  // A deterministic Host-side refusal before the send fence is a definite failure and leaves no trace.
  it.each([
    ['retired source', (f: Joint) => f.retire()],
    ['cancel before send', (f: Joint) => f.abort.abort()],
  ] as const)(
    'refuses %s as a definite failure before any byte, fence or credential use',
    async (_name, arm) => {
      const f = await joint(api)
      arm(f)
      const effect = await f.execute()
      expect(effect.outcome).toBe('failed')
      expect(effect.error?.code).not.toBe('unknown_effect')
      expect([effect.externalRequests, effect.usage]).toEqual([[], []])
      expect(f.peerStats).toEqual({ bytes: 0, connections: 0 })
      expect(f.uses()).toBe(0)
      expect(f.hashes).toEqual([])
      expect(stored(f)).toBeUndefined()
      expect(f.store?.admin.pending()).toEqual([])
      // A cancelled call context is answered unknown by the store; only a live one proves not-sent.
      if (!f.abort.signal.aborted) expect((await reconcile(f)).kind).toBe('not_found')
    },
  )

  it.each([
    [
      'wrong handle',
      (o: ModelEgressOptions) => ({
        installation: {
          ...required(o.installation),
          handle: { ...required(o.installation).handle, handleId: 'other' },
        },
      }),
    ],
    ['missing network service', () => ({ network: undefined })],
    ['missing secrets service', () => ({ secrets: undefined })],
  ] as const)(
    'refuses %s at Host assembly as a definite failure before any byte or fence',
    async (_name, patch) => {
      const f = await joint(api, 'normal', patch)
      const effect = await f.execute()
      expect(effect.outcome).toBe('failed')
      expect([effect.externalRequests, effect.usage]).toEqual([[], []])
      expect(f.peerStats.connections).toBe(0)
      expect(f.uses()).toBe(0)
      expect(stored(f)).toBeUndefined()
      expect((await reconcile(f)).kind).toBe('not_found')
    },
  )

  it('has no ambient fallback when the host hands out no egress', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch')
    const f = await joint(api, 'normal', {}, false)
    const effect = await f.execute()
    expect(effect.outcome).toBe('failed')
    expect(f.peerStats.connections).toBe(0)
    expect(ambient).not.toHaveBeenCalled()
  })

  it.each(['cut-mid', 'cut-silent'] as const)(
    'peer %s after the request was read: unknown effect, never not-sent, never a second send',
    async (mode) => {
      const f = await joint(api, mode)
      const effect = await f.execute()
      expect(shape(effect)).toMatchObject({ outcome: 'unknown_effect', externals: 1, text: null })
      expect(f.observations).toHaveLength(1)
      expect(stored(f)).toMatchObject({ state: 'saved', bodyDigest: sha(required(f.observations[0]).body) })
      // Reconcile finds the saved unknown result and never says it is safe to retry.
      expect((await reconcile(f)).kind).toBe('unknown')
      // A second attempt at the same child is stopped by the fence before credential use and any byte.
      const second = await f.execute()
      expect(second.outcome).not.toBe('succeeded')
      expect(f.observations).toHaveLength(1)
      expect(f.peerStats.connections).toBe(1)
      expect(f.uses()).toBe(1)
      expect(f.hashes.length).toBe(2)
      expect(stored(f)?.state).toBe('saved')
      expect((await reconcile(f)).kind).toBe('unknown')
    },
  )

  it('cancel after the request left: unknown effect with one request, reconcile unknown, no resend', async () => {
    const f = await joint(api, 'hang')
    const job = f.execute()
    await f.arrival
    f.abort.abort()
    const effect = await job
    expect(effect.outcome).toBe('unknown_effect')
    expect(effect.externalRequests).toHaveLength(1)
    expect(f.observations).toHaveLength(1)
    expect((await reconcile(f)).kind).toBe('unknown')
    expect((await f.execute()).outcome).not.toBe('succeeded')
    expect([f.observations.length, f.uses()]).toEqual([1, 1])
  })

  it('closing the action while the request is pending aborts it and releases egress and credential', async () => {
    const f = await joint(api, 'hang')
    const job = f.execute()
    await f.arrival
    await f.action.close('shutdown')
    expect((await job).outcome).toBe('unknown_effect')
    expect(await refusedBy(required(f.fetches[0]), f)).toBe('model_egress_binding')
    expect(f.peerStats.connections).toBe(1)
    expect(f.uses()).toBe(1)
    expect((await f.execute()).outcome).toBe('failed')
    expect([f.observations.length, f.uses()]).toEqual([1, 1])
  })

  it('a finished call leaves no usable egress behind and a closed provider sends nothing', async () => {
    const f = await joint(api)
    expect((await f.execute()).outcome).toBe('succeeded')
    expect(await refusedBy(required(f.fetches[0]), f)).toBe('model_egress_binding')
    // The credential scope of that call is spent too: a second entry is refused and consumes nothing.
    const consume = vi.fn(async () => 'never')
    expect(await f.deployment.withCredential(f.source, f.frame, f.context, consume)).toMatchObject({
      ok: false,
      error: { detailCode: 'model_egress_binding' },
    })
    expect(consume).not.toHaveBeenCalled()
    await f.action.close('shutdown')
    await f.provider.close('shutdown')
    expect((await f.execute()).outcome).toBe('failed')
    expect([f.observations.length, f.uses()]).toEqual([1, 1])
  })
})

async function refusedBy(fetch: typeof globalThis.fetch, f: Joint): Promise<string | undefined> {
  try {
    await fetch(`http://localhost:1/${f.source.route.api}`, { method: 'POST', body: '{}' })
  } catch (problem) {
    return (problem as { detailCode?: string }).detailCode
  }
  return undefined
}

/**
 * Transport failures before the peer read any byte. The adapter marks the request sent at the
 * fence (before the transport writes), so every row below reports unknown_effect today although the
 * peer provably read nothing. These rows pin the CURRENT behaviour; the expected-red companion
 * below states the definite-failure answer and must turn green only if that classification changes.
 */
type PreByte = {
  name: string
  mode?: Mode
  patch?: Parameters<typeof modelJointFixture>[2]
  extra?: Parameters<typeof modelJointFixture>[4]
  revoke?: boolean
}
const PRE_BYTE: PreByte[] = [
  { name: 'connection refused (closed loopback port)', mode: 'refused' },
  { name: 'peer closes before reading the request', mode: 'close-first' },
  { name: 'peer resets before reading the request', mode: 'reset-first' },
  { name: 'egress fetch throws before writing', extra: { throwEgress: true } },
  {
    name: 'network policy denies the target',
    patch: (o) => ({
      network: {
        ...required(o.network),
        rules: required(o.network).rules.map((r) => ({ ...r, effect: 'deny' as const })),
      },
    }),
  },
  { name: 'credential revoked before the final use', revoke: true },
]
async function runPreByte(api: Api, row: PreByte) {
  const f = await joint(api, row.mode ?? 'normal', row.patch ?? {}, true, row.extra ?? {})
  if (row.revoke)
    must(
      await f.broker.revoke(
        { secretId: required(f.options.installation).handle.secretId, reason: 'test' },
        f.auth.call({}, true),
      ),
    )
  const effect = await f.execute()
  return { f, effect }
}
describe.each(APIS)('transport failure before any byte over the %s wire', (api) => {
  it.each(PRE_BYTE)('PIN current behaviour, owner decision pending: $name', async (row) => {
    const { f, effect } = await runPreByte(api, row)
    expect(f.peerStats.bytes).toBe(0)
    expect(f.observations).toEqual([])
    expect(shape(effect)).toMatchObject({
      outcome: 'unknown_effect',
      detail: 'model_stream_unknown',
      externals: 1,
    })
    expect(stored(f)?.state).toBe('saved')
    expect(f.hashes).toHaveLength(1)
    expect((await reconcile(f)).kind).toBe('unknown')
    // Even so, no second send and no second credential use.
    const before = f.uses()
    expect((await f.execute()).outcome).not.toBe('succeeded')
    expect([f.observations.length, f.uses()]).toEqual([0, before])
  })
  it.fails.each(PRE_BYTE)(
    'EXPECTED-RED definite not-sent when the peer read zero bytes: $name',
    async (row) => {
      const { f, effect } = await runPreByte(api, row)
      expect(f.peerStats.bytes).toBe(0)
      expect(effect.outcome).toBe('failed')
      expect(effect.externalRequests).toEqual([])
    },
  )
})

/** Reference adapter: independent implementation, OpenAI-style chat completions, its own stand-in owner. */
describe('reference adapter over the openai-completions wire', () => {
  type RefMode = 'normal' | 'cut-mid' | 'cut-silent' | 'close-first' | 'reset-first' | 'hang'
  async function peer(mode: RefMode) {
    const observed: string[] = []
    const stats = { bytes: 0, connections: 0 }
    let arrived!: () => void
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      observed.push(body)
      arrived()
      if (mode === 'hang') return
      if (mode === 'cut-silent') return void request.socket.destroy()
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'joint-response' })
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
      const base = {
        id: 'joint-response',
        object: 'chat.completion.chunk',
        created: 1,
        model: JSON.parse(body).model,
      }
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'joint answer' }, finish_reason: null }],
      })
      if (mode === 'cut-mid') return void setTimeout(() => request.socket.destroy(), 20)
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })
      response.write('data: [DONE]\n\n')
      response.end()
    })
    server.on('connection', (socket) => {
      stats.connections++
      if (mode === 'close-first') return void socket.destroy()
      if (mode === 'reset-first') return void socket.resetAndDestroy()
      socket.on('data', (chunk) => {
        stats.bytes += chunk.length
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Peer did not bind')
    return {
      port: address.port,
      observed,
      stats,
      arrival,
      async close() {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }
  const roots: string[] = []
  const peers: { close(): Promise<void> }[] = []
  const stores: { close(): void }[] = []
  afterEach(async () => {
    for (const item of peers.splice(0)) await item.close()
    for (const item of stores.splice(0)) item.close()
    for (const root of roots.splice(0)) cleanup(root)
  })
  /** The reference fixture with the real Host source store behind the send fence, save and lookup. */
  async function reference(mode: RefMode | 'closed') {
    const server = await peer(mode === 'closed' ? 'normal' : mode)
    peers.push(server)
    if (mode === 'closed') await server.close()
    const root = scratch()
    roots.push(root)
    const base = await referenceModelFixture(`http://127.0.0.1:${server.port}/v1`, join(root, 'journal.json'))
    await base.action.close('shutdown')
    await base.provider.close('shutdown')
    const frame = base.frame
    const store = openModelSourceStore({
      path: join(root, 'store.sqlite'),
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
    stores.push(store)
    const hashes: string[] = []
    let credentials = 0
    const abort = new AbortController()
    // The fixture owner pins one call object; this call has its own signal so the test can cancel it.
    const mine = { ...base.context, signal: abort.signal }
    const original = <T extends { call: unknown }>(call: T) => ({ ...call, call: base.context })
    const deployment = {
      ...base.deployment,
      installed: (call: typeof mine) => call === mine && base.deployment.installed(base.context),
      current: (...args: Parameters<typeof base.deployment.current>) =>
        base.deployment.current(args[0], args[1], base.context),
      load: (
        ref: Parameters<typeof base.deployment.load>[0],
        f: typeof frame,
        call: Parameters<typeof base.deployment.load>[2],
      ) => base.deployment.load(ref, f, original(call)),
      withCredential: async <T>(...args: Parameters<typeof base.deployment.withCredential<T>>) => {
        credentials++
        return base.deployment.withCredential(args[0], args[1], original(args[2]), args[3])
      },
      beforeSend: (...args: Parameters<typeof base.deployment.beforeSend>) => {
        hashes.push(args[3])
        return (
          base.deployment.beforeSend(args[0], args[1], original(args[2]), args[3]) &&
          store.fence(args[1], args[3])
        )
      },
      save: store.deployment.save,
      lookup: store.deployment.lookup,
    }
    const provider = await createReferenceModelAdapterFactory(deployment).create(
      must(deployment.config.encode({})),
      createTestServiceContainer().dependencies,
      {
        instanceId: 'ref',
        bindingId: base.context.bindingId,
        scope: base.context.scope,
        signal: new AbortController().signal,
      },
    )
    must(await provider.ready(mine))
    const factory = required(provider.actions?.invoke)
    const action = await factory.create({
      instanceId: 'ref-leaf',
      actionId: frame.actionId,
      runId: frame.runId,
      bindingId: base.context.bindingId,
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
    if (action.kind !== 'leaf') throw new Error('Unexpected action')
    must(await action.ready(mine))
    const context = { ...base.call, call: mine }
    return {
      base,
      server,
      store,
      hashes,
      credentials: () => credentials,
      abort,
      action,
      provider,
      frame,
      execute: () => action.execute(frame, context),
      reconcile: () => action.reconcile(frame, [], context),
      read: () =>
        store.admin.read({ runId: frame.runId, actionId: frame.actionId, attemptId: frame.attemptId }),
    }
  }

  it('sends once and completes with usage; digest and identity trace to the peer request', async () => {
    const r = await reference('normal')
    const effect = await r.execute()
    expect(shape(effect)).toMatchObject({
      outcome: 'succeeded',
      text: 'joint answer',
      usage: ['measured'],
      externals: 1,
    })
    expect(r.server.observed).toHaveLength(1)
    expect(r.server.stats.connections).toBe(1)
    expect(JSON.parse(required(r.server.observed[0])).model).toBe(r.base.source.prepared.target.model)
    expect(r.hashes).toHaveLength(1)
    expect(r.read()).toMatchObject({ state: 'saved' })
    expect(effect.externalRequests[0]?.requestId).toBe(r.frame.requestIdentity?.aghRequestId)
    expect(effect.usage[0]?.externalRequest).toEqual(effect.externalRequests[0])
    const again = await r.reconcile()
    expect(again.kind).toBe('resolved')
    expect(r.server.observed).toHaveLength(1)
  })

  it('reports the digest it fenced equal to the sha256 of the body the peer read', async () => {
    const r = await reference('normal')
    await r.execute()
    expect(r.hashes).toEqual([sha(required(r.server.observed[0]))])
  })

  it.each([
    ['retired source', (r: Awaited<ReturnType<typeof reference>>) => r.base.revoke()],
    ['send rejected by the owner', (r: Awaited<ReturnType<typeof reference>>) => r.base.reject()],
    ['cancel before send', (r: Awaited<ReturnType<typeof reference>>) => r.abort.abort()],
  ] as const)('refuses %s as a definite failure before any byte', async (_name, arm) => {
    const r = await reference('normal')
    arm(r)
    const effect = await r.execute()
    expect(effect.outcome).toBe('failed')
    expect([effect.externalRequests, effect.usage]).toEqual([[], []])
    expect(r.server.stats.connections).toBe(0)
    expect(r.read()).toBeUndefined()
    if (!r.abort.signal.aborted) expect((await r.reconcile()).kind).toBe('not_found')
  })

  it.each(['cut-mid', 'cut-silent'] as const)(
    'peer %s after the request: unknown effect, no second send',
    async (mode) => {
      const r = await reference(mode)
      const effect = await r.execute()
      expect(shape(effect)).toMatchObject({ outcome: 'unknown_effect', externals: 1 })
      expect(r.read()?.state).toBe('saved')
      expect((await r.reconcile()).kind).toBe('unknown')
      expect((await r.execute()).outcome).not.toBe('succeeded')
      expect([r.server.observed.length, r.server.stats.connections]).toEqual([1, 1])
      // The reference enters its credential callback before the fence refuses; no byte follows.
      expect(r.credentials()).toBe(2)
    },
  )

  it('cancel after the request left: unknown effect, reconcile unknown, no resend', async () => {
    const r = await reference('hang')
    const job = r.execute()
    await r.server.arrival
    r.abort.abort()
    const effect = await job
    expect(effect.outcome).toBe('unknown_effect')
    expect((await r.reconcile()).kind).toBe('unknown')
    expect((await r.execute()).outcome).not.toBe('succeeded')
    expect(r.server.observed).toHaveLength(1)
  })

  it('closing the action while pending aborts it, and a closed action sends nothing', async () => {
    const r = await reference('hang')
    const job = r.execute()
    await r.server.arrival
    await r.action.close('shutdown')
    expect((await job).outcome).toBe('unknown_effect')
    expect((await r.execute()).outcome).toBe('failed')
    expect(r.server.observed).toHaveLength(1)
  })

  const preByte: [string, RefMode | 'closed' | 'throw'][] = [
    ['connection refused (closed loopback port)', 'closed'],
    ['peer closes before reading the request', 'close-first'],
    ['peer resets before reading the request', 'reset-first'],
    ['fetch throws before writing', 'throw'],
  ]
  async function runPre(mode: RefMode | 'closed' | 'throw') {
    const r = await reference(mode === 'throw' ? 'normal' : mode)
    if (mode === 'throw')
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed before any write'))
    return { r, effect: await r.execute() }
  }
  it.each(preByte)('PIN current behaviour, owner decision pending: %s', async (_name, mode) => {
    const { r, effect } = await runPre(mode)
    expect(r.server.stats.bytes).toBe(0)
    expect(r.server.observed).toEqual([])
    expect(shape(effect)).toMatchObject({ outcome: 'unknown_effect', externals: 1 })
    expect(r.read()?.state).toBe('saved')
    expect((await r.reconcile()).kind).toBe('unknown')
  })
  it.fails.each(preByte)(
    'EXPECTED-RED definite not-sent when the peer read zero bytes: %s',
    async (_name, mode) => {
      const { r, effect } = await runPre(mode)
      expect(r.server.stats.bytes).toBe(0)
      expect(effect.outcome).toBe('failed')
    },
  )

  it.each(['normal', 'cut-mid', 'cut-silent'] as const)(
    'switching from the default to the reference gives equal observable results: %s',
    async (mode) => {
      const f = await joint('openai-completions', mode)
      const mine = shape(await f.execute())
      const r = await reference(mode)
      const theirs = shape(await r.execute())
      // Error detail codes are implementation-owned; everything else observable is equal.
      expect({ ...theirs, detail: undefined }).toEqual({ ...mine, detail: undefined })
      expect(theirs.detail === undefined).toBe(mine.detail === undefined)
      expect((await r.reconcile()).kind).toBe((await reconcile(f)).kind)
      expect([r.server.observed.length, r.hashes.length]).toEqual([f.observations.length, f.hashes.length])
      expect(r.read()?.state).toBe(stored(f)?.state)
    },
  )
})
