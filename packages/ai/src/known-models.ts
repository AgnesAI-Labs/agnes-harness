/** What is known about a model id from outside the endpoint, for accounts that declare their own models. */
export type KnownModel = Readonly<{
  contextWindow: number
  maxTokens: number
  thinkingReplay: 'native'
}>

// The window and the output cap are DeepSeek Harness's defaults for its DeepSeek provider (1e6 and
// 256e3), kept so both harnesses send the same cap. They are not DeepSeek's stated maximum: its model
// page (api-docs.deepseek.com/quick_start/pricing, read 2026-11-12) lists 1M context and a 384K maximum
// output, so 256,000 stays below the vendor's limit. Nothing updates this table; whoever runs a new
// model through an endpoint that needs it adds the entry.
const DEEPSEEK_V4: KnownModel = Object.freeze({
  contextWindow: 1_000_000,
  maxTokens: 256_000,
  thinkingReplay: 'native',
})

/**
 * Limits and reasoning replay for the few models this table covers: DeepSeek V4 flash/pro, and dated
 * builds of V4.1 flash (`deepseek-v4.1-flash-1017`). Matching is by exact id (V4.1 flash also by its
 * dated prefix), so any other id, including a vendor-prefixed spelling of these, is unknown.
 */
export function knownModel(id: string): KnownModel | undefined {
  if (
    id === 'deepseek-v4.1-flash' ||
    id.startsWith('deepseek-v4.1-flash-') ||
    id === 'deepseek-v4-flash' ||
    id === 'deepseek-v4-pro'
  )
    return DEEPSEEK_V4
  return undefined
}
