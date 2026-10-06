import {
  type ClientJsonOperation,
  RuntimeClientTransportWire,
  type RuntimeConversationWindow,
  type RuntimeError,
  runtimeErrorHttpStatus,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { createRuntimeClient, RuntimeClientTransport, runtimeJournalKey } from '@agnes/sdk/runtime'
import { describe, expect, it } from 'vitest'
import { memoryJournal } from '../../src/journal.js'

// The narrow conversation surface of the runtime client against a wire peer that serves the
// conversation reads only, as the daemon does until a backend owns create, submit, cancel and status.

const { routes } = RuntimeClientTransportWire
const SESSION = 'session-1'
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
const failure = (detailCode: string, code: RuntimeError['code']): RuntimeError => ({
  code,
  detailCode,
  message: detailCode,
  retryAdvice: { kind: 'never' },
  diagnosticId: 'diag-1',
})

/** A window of user nodes `ids` at `revision`; `next` names the page before it. */
function window(ids: string[], revision: number, next: string | null = null): RuntimeConversationWindow {
  const nodes = ids.map((id, index) => ({
    kind: 'user' as const,
    id,
    seq: index + 1,
    content: [{ type: 'text' as const, text: id }],
  }))
  const value: RuntimeConversationWindow = {
    sessionId: SESSION,
    epoch: 'epoch-1',
    revision,
    native: {
      timeline: { sessionId: SESSION, upto: nodes.length, generation: 1, opState: null, nodes, turns: [] },
      history: { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
    },
    domains: [],
    order: ids.map((id) => ({ kind: 'native' as const, id })),
    orderCursor: `order-${revision}`,
    nextPageCursor: next,
    complete: next === null,
  }
  expect(validateRuntime('RuntimeConversationWindow', value).ok).toBe(true)
  return value
}

/** A fetch-level peer: bootstrap, the served operations, and one conversation subscription. */
function peer(options: {
  mode?: 'compatible' | 'reload-required'
  serve?: Partial<Record<ClientJsonOperation, (input: unknown) => unknown>>
  frames?: unknown[]
}) {
  const sent: { route: string; body: Record<string, unknown> }[] = []
  const answer = (outcome: { ok: true; value: unknown } | { ok: false; error: RuntimeError }) =>
    new Response(JSON.stringify(outcome), {
      status: outcome.ok ? 200 : runtimeErrorHttpStatus(outcome.error),
      headers: { 'content-type': 'application/json' },
    })
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const route = Object.entries(routes).find(([, entry]) => entry.path === path)?.[0] ?? path
    const body = JSON.parse(String(init.body)) as Record<string, unknown> & { header: unknown }
    sent.push({ route, body })
    if (route === 'bootstrap') {
      const welcome = {
        negotiatedSession: 's1',
        wireVersion: { major: 2, minor: 0 },
        catalogRevision: 1,
        capabilities: { ...capabilities, negotiatedSession: 's1', effectivePolicyRevision: 1 },
        modules: [],
        domainSchemas: [],
        mode: options.mode ?? 'compatible',
        reasons: [],
        clientInstanceId: 'ci-1',
      }
      return answer({ ok: true, value: { welcome, catalogPage: { nextCursor: null, complete: true } } })
    }
    if (route === 'clientQuery' || route === 'clientCommand') {
      const call = body.call as { operation: ClientJsonOperation; input: unknown }
      const serve = options.serve?.[call.operation]
      if (!serve) return answer({ ok: false, error: failure('operation_not_supported', 'incompatible') })
      const value = { header: body.header, reply: { operation: call.operation, value: serve(call.input) } }
      return answer({ ok: true, value })
    }
    if (route === 'subscribe') {
      const frame = {
        subscriptionId: 'sub-1',
        topic: 'conversation',
        kind: 'snapshot',
        cursor: 'f0',
        payload: { page: window(['n1'], 1), nextCursor: null, complete: true },
      }
      const value = {
        header: body.header,
        subscriptionId: 'sub-1',
        topic: 'conversation',
        cursor: 'f0',
        frame,
      }
      return answer({ ok: true, value })
    }
    if (route === 'readSubscription') {
      const frames = options.frames ?? []
      return answer({ ok: true, value: { header: body.header, frames, nextCursor: null, hasMore: false } })
    }
    return answer({ ok: false, error: failure('operation_not_supported', 'incompatible') })
  }
  return { fetch, sent, count: (route: string) => sent.filter((entry) => entry.route === route).length }
}

async function client(p: ReturnType<typeof peer>) {
  const journal = memoryJournal('client-1')
  const transport = new RuntimeClientTransport({
    baseUrl: 'http://127.0.0.1:4177',
    hello: { capabilities, authorApi: [], loadedBundles: [] },
    journal,
    journalPartitionKey: 'partition-1',
    fetch: p.fetch,
  })
  await transport.connect()
  return { rt: createRuntimeClient(transport, { pollIntervalMs: 1 }), journal }
}
const pending = async (journal: ReturnType<typeof memoryJournal>) =>
  (await journal.pending(runtimeJournalKey('partition-1'))).map((entry) => entry.commandId)
const prompt = (requestId: string, kind: 'prompt' | 'follow-up' = 'prompt') => ({
  sessionId: SESSION,
  kind,
  content: [{ type: 'text' as const, text: 'hello' }],
  requestId,
  expectedGeneration: 1,
})

describe('the shell conversation client', () => {
  it('opens a window and reads earlier history by the page cursor the window names', async () => {
    const live = window(['n3', 'n4'], 4, 'page-2')
    const earlier = window(['n1', 'n2'], 4)
    const p = peer({ serve: { 'conversation.open': () => live, 'conversation.history': () => earlier } })
    const { rt } = await client(p)
    const opened = await rt.conversations.open({ sessionId: SESSION, limit: 2 })
    expect(opened).toEqual({ state: 'ok', value: live })
    if (opened.state !== 'ok' || opened.value.nextPageCursor === null) throw new Error('no earlier page')
    const cursor = opened.value.nextPageCursor
    expect(await rt.conversations.history({ sessionId: SESSION, cursor, limit: 2 })).toEqual({
      state: 'ok',
      value: earlier,
    })
    expect(p.sent.filter((entry) => entry.route === 'clientQuery').map((entry) => entry.body.call)).toEqual([
      { operation: 'conversation.open', input: { sessionId: SESSION, limit: 2 } },
      { operation: 'conversation.history', input: { sessionId: SESSION, cursor: 'page-2', limit: 2 } },
    ])
  })

  it('refuses create, submit, cancel and status as not supported while no backend serves them', async () => {
    const p = peer({})
    const { rt, journal } = await client(p)
    const unserved = {
      state: 'failed',
      error: { code: 'incompatible', detailCode: 'operation_not_supported' },
    }
    expect(
      await rt.conversations.create({ workspaceId: 'ws-1', presetId: 'p-1', requestId: 'req-1' }),
    ).toMatchObject(unserved)
    expect(await rt.conversations.submit(prompt('req-2'))).toMatchObject(unserved)
    expect(
      await rt.conversations.cancel({ sessionId: SESSION, runId: 'run-1', requestId: 'req-3' }),
    ).toMatchObject(unserved)
    expect(await rt.conversations.status('req-2')).toMatchObject(unserved)
    // Each left exactly once, and a typed refusal admitted nothing, so no command stays pending.
    expect(p.count('clientCommand')).toBe(3)
    expect(p.count('clientQuery')).toBe(1)
    expect(await pending(journal)).toEqual([])
  })

  it('keeps one input per request id: a follow-up under an unsettled prompt id never leaves', async () => {
    const p = peer({ serve: { 'conversation.submit': () => 'not a command handle' } })
    const { rt, journal } = await client(p)
    expect(await rt.conversations.submit(prompt('req-1'))).toMatchObject({ state: 'unknown' })
    expect(await pending(journal)).toEqual(['req-1'])
    expect(await rt.conversations.submit(prompt('req-1', 'follow-up'))).toEqual({
      state: 'refused',
      reason: 'identity-conflict',
    })
    expect(p.count('clientCommand')).toBe(1)
  })

  it('reads the window but sends no conversation command while the server asks for a reload', async () => {
    const p = peer({ mode: 'reload-required', serve: { 'conversation.open': () => window(['n1'], 1) } })
    const { rt, journal } = await client(p)
    expect(await rt.conversations.open({ sessionId: SESSION, limit: 1 })).toMatchObject({ state: 'ok' })
    expect(await rt.conversations.submit(prompt('req-1'))).toEqual({
      state: 'refused',
      reason: 'reload-required',
    })
    expect(p.count('clientCommand')).toBe(0)
    expect(await pending(journal)).toEqual([])
  })

  it('delivers conversation changes in order and unmerged, leaving the base cursor to the merge owner', async () => {
    const change = (baseOrderCursor: string, revision: number, cursor: string) => ({
      subscriptionId: 'sub-1',
      topic: 'conversation',
      kind: 'change',
      cursor,
      payload: { kind: 'replace', baseOrderCursor, window: window(['n1', `n${revision}`], revision) },
    })
    const frames = [
      change('order-1', 2, 'f1'),
      change('order-9', 3, 'f2'),
      { ...change('order-2', 4, 'f3'), kind: 'end', payload: { reason: 'done' } },
    ]
    const { rt } = await client(peer({ frames }))
    const subscribed = await rt.subscribe({ topic: 'conversation', input: { sessionId: SESSION, limit: 2 } })
    if (subscribed.state !== 'ok') throw new Error(`not subscribed: ${subscribed.state}`)
    const seen = []
    for await (const frame of subscribed.value.frames) seen.push(frame)
    expect(seen).toEqual(frames)
    expect(await subscribed.value.ended).toEqual({ reason: 'end' })
  })
})
