import type { ModelRecord } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { catalogueInputs } from '../src/configuration-models.js'

type Provider = { id: string; api: string; baseUrl: string; capabilities?: unknown }
const record = (id: string, input: ModelRecord['input']) => ({ id, input }) as ModelRecord

const providers: Provider[] = [
  { id: 'vision', api: 'openai-completions', baseUrl: 'https://vision.example/v1' },
  { id: 'textual', api: 'anthropic-messages', baseUrl: 'https://textual.example' },
  { id: 'declared', api: 'openai-completions', baseUrl: 'https://declared.example/v1', capabilities: {} },
  { id: 'broken', api: 'openai-completions', baseUrl: 'https://broken.example/v1' },
]
const catalogues: Record<string, ModelRecord[]> = {
  vision: [record('shared', ['text', 'image']), record('seen', ['text', 'image'])],
  textual: [record('shared', ['text']), record('plain', ['text'])],
  declared: [record('declared-only', ['text', 'image'])],
}
const read = async (provider: Provider) => {
  if (provider.id === 'broken') throw new Error('catalogue unavailable')
  return { records: catalogues[provider.id] ?? [] }
}

it("takes the catalogue of the provider at the account's exact address and protocol", async () => {
  const inputs = await catalogueInputs(providers, read, 'openai-completions', 'https://vision.example/v1/')
  expect(Object.fromEntries(inputs)).toEqual({ shared: ['text', 'image'], seen: ['text', 'image'] })
})

it('elsewhere takes, per id, the input types every catalogue that knows it agrees on', async () => {
  const inputs = await catalogueInputs(providers, read, 'openai-completions', 'https://api.llm.sg/v1')
  expect(Object.fromEntries(inputs)).toEqual({
    // Two catalogues disagree: only what both allow.
    shared: ['text'],
    seen: ['text', 'image'],
    plain: ['text'],
  })
  // A provider whose accounts declare their own models has no catalogue to lend; an unreadable
  // catalogue is skipped; an id nobody knows is absent and keeps the text fallback.
  expect(inputs.has('declared-only')).toBe(false)
  expect(inputs.has('unknown')).toBe(false)
})
