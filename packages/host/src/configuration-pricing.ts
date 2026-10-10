import { type ModelPricePolicy, validModelPricePolicy } from '@agnes/protocol'

const FIELDS = {
  inputUncached: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
} as const
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const endpoint = (baseUrl: string) => `${baseUrl.replace(/\/$/, '')}/model/info`

/** Only sanitized, exact-model policies from this account's metadata survive reload. */
export function normalizeModelPricePolicies(
  value: unknown,
  ids: readonly string[],
  baseUrl: string,
): Record<string, ModelPricePolicy> | undefined {
  if (!object(value) || Object.keys(value).length > 4096) return
  if (
    Object.entries(value).some(
      ([id, policy]) =>
        !ids.includes(id) ||
        !validModelPricePolicy(policy) ||
        policy.currency !== 'USD' ||
        policy.source?.url !== endpoint(baseUrl),
    )
  )
    return
  return structuredClone(value) as Record<string, ModelPricePolicy>
}

/** LiteLLM model_info rates are USD/token; other pricing schemes stay unknown. */
export function modelPricePolicies(
  value: unknown,
  ids: readonly string[],
  url: string,
  checkedAt: string,
): Record<string, ModelPricePolicy> {
  if (!object(value) || !Array.isArray(value.data) || value.data.length > 4096) return {}
  const allowed = new Set(ids)
  const policies = new Map<string, ModelPricePolicy>()
  const rejected = new Set<string>()
  for (const row of value.data) {
    if (!object(row) || typeof row.model_name !== 'string' || !allowed.has(row.model_name)) continue
    const id = row.model_name
    const info = row.model_info
    if (
      !object(info) ||
      Object.entries(info).some(
        ([key, rate]) =>
          rate != null &&
          !Object.values(FIELDS).includes(key as (typeof FIELDS)[keyof typeof FIELDS]) &&
          /(?:cost|price|pricing|peak|currency|unit|tier|discount|schedule)/iu.test(key),
      )
    ) {
      rejected.add(id)
      continue
    }
    const perMillion: ModelPricePolicy['perMillion'] = {}
    let known = false
    let invalid = false
    for (const [bucket, field] of Object.entries(FIELDS)) {
      const rate = info[field]
      if (rate != null && (!finite(rate) || !finite(rate * 1_000_000))) invalid = true
      const amount = finite(rate) ? rate * 1_000_000 : null
      if (amount !== null) known = true
      perMillion[bucket as keyof typeof FIELDS] = amount
    }
    const policy: ModelPricePolicy = {
      currency: 'USD',
      unit: 'per-million-tokens',
      perMillion,
      source: { url, checkedAt },
    }
    if (
      invalid ||
      !known ||
      !validModelPricePolicy(policy) ||
      (policies.has(id) && JSON.stringify(policies.get(id)) !== JSON.stringify(policy))
    )
      rejected.add(id)
    else policies.set(id, policy)
  }
  return Object.fromEntries([...policies].filter(([id]) => !rejected.has(id)))
}

/** Optional authenticated GET on the verified base only; never redirects or blocks saving indefinitely. */
export async function fetchModelPricePolicies(options: {
  baseUrl: string
  apiKey: string
  ids: readonly string[]
  request: typeof fetch
}): Promise<Record<string, ModelPricePolicy>> {
  let url: URL
  try {
    url = new URL(endpoint(options.baseUrl))
  } catch {
    return {}
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return {}
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const load = async () => {
    const response = await options.request(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${options.apiKey}` },
    })
    if (
      controller.signal.aborted ||
      !response.ok ||
      !response.body ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > 1024 * 1024
    ) {
      void response.body?.cancel().catch(() => undefined)
      return {}
    }
    const reader = response.body.getReader()
    const cancel = () => {
      void reader.cancel().catch(() => undefined)
    }
    controller.signal.addEventListener('abort', cancel, { once: true })
    let bytes = 0
    let text = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 1024 * 1024) {
          await reader.cancel()
          return {}
        }
        text += decoder.decode(next.value, { stream: true })
      }
      text += decoder.decode()
      if (controller.signal.aborted) return {}
      return modelPricePolicies(
        JSON.parse(text),
        options.ids,
        url.href,
        new Date().toISOString().slice(0, 10),
      )
    } catch {
      void reader.cancel().catch(() => undefined)
      return {}
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }
  try {
    return await Promise.race([
      load(),
      new Promise<Record<string, ModelPricePolicy>>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve({})
        }, 5000)
      }),
    ])
  } catch {
    return {}
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    controller.abort()
  }
}
