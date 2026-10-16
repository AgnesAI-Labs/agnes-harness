import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import type { ApisListResult, RouteDecl } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { modelAdapterLookup } from '../src/supervisor/model-adapter-lookup.js'

const chatModel = fakeModel({ id: 'chat-1', route: 'gw' })
const jevModel = fakeModel({ id: 'jev-1', route: 'jev', api: 'typesafe-systemone', input: ['text'] })
const acmeModel = fakeModel({ id: 'acme-1', route: 'acme-route', api: 'acme-wire', input: ['text'] })
const route = (name: string, api: string, model: typeof chatModel): RouteDecl => ({
  route: name,
  api,
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [model],
})
const adapter = (id: string, capabilities: Record<string, boolean>) => ({
  id,
  version: '1.0.0',
  wireApi: `${id}-wire`,
  sourcePackage: '@acme/adapter',
  capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
})
const acmePayloadOnly = adapter('acme', { payload: true, payloadOnly: true })

/** What `apis.list` answers on a supervisor: its host is a profile, its adapters come from `lookup`. */
async function listed(
  declared: RouteDecl[],
  worker: Parameters<typeof modelAdapterLookup>[0]['worker'],
  waitMs = 2_000,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnesd-adapter-lookup-'))
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [], models: [chatModel, jevModel] }),
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          routes: [
            route('gw', 'openai-completions', chatModel),
            route('jev', 'typesafe-systemone', jevModel),
          ],
        },
      },
    },
  })
  // The routes under test are declared on the profile the supervisor serves; the lookup reads the same.
  const profile = {
    ...host.profile,
    provider: { ...host.profile.provider, routes: declared },
  }
  const served = new Proxy(host, {
    get: (target, key, receiver) => (key === 'profile' ? profile : Reflect.get(target, key, receiver)),
  })
  const ep = createLocalEndpoint(served, {
    clock: () => Date.now(),
    modelAdapters: modelAdapterLookup({ routes: () => profile.provider.routes ?? [], worker, waitMs }),
  })
  try {
    await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
        },
        _meta: { 'ai.agnes.harness': { clientId: 'lookup-test' } },
      },
    })
    const started = Date.now()
    const reply = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: ApisListResult }
    return {
      models: (reply.result.profile.models ?? []).map((model) => `${model.route}/${model.id}`),
      elapsedMs: Date.now() - started,
    }
  } finally {
    await ep.close()
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

it('answers from the built-in registrations when every route uses one, and never asks the worker', async () => {
  const worker = vi.fn(() => undefined)
  const { models } = await listed(
    [route('gw', 'openai-completions', chatModel), route('jev', 'typesafe-systemone', jevModel)],
    worker,
  )
  expect(models).toEqual(['gw/chat-1'])
  expect(worker).not.toHaveBeenCalled()
})

it('lists a community route unfiltered, and promptly, while the worker is not running', async () => {
  const worker = vi.fn(() => undefined)
  const { models, elapsedMs } = await listed(
    [route('gw', 'openai-completions', chatModel), route('acme-route', 'acme', acmeModel)],
    worker,
  )
  expect(models).toEqual(['gw/chat-1', 'acme-route/acme-1'])
  expect(worker).toHaveBeenCalled()
  expect(elapsedMs).toBeLessThan(1_000)
})

it('leaves a community payload-only route out once the running worker reports its adapters', async () => {
  const command = vi.fn(async () => ({ modelAdapters: [acmePayloadOnly] }))
  const { models } = await listed(
    [route('gw', 'openai-completions', chatModel), route('acme-route', 'acme', acmeModel)],
    () => ({ command }) as never,
  )
  expect(models).toEqual(['gw/chat-1'])
  expect(command).toHaveBeenCalledWith('session.catalog', {}, expect.objectContaining({ timeoutMs: 2_000 }))
}, 10_000)

it('does not wait for a worker that does not answer', async () => {
  const command = vi.fn(() => new Promise<never>(() => undefined))
  const { models, elapsedMs } = await listed(
    [route('gw', 'openai-completions', chatModel), route('acme-route', 'acme', acmeModel)],
    () => ({ command }) as never,
    50,
  )
  expect(models).toEqual(['gw/chat-1', 'acme-route/acme-1'])
  expect(elapsedMs).toBeLessThan(1_000)
})

it('keeps the last adapters it read when the worker later fails to answer', async () => {
  let answer: () => Promise<unknown> = async () => ({ modelAdapters: [acmePayloadOnly] })
  const lookup = modelAdapterLookup({
    routes: () => [{ api: 'acme' }],
    worker: () => ({ command: () => answer() }) as never,
    waitMs: 50,
  })
  expect((await lookup()).map((entry) => entry.id)).toContain('acme')
  answer = () => new Promise<never>(() => undefined)
  expect((await lookup()).map((entry) => entry.id)).toContain('acme')
  answer = async () => {
    throw new Error('worker closed')
  }
  expect((await lookup()).map((entry) => entry.id)).toContain('acme')
})
