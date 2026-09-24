import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { canonicalJson, sha256Hex } from '../../src/request/hash.js'

export type Script = InferenceEvent[]
export type FakeProvider = Provider & { calls: number; requests: RequestBody[] }

const HASH = 'a'.repeat(64)

export const sentFor = (
  req: RequestBody,
  event: Extract<InferenceEvent, { type: 'sent' }> = sent(),
  parserVersion = event.stamp.parser_version,
): Extract<InferenceEvent, { type: 'sent' }> => ({
  ...event,
  stamp: {
    ...event.stamp,
    derived_hash: req.derivedHash,
    // Match the production provider stamp: Unicode-equivalent disclosures share one fingerprint.
    tool_schema_hash: sha256Hex(canonicalJson(req.tools).normalize('NFC')),
    contract_id: req.contractId,
    parser_version: parserVersion,
    model: { ...event.stamp.model, route: req.route, id: req.model },
  },
})

/**
 * A provider that replays scripted streams. It records the bodies it was handed, because what the
 * model was actually shown is the thing most of these tests are about, and a provider that only
 * counted calls would let an empty conversation pass.
 */
export function fakeProvider(scripts: Script[], parserVersion = '1'): FakeProvider {
  let i = 0
  const p: FakeProvider = {
    calls: 0,
    requests: [],
    models: () => [],
    async *infer(req: RequestBody): AsyncIterable<InferenceEvent> {
      p.calls++
      p.requests.push(req)
      const s = scripts[i++] ?? scripts[scripts.length - 1] ?? []
      for (const e of s) yield e.type === 'sent' ? sentFor(req, e, parserVersion) : e
    },
  }
  return p
}

export const sent = (model = 'm'): Extract<InferenceEvent, { type: 'sent' }> => ({
  type: 'sent',
  stamp: {
    contract_id: null,
    parser_version: '1',
    prompt_prefix_hash: HASH,
    tool_schema_hash: HASH,
    derived_hash: HASH,
    sent_hash: 'b'.repeat(64),
    model: { route: 'default', id: model },
    transforms: [],
  },
})
export const usage = (): InferenceEvent => ({
  type: 'usage',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  credits: 1,
  creditSource: 'estimated',
})
export const textTurn = (text: string): Script => [
  sent(),
  { type: 'text_delta', delta: text },
  usage(),
  { type: 'done', reason: 'stop' },
]
export const toolTurn = (name: string, args: unknown, ordinal = 0): Script => [
  sent(),
  { type: 'toolcall_end', call: { toolUseId: '', name, args: args as never, ordinal }, via: 'native' },
  usage(),
  { type: 'done', reason: 'toolUse' },
]
