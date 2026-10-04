import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DomainView,
  type InteractionClientRespondRequest,
  type InteractionRecord,
  RuntimeClientTransportWire,
  type RuntimeError,
  runtimeErrorHttpStatus,
} from '@agnes/protocol/runtime'
import { memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { connectRuntime, resolvePresetId } from '../../src/runtime/session.js'

const { routes, feature } = RuntimeClientTransportWire
const routeNames = new Map<string, string>(Object.entries(routes).map(([name, route]) => [route.path, name]))
const endpoint = { baseUrl: 'http://127.0.0.1:4100/mount', bearer: 'token-1' }
const schema = { typeId: 'acme.survey/answer@1', revision: 1, digest: 'c'.repeat(64) }
const record: InteractionRecord = {
  interactionId: 'ix-1',
  owner: { runId: 'run-1', actionId: 'act-1' },
  request: {
    kind: 'question',
    title: 'Survey',
    body: 'Tell us',
    answerSchema: schema,
    fields: [{ id: 'agree', kind: 'confirm', label: 'Agree', required: true, statement: 'I agree' }],
    allowedResponders: ['user-1'],
    expiresAt: '2099-01-01T00:00:00Z',
    idempotencyKey: 'q-key',
  },
  version: 3,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  status: 'pending',
  terminationReason: null,
  resolution: null,
}
const value = { agree: true }
const answer: InteractionClientRespondRequest = {
  interactionId: 'ix-1',
  responseId: 'resp-1',
  expectedVersion: 3,
  answer: { kind: 'inline', schema, value, digest: canonicalJsonDigest(value), bytes: jcs(value).length },
}
const ready = {
  artifactId: 'art-1',
  version: 1,
  title: 'Report',
  mime: 'text/plain',
  size: 5,
  status: 'ready',
}
// Its one action needs the wire feature, which the fake runtime below does not negotiate.
const view: DomainView = {
  kind: 'domain',
  viewId: 'v-1',
  revision: 1,
  domainType: 'acme.notes',
  viewSchema: schema,
  renderKey: 'acme.notes/card',
  scope: { kind: 'workspace', installationId: 'i-1', runtimeId: 'r-1', workspaceId: 'w-1' },
  source: { eventIds: ['e-1'], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: 'Note',
  data: {},
  resources: [],
  actions: [
    {
      kind: 'interaction',
      actionKey: 'answer',
      label: 'Answer',
      interactionId: 'ix-1',
      version: 3,
      requiredFeatures: [feature],
      availability: 'enabled',
      disabledReason: null,
    },
  ],
}

const ok = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), { status: 200 })
const daemon = (preset: string) => ({ apis: async () => ({ profile: { presets: { default: preset } } }) })

/** A runtime that answers the named operations and negotiates no features; other calls get no reply. */
function runtime(handlers: Record<string, (input: unknown) => unknown>) {
  const seen: { call: string; authorization: string | null }[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const route = routeNames.get(url.slice(endpoint.baseUrl.length))
    const body = JSON.parse(String(init.body))
    const operation: string | undefined = body.call?.operation
    seen.push({
      call: operation ?? String(route),
      authorization: new Headers(init.headers).get('authorization'),
    })
    if (route === 'bootstrap') {
      const capabilities = {
        ...body.capabilities,
        features: [],
        negotiatedSession: 's-1',
        effectivePolicyRevision: 1,
      }
      const welcome = {
        negotiatedSession: 's-1',
        wireVersion: { major: RuntimeClientTransportWire.wireMajor, minor: 0 },
        catalogRevision: 1,
        capabilities,
        modules: [],
        domainSchemas: [],
        mode: 'compatible',
        reasons: [],
        clientInstanceId: capabilities.clientInstanceId,
      }
      return ok({ welcome, catalogPage: { nextCursor: null, complete: true } })
    }
    const handler = operation === undefined ? undefined : handlers[operation]
    if (!handler) throw new TypeError('connection reset')
    return ok({ header: body.header, reply: { operation, value: handler(body.call.input) } })
  })
  return { fetch, seen }
}

describe('session preset', () => {
  it('passes an explicit preset through unchanged without asking the daemon', async () => {
    const apis = vi.fn()
    expect(await resolvePresetId({ apis }, 'Team Preset')).toEqual({ ok: true, presetId: 'Team Preset' })
    expect(apis).not.toHaveBeenCalled()
  })

  it("takes the daemon profile's default preset", async () => {
    expect(await resolvePresetId(daemon('team'))).toEqual({ ok: true, presetId: 'team' })
  })

  it.each([
    ['names no default', daemon('')],
    ['cannot be read', { apis: () => Promise.reject(new Error('socket closed')) }],
  ])('is refused, never guessed, when the daemon %s', async (_case, client) => {
    const result = await resolvePresetId(client)
    expect(result).toEqual({
      ok: false,
      code: 'preset_unavailable',
      message: expect.stringContaining('--preset'),
    })
  })
})

describe('runtime connection', () => {
  const rejected: RuntimeError = {
    code: 'incompatible',
    detailCode: 'unsupported_client',
    message: 'terminal too old',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'd-1',
  }

  it.each([
    ['offers no runtime endpoint', async () => undefined, 0],
    ['refuses this terminal', async () => endpoint, 1],
  ])('is unavailable when the daemon %s', async (_case, offer, requests) => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: rejected }), {
          status: runtimeErrorHttpStatus(rejected),
        }),
    )
    const result = await connectRuntime({ endpoint: offer, journal: memoryJournal(), locale: 'en', fetch })
    expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' })
    expect(fetch).toHaveBeenCalledTimes(requests)
  })

  it('sends the bearer, recovers before anything else, and wires the ports to the runtime', async () => {
    const journal = memoryJournal()
    const first = runtime({ 'interaction.read': () => record, 'artifact.describe': () => ready })
    const one = await connectRuntime({
      endpoint: async () => endpoint,
      journal,
      locale: 'en',
      fetch: first.fetch,
    })
    if (!one.ok) throw new Error(one.message)
    expect(one.recovered).toEqual([])
    expect(await one.questions.read('ix-1')).toEqual({ state: 'ok', value: record })
    // The reply is lost, so the journaled answer outlives this client.
    expect(await one.questions.respond(answer)).toEqual({ state: 'unknown', reason: 'no reply' })
    expect(await one.questions.pendingJournal()).toEqual([
      { commandId: 'resp-1', method: 'interaction.respond', params: answer },
    ])
    expect(await one.artifacts.describe({ artifactId: 'art-1', version: 1 })).toEqual({
      state: 'ok',
      value: ready,
    })
    // Formatted with the negotiated features, not the ones this terminal asked for.
    expect(one.domain.present(view)).toMatchObject({ actions: [], needsWeb: true })
    expect(one.domain.present(view).lines).toContain(`Needs features this terminal lacks: ${feature}`)

    const second = runtime({
      'interaction.responseStatus': (responseId) => ({
        responseId,
        status: 'applied',
        interactionId: 'ix-1',
        version: 4,
        result: null,
        error: null,
      }),
    })
    const two = await connectRuntime({
      endpoint: async () => endpoint,
      journal,
      locale: 'en',
      fetch: second.fetch,
    })
    if (!two.ok) throw new Error(two.message)
    expect(second.seen.map(({ call }) => call)).toEqual(['bootstrap', 'interaction.responseStatus'])
    expect(two.recovered).toEqual([{ id: 'resp-1', operation: 'interaction.respond', state: 'accepted' }])
    expect(await two.questions.pendingJournal()).toEqual([])
    const sent = [...first.seen, ...second.seen]
    expect(sent.map(({ call }) => call)).toEqual([
      'bootstrap',
      'interaction.read',
      'interaction.respond',
      'artifact.describe',
      'bootstrap',
      'interaction.responseStatus',
    ])
    expect(new Set(sent.map(({ authorization }) => authorization))).toEqual(new Set(['Bearer token-1']))
  })
})
