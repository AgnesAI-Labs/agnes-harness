import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { EffectResult } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createReferenceModelAdapterFactory,
  type ReferenceModelApi,
  type ReferenceModelDeployment,
  type ReferenceModelSource,
} from '../../src/providers/model-adapter.js'
import { referenceModelFixture } from './reference-model-fixture.js'

const APIS = ['openai-completions', 'anthropic-messages'] as const

const sse = (events: { event?: string; data: unknown }[], status = 200) =>
  new Response(
    events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join(''),
    { status, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'unit-response' } },
  )
const openai = (
  reason: string | null = 'stop',
  usage: unknown = { prompt_tokens: 7, completion_tokens: 3 },
) => [
  { data: { model: 'wire-model', choices: [{ delta: { content: 'unit answer' }, finish_reason: null }] } },
  { data: { model: 'wire-model', choices: [{ delta: {}, finish_reason: reason }], usage } },
]
const anthropic = (reason: string | null = 'end_turn', extra: { event?: string; data: unknown }[] = []) => [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { model: 'wire-model', usage: { input_tokens: 7, output_tokens: 0 } },
    },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unit answer' } },
  },
  ...extra,
  ...(reason === null
    ? []
    : [
        {
          event: 'message_delta',
          data: { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
]
const stream = (api: ReferenceModelApi, reason?: string | null) =>
  sse(
    api === 'anthropic-messages'
      ? anthropic(reason === undefined ? 'end_turn' : reason)
      : reason === null
        ? openai(null, undefined).slice(0, 1)
        : openai(reason ?? 'stop'),
  )

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type Options = {
  egress?: typeof fetch | false
  /** Asking the host for the egress throws. */
  egressThrows?: boolean
  api?: ReferenceModelApi
  source?: (base: ReferenceModelSource) => Partial<ReferenceModelSource>
  refuseSend?: boolean
}
async function run(options: Options = {}) {
  const api = options.api ?? 'openai-completions'
  const directory = mkdtempSync(join(tmpdir(), 'reference-wire-'))
  directories.push(directory)
  const fixture = await referenceModelFixture('http://127.0.0.1:1/v1', join(directory, 'receipt.json'), {
    api,
    egress: false,
  })
  const source: ReferenceModelSource = { ...fixture.source, ...options.source?.(fixture.source) }
  const calls = { credential: 0, beforeSend: 0, egress: 0 }
  const requests: Request[] = []
  const seam = options.egress
  const deployment: ReferenceModelDeployment = {
    ...fixture.deployment,
    ...(seam === false
      ? {}
      : {
          egress: () => {
            calls.egress++
            if (options.egressThrows) throw new Error('no egress')
            return async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init)
              requests.push(request)
              return typeof seam === 'function' ? seam(input, init) : stream(api)
            }
          },
        }),
    async load(...args: Parameters<typeof fixture.deployment.load>) {
      const loaded = await fixture.deployment.load(...args)
      return loaded.ok ? { ok: true as const, value: source } : loaded
    },
    current: (_s, f, c) => fixture.deployment.current(fixture.source, f, c),
    withCredential: (...args) => {
      calls.credential++
      return fixture.deployment.withCredential(...args)
    },
    beforeSend: (...args) => {
      calls.beforeSend++
      return !options.refuseSend && fixture.deployment.beforeSend(...args)
    },
  }
  const config = deployment.config.encode({})
  if (!config.ok) throw new Error('config')
  const provider = await createReferenceModelAdapterFactory(deployment).create(
    config.value,
    createTestServiceContainer().dependencies,
    {
      instanceId: 'wire-instance',
      scope: fixture.context.scope,
      bindingId: fixture.context.bindingId,
      signal: new AbortController().signal,
    },
  )
  if (!(await provider.ready(fixture.context)).ok) throw new Error('provider')
  const action = await provider.actions?.invoke?.create({
    instanceId: 'leaf',
    actionId: fixture.frame.actionId,
    runId: fixture.frame.runId,
    bindingId: fixture.context.bindingId,
    scope: {
      ...fixture.context.scope,
      kind: 'action',
      workspaceId: 'workspace',
      sessionId: 'session',
      runId: 'run',
      actionId: 'action',
    },
    signal: new AbortController().signal,
  })
  if (action?.kind !== 'leaf') throw new Error('leaf')
  if (!(await action.ready(fixture.context)).ok) throw new Error('action')
  const result = await action.execute(fixture.frame, fixture.call)
  await provider.close('shutdown')
  return { result, calls, requests, source }
}
const output = (effect: EffectResult) =>
  effect.result?.kind === 'inline' ? (effect.result.value as Record<string, unknown>) : null
const text = (effect: EffectResult) =>
  (output(effect)?.outputRef as { value: { content: { text: string }[] } } | undefined)?.value.content[0]
    ?.text
const quantities = (effect: EffectResult) =>
  effect.usage.flatMap((fact) =>
    fact.dimensions.kind === 'inline'
      ? (fact.dimensions.value as { quantities: { value: string }[] }).quantities.map((q) => q.value)
      : [],
  )

describe.each(APIS)('reference model adapter over the %s wire', (api) => {
  it('sends once through the injected egress and never the ambient fetch', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch')
    const { result, calls, requests, source } = await run({ api })
    expect(ambient).not.toHaveBeenCalled()
    expect(result.outcome).toBe('succeeded')
    expect([calls.egress, requests.length, calls.beforeSend]).toEqual([1, 1, 1])
    const request = requests[0] as Request
    expect(request.url).toBe(source.endpoint)
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('error')
    expect(JSON.parse(await request.text())).toEqual(source.body)
    expect(text(result)).toBe('unit answer')
    expect(output(result)?.finishReason).toBe('stop')
    expect(output(result)?.actualModel).toBe('wire-model')
    expect(quantities(result)).toEqual(['7', '3'])
    expect(result.usage.map((fact) => fact.certainty)).toEqual(['measured'])
  })

  it('carries the credential only in the header of its wire', async () => {
    const { requests } = await run({ api })
    const headers = (requests[0] as Request).headers
    if (api === 'anthropic-messages') {
      expect(headers.get('x-api-key')).toBe('fixture-wire')
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
      expect(headers.has('authorization')).toBe(false)
    } else {
      expect(headers.get('authorization')).toBe('Bearer fixture-wire')
      expect(headers.has('x-api-key')).toBe(false)
    }
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('refuses before the credential owner, the fence and any byte when no egress is injected', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch')
    const { result, calls } = await run({ api, egress: false })
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'denied', detailCode: 'reference_model_egress_missing' },
      externalRequests: [],
      usage: [],
    })
    expect(calls).toEqual({ credential: 0, beforeSend: 0, egress: 0 })
    expect(ambient).not.toHaveBeenCalled()
  })

  it('refuses the same way when asking for the egress throws', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch')
    const { result, calls } = await run({ api, egressThrows: true })
    expect(result.error?.detailCode).toBe('reference_model_egress_missing')
    expect([calls.credential, calls.beforeSend]).toEqual([0, 0])
    expect(ambient).not.toHaveBeenCalled()
  })

  it('a send the fence refuses never reaches the egress fetch', async () => {
    const ambient = vi.spyOn(globalThis, 'fetch')
    const { result, requests, calls } = await run({ api, refuseSend: true })
    expect(result).toMatchObject({ outcome: 'failed', externalRequests: [], usage: [] })
    expect(calls.beforeSend).toBe(1)
    expect(requests).toEqual([])
    expect(ambient).not.toHaveBeenCalled()
  })

  it('maps a length stop and treats a tool-use stop as an unfinished effect', async () => {
    const length = await run({
      api,
      egress: async () => stream(api, api === 'anthropic-messages' ? 'max_tokens' : 'length'),
    })
    expect(output(length.result)?.finishReason).toBe('length')
    const tools = await run({
      api,
      egress: async () => stream(api, api === 'anthropic-messages' ? 'tool_use' : 'tool_calls'),
    })
    expect(tools.result).toMatchObject({ outcome: 'unknown_effect' })
    expect(tools.result.externalRequests).toHaveLength(1)
  })

  it('a stream cut before any stop reason is an unknown effect', async () => {
    const { result } = await run({ api, egress: async () => stream(api, null) })
    expect(result).toMatchObject({ outcome: 'unknown_effect' })
    expect(result.externalRequests).toHaveLength(1)
  })

  it('an egress that throws after the fence leaves an unknown effect', async () => {
    const { result } = await run({
      api,
      egress: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(result).toMatchObject({ outcome: 'unknown_effect' })
    expect(result.externalRequests).toHaveLength(1)
  })

  it('a non-success status is reported as an error finish, never as a clean stop', async () => {
    const { result } = await run({ api, egress: async () => new Response('nope', { status: 500 }) })
    expect(output(result)?.finishReason).toBe('error')
  })
})

describe('reference model adapter anthropic specifics', () => {
  it('takes input tokens from the start event and output tokens from the closing delta', async () => {
    const { result } = await run({ api: 'anthropic-messages' })
    expect(quantities(result)).toEqual(['7', '3'])
  })

  it('an in-stream error event leaves an unknown effect', async () => {
    const { result } = await run({
      api: 'anthropic-messages',
      egress: async () =>
        sse(
          anthropic(null, [{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error' } } }]),
        ),
    })
    expect(result.outcome).toBe('unknown_effect')
  })

  it('checks max_tokens, not the chat-completions limit, against the prepared output limit', async () => {
    const { result, calls } = await run({
      api: 'anthropic-messages',
      source: () => ({
        body: {
          model: 'fixture-model',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          max_tokens: 31,
          stream: true,
        },
      }),
    })
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'invalid_input' } })
    expect([calls.egress, calls.credential, calls.beforeSend]).toEqual([0, 0, 0])
  })
})

describe('reference model adapter refusals', () => {
  it('refuses an unsupported wire by name before the egress, the credential owner and the fence', async () => {
    const { result, calls } = await run({ source: () => ({ api: 'openai-responses' as never }) })
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'invalid_input', detailCode: 'reference_model_api' },
    })
    expect(calls).toEqual({ credential: 0, beforeSend: 0, egress: 0 })
  })

  it.each([
    ['a structured output schema', { outputSchema: { typeId: 't', revision: 1, digest: 'd'.repeat(64) } }],
    ['a tool catalog', { toolCatalog: { items: [] } }],
  ] as const)('refuses %s as invalid input before any send', async (_name, patch) => {
    const { result, calls } = await run({
      source: (base) => ({ prepared: { ...base.prepared, ...patch } as never }),
    })
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'invalid_input' } })
    expect([calls.egress, calls.credential, calls.beforeSend]).toEqual([0, 0, 0])
  })
})

describe('reference model adapter independence', () => {
  const file = new URL('../../src/providers/model-adapter.ts', import.meta.url)
  const code = readFileSync(file, 'utf8')
  it('imports nothing from the default adapter stack', () => {
    expect(code).not.toMatch(/@agnes\/ai|packages\/ai|@earendil-works|@anthropic-ai|from 'openai'/)
  })
  it('has no ambient fetch call; the only transport is the injected egress', () => {
    expect(code).not.toMatch(/(?<![.\w])fetch\(/)
    expect(code).not.toMatch(/globalThis\.fetch/)
  })
})
