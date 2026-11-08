/** What is known about a model id from outside the endpoint, for accounts that declare their own models. */
export type KnownModel = Readonly<{
  contextWindow: number
  maxTokens: number
  thinkingReplay: 'native'
}>

const DEEPSEEK_V4: KnownModel = Object.freeze({
  contextWindow: 1_000_000,
  maxTokens: 256_000,
  thinkingReplay: 'native',
})

/**
 * Limits and reasoning replay for the few models whose behaviour is documented: DeepSeek V4
 * flash/pro, and dated builds of V4.1 flash (`deepseek-v4.1-flash-1017`). Any other id is unknown.
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
