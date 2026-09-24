import {
  SLOT_NAMES,
  validateAgainst,
  type RequestBody as WireBody,
  type RequestMessage as WireMessage,
} from '@agnes/protocol'
import { RequestBody as WireSchema } from '@agnes/protocol/gen/model'
import { CoreError } from '../types.js'
import { auxiliaryVisionSettledForProvider, requestMediaForProvider } from './derive.js'
import { isLedgerRequest, type LedgerRequest, type RequestMessage } from './mint.js'

type ProviderMediaBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image'; data: string; mimeType: string }>

/**
 * The one conversion from the request core derives to the request the model seam takes.
 *
 * They are deliberately different shapes. Core's carries the ordered prompt sections and the
 * envelope nonce, because those are what a later derivation compares and what the ledger's header
 * stamps; the wire shape has already flattened the sections into one `system` string and replaced
 * the nonce with the hash of the whole body. Nothing about the model's view is decided here — this
 * only moves an already-derived body into the vocabulary the provider speaks, which is why it sits
 * at the call site of `infer` and not inside `deriveRequest`.
 *
 * **What does not survive, and why that is stated rather than left to be discovered.** The wire has
 * one `system` string, so `sections[].id` and `sections[].source` have nowhere to go: the ordered
 * text ships and the contributor identity does not. That loss is on the ledger — the `request/header`
 * and the minted body both keep the sections whole — so it is a loss of what the *provider* can
 * see, not of what happened. Everything else either survives or stops the request: a slot the wire
 * does not name and a tool result with nothing to name are refused here rather than quietly
 * rewritten to something the ledger never recorded.
 */
export function toProviderRequest(
  req: LedgerRequest,
  o: { sessionKey: string; derivedHash: string },
): WireBody {
  if (!isLedgerRequest(req)) throw new CoreError('E_ENVELOPE', 'provider request was not minted by Core')
  const requestMedia = requestMediaForProvider(req, o.sessionKey, o.derivedHash)
  // Auxiliary media is consumed by the Core-owned image-slot effect before the primary request is
  // dispatched. Until that effect has replaced it with an attested untrusted-text bridge, sending
  // these bytes here would violate capability pre-routing and expose images to a text-only model.
  if (
    requestMedia?.header.route === 'auxiliary-vision' &&
    !auxiliaryVisionSettledForProvider(req, o.sessionKey, o.derivedHash)
  )
    throw new CoreError('E_ENVELOPE', 'auxiliary request media requires Core image-slot settlement')
  const mediaBySeq = new Map<number, ProviderMediaBlock[]>()
  for (const image of requestMedia?.header.route === 'native-image' ? requestMedia.selected : []) {
    const blocks = mediaBySeq.get(image.nodeSeq) ?? []
    blocks.push(
      { type: 'text', text: image.untrustedLabel },
      { type: 'image', data: image.data, mimeType: image.mimeType },
    )
    mediaBySeq.set(image.nodeSeq, blocks)
  }
  // Not silently rewritten to 'primary': the slot decides which model answers and which budget the
  // spend lands on, so substituting one the caller did not choose sends the turn somewhere the
  // ledger says it did not go.
  if (!(SLOT_NAMES as readonly string[]).includes(req.model.slot))
    throw new CoreError('E_ENVELOPE', `slot ${req.model.slot} is not one the wire names`, {
      slot: req.model.slot,
    })
  const params = req.samplingParams ?? {}
  if (
    Object.keys(params).some((key) => key !== 'temperature' && key !== 'thinking') ||
    (req.metadata !== undefined && Object.keys(req.metadata).length > 0)
  )
    throw new CoreError('E_ENVELOPE', 'hook patch has no supported provider wire mapping')
  const sampling = {
    ...params,
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
  }
  const body = {
    kind: req.kind === 'summary' ? 'summary' : 'inference',
    sessionKey: o.sessionKey,
    slot: req.model.slot as WireBody['slot'],
    route: req.model.route,
    model: req.model.model,
    contractId: req.contractId,
    derivedHash: o.derivedHash,
    // Joined with a blank line rather than concatenated: the sections are separate instructions and
    // the ledger keeps them apart, so the flattening must not run two of them into one paragraph.
    // `prompt_prefix_hash` hashes this same join, so the stamp covers the bytes that ship.
    system: req.sections.map((s) => s.text).join('\n\n'),
    messages: req.messages.map((message) => {
      const media = mediaBySeq.get(message.seq) ?? []
      if (media.length > 0) mediaBySeq.delete(message.seq)
      return toWireMessage(message, media)
    }),
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as WireBody['tools'][number]['parameters'],
    })),
    ...(Object.keys(sampling).length ? { sampling } : {}),
  }
  if (mediaBySeq.size > 0)
    throw new CoreError('E_ENVELOPE', 'request media has no matching tool-result message')
  const checked = validateAgainst<WireBody>(WireSchema, body)
  if (!checked.ok) throw new CoreError('E_ENVELOPE', 'derived request does not match provider wire schema')
  return checked.value
}

function toWireMessage(m: RequestMessage, media: readonly ProviderMediaBlock[]): WireMessage {
  if (m.role === 'tool') {
    // Core carries one tool result per message; the wire shape names the call on the message
    // itself, and the text — envelope and all — becomes its single content block.
    const first = m.content[0]
    // Refused rather than defaulted to `toolUseId: ''`: an empty id names no call, and a model
    // shown a result that answers nothing is worse than a turn that stops with a reason.
    if (first?.type !== 'tool_result')
      throw new CoreError('E_ENVELOPE', 'tool message without a tool_result block', { seq: m.seq })
    if (m.content.length !== 1)
      throw new CoreError('E_ENVELOPE', 'tool-result content lacks provider media authority', {
        seq: m.seq,
      })
    return {
      role: 'tool_result',
      toolUseId: first.toolUseId,
      content: [{ type: 'text', text: first.text }, ...media],
      isError: first.isError,
    }
  }
  if (m.role === 'assistant') {
    if (media.length > 0)
      throw new CoreError('E_ENVELOPE', 'request media targets a non-tool message', { seq: m.seq })
    return {
      role: 'assistant',
      content: m.content.filter((b) => b.type === 'text' || b.type === 'thinking').map((b) => ({ ...b })),
      ...(m.toolCalls?.length
        ? {
            toolCalls: m.toolCalls.map((c) => ({
              toolUseId: c.toolUseId,
              name: c.name,
              args: c.args as WireBody['tools'][number]['parameters'],
              // The ordinal the id was minted from, not this array's index: the two agree only
              // while a turn has a single assistant message that asked for tools.
              ordinal: c.ordinal,
            })),
          }
        : {}),
    }
  }
  if (media.length > 0)
    throw new CoreError('E_ENVELOPE', 'request media targets a non-tool message', { seq: m.seq })
  return {
    role: 'user',
    content: m.content
      .filter((b) => b.type === 'text' || b.type === 'image')
      .map((b) => (b.type === 'text' ? { type: 'text' as const, text: b.text } : { ...b })),
  }
}
