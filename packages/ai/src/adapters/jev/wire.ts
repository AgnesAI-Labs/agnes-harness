import type { DecisionWireAnswer, DecisionWireRequest } from '@agnes/protocol'
import { type DecisionAdapterAnswer, DecisionAdapterError } from '../../adapter.js'

export const JEV_APIS = ['typesafe-systemone', 'openrouter-decisions'] as const
export type JevApi = (typeof JEV_APIS)[number]

/** Far above any answer set the request limits allow, and small enough to hold in memory. */
export const MAX_RESPONSE_BYTES = 1024 * 1024

export function endpointFor(api: JevApi, baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${api === 'typesafe-systemone' ? 'systemone' : 'decisions'}`
  url.hash = ''
  return url
}

/**
 * The documented request body. Question ids travel as map keys, which the model never sees; the
 * route, slot and time limit are this side's business and are not sent.
 */
export function requestBody(req: DecisionWireRequest): string {
  return JSON.stringify({ model: req.model, state: req.state, questions: req.questions })
}

/**
 * Reads at most `max` bytes. Going over, or bytes that are not UTF-8, is a malformed answer; a read
 * that fails part way is left to the caller to classify, because only it knows whether the call was
 * aborted.
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new DecisionAdapterError('FORMAT')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DecisionAdapterError('FORMAT')
  }
}

const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/**
 * Checks the envelope and nothing inside the answers. Extra fields, sums that miss one, reordered
 * keys and numbers spelled as strings are all handed on exactly as parsed: judging them is the
 * caller's validator's job, and a layer that quietly repaired them would hide a vendor fault from
 * the one check that fails closed.
 */
export function parseResponse(text: string, api: JevApi): DecisionAdapterAnswer {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new DecisionAdapterError('FORMAT')
  }
  if (!plain(body)) throw new DecisionAdapterError('FORMAT')
  const { model, answers, usage } = body
  if (typeof model !== 'string' || model.length === 0 || model.length > 256)
    throw new DecisionAdapterError('FORMAT')
  if (!plain(answers) || !Object.values(answers).every(plain)) throw new DecisionAdapterError('FORMAT')
  if (!plain(usage) || !count(usage.input_tokens) || !count(usage.output_tokens))
    throw new DecisionAdapterError('FORMAT')
  const cost = usage.cost
  // Only the reseller reports a price; a cost field on the direct route is not the vendor's to send.
  const costUsd =
    api === 'openrouter-decisions' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? cost
      : undefined
  return {
    answers: answers as Record<string, DecisionWireAnswer>,
    model,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  }
}
