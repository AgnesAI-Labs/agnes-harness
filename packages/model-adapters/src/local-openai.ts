import { PiAdapter, type ManualRoute } from '@agnes/ai'
import type { ModelAdapterConfig, ModelAdapterInstance } from '@agnes/extension-api'
import { defineModelAdapter } from '@agnes/plugin-runtime'
import { validateModelRecord, type ModelRecord } from '@agnes/protocol'
import { absoluteFile, compat, object, recordModelResponses } from './trace.js'

function endpoint(baseUrl: string): URL {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(
      'local model endpoint must be an absolute HTTP URL without credentials, query or fragment',
    )
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url
}
/** Explicit /v1/models discovery. Never contacts a vendor fallback or infers capabilities. */
export async function discoverLocalModels(options: {
  baseUrl: string
  credential?: string
  signal?: AbortSignal
  request?: typeof globalThis.fetch
}): Promise<readonly string[]> {
  const url = endpoint(options.baseUrl)
  url.pathname += '/models'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.credential !== undefined) {
    if (!options.credential.trim()) throw new Error('empty discovery credential')
    headers.Authorization = `Bearer ${options.credential}`
  }
  const timeout = AbortSignal.timeout(5000)
  const response = await (options.request ?? fetch)(url, {
    redirect: 'error',
    headers,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  })
  const limit = 1024 * 1024
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > limit ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel()
    throw new Error('local model discovery failed')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new Error('local model catalog exceeds 1 MiB')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  const body: unknown = JSON.parse(text)
  if (!object(body) || !Array.isArray(body.data) || body.data.length > 4096)
    throw new Error('invalid local model catalog')
  const ids = body.data.map((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || !/^[^\p{Cc}\p{Z}\s]{1,256}$/u.test(item.id))
      throw new Error('invalid local model id')
    return item.id
  })
  if (new Set(ids).size !== ids.length) throw new Error('duplicate local model ids')
  return Object.freeze(ids)
}

/** pi-ai owns inference serialization, streaming, tools and multimodal handling. */
export const localOpenAIAdapter = defineModelAdapter({
  id: 'local-openai',
  api: 'openai-completions',
  version: '1.0.0',
  capabilities: { imageInput: true, tools: true, streaming: true },
  async create(config: ModelAdapterConfig): Promise<ModelAdapterInstance> {
    const routes: ManualRoute[] = []
    let recordFile: string | undefined
    for (const declared of config.routes) {
      const options = compat(declared.compat)
      const baseUrl = endpoint(declared.baseUrl).href.replace(/\/$/, '')
      if (options.keyless !== undefined && typeof options.keyless !== 'boolean')
        throw new Error('keyless must be a boolean')
      if (options.keyless === true && declared.credentialRef !== undefined)
        throw new Error('keyless route cannot name a credential')
      if (options.discover !== undefined && typeof options.discover !== 'boolean')
        throw new Error('discover must be a boolean')
      let models = declared.models
      if (options.discover === true) {
        if (options.keyless !== true)
          throw new Error(
            'automatic discovery requires explicit keyless; authenticated discovery uses discoverLocalModels',
          )
        if (!object(options.modelDefaults))
          throw new Error('discovery requires explicit modelDefaults (contextWindow and maxTokens)')
        const defaults = options.modelDefaults
        models = (await discoverLocalModels({ baseUrl })).map((id): ModelRecord => {
          const model = {
            id,
            name: id,
            route: declared.route,
            baseUrl,
            api: 'openai-completions',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            toolCallFormats: ['native'],
            thinkingReplay: 'drop',
            contract_id: null,
            ...defaults,
          }
          if (!validateModelRecord(model).ok) throw new Error('invalid discovered model defaults')
          // Discovery ids and configured destination cannot be overwritten by defaults.
          return {
            ...model,
            id,
            name: id,
            route: declared.route,
            baseUrl,
            api: 'openai-completions',
          } as ModelRecord
        })
      }
      if (!models.length) throw new Error('local route needs explicit models or discovery')
      routes.push({
        ...declared,
        api: 'openai-completions',
        baseUrl,
        models,
        keyless: options.keyless === true,
        ...(options.wireCompat !== undefined
          ? { compat: options.wireCompat as Exclude<ManualRoute['compat'], undefined> }
          : {}),
      })
      if (options.recordFile !== undefined) {
        const file = absoluteFile(options.recordFile)
        if (recordFile && recordFile !== file)
          throw new Error('one local adapter instance uses one recordFile')
        recordFile = file
      }
    }
    const pi = new PiAdapter({ id: 'local-openai', manualRoutes: routes })
    const instance: ModelAdapterInstance = {
      id: pi.id,
      routes: () =>
        routes.map(({ models: _models, keyless: _keyless, ...route }) => ({ ...route, api: 'local-openai' })),
      models: (route) => pi.models(route),
      stream: (route, request, options) => pi.stream(route, request, options),
      bindCredential: (route, value) => pi.bindCredential(route, value),
      probe: (route, signal) => pi.probe(route, signal),
    }
    return recordFile ? recordModelResponses(instance, recordFile) : instance
  },
})
