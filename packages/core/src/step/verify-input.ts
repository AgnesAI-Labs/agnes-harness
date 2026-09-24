import { validateAgainst } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { Event, Seq } from '../types.js'
import type { SessionImpl } from './session.js'

/**
 * What core hands the verifier seam as `input`. The shape is defined by base's loop-hygiene
 * `VerifyInput`, restated here because base depends on core, never
 * the other way around. The seam blind-casts and fails closed on a malformed input, so every field
 * below is projected from the ledger — an invented one would read as a real check result.
 */
export type CoreVerifyInput = {
  toolCalls: Array<{ name: string; args: unknown; schemaOk: boolean }>
  deviations: number
  recentToolKeys: string[]
  surfaceTailHashes: string[]
  newToolResults: number
  lastFinishReason?: 'stop' | 'length' | 'tool_use' | 'error'
}

/** assistant/message stopReason, spelled as VerifyInput's finish reason. */
const FINISH_REASON: Record<string, CoreVerifyInput['lastFinishReason']> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_use',
}

type Window = {
  calls: Event[]
  deviations: number
  messages: Event[]
  results: Event[]
}

/** The four row kinds a verify input reads, over [fromSeq, lastSeq] on this lane. */
async function scanWindow(s: SessionImpl, fromSeq: Seq): Promise<Window> {
  const rows = await scanAll((q) => s.d.log.scan(q), {
    fromSeq,
    toSeq: s.lastSeq,
    type: ['tool/call', 'format/deviation', 'assistant/message', 'tool/result'],
    lane: s.lane,
  })
  const w: Window = { calls: [], deviations: 0, messages: [], results: [] }
  for (const e of rows) {
    if (e.type === 'tool/call') w.calls.push(e)
    else if (e.type === 'format/deviation') w.deviations++
    else if (e.type === 'assistant/message') w.messages.push(e)
    else w.results.push(e)
  }
  return w
}

/**
 * The dispatch's own judgment, recomputed against the same snapshot approveAndExecute validated
 * against. A call naming a tool the snapshot does not know is refused as TOOL_NOT_FOUND at dispatch
 * — there is no schema its arguments could violate, and reporting one would fail every such turn on
 * a check that is about malformed arguments. A schema that cannot be interpreted reads as invalid,
 * the same refusal approveAndExecute makes of it.
 */
function schemaOk(s: SessionImpl, name: string, args: unknown): boolean {
  const def = s.turn?.snapshot.byName.get(name)
  if (!def) return true
  try {
    return validateAgainst(def.parameters, args).ok
  } catch {
    return false
  }
}

/** The repeated-write key verifierT0 compares: (tool, JCS(args)), one per call in order. */
const toolKey = (name: string, args: unknown): string => `${name}|${canonicalJson(args)}`

/** The visible text of one assistant message; the ledger has no surface-hash concept, so the tail
 * hash is the sha256 of the output text itself. */
function messageText(e: Event): string {
  const content = (e.data as { content?: Array<{ type?: unknown; text?: unknown }> } | null)?.content
  return (content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/**
 * tool/result rows that landed after the assistant message opening the current trailing run of
 * identical output hashes. verifierT0's no-progress check only reads this number when the last N
 * hashes are all equal — which is exactly the window this counts — so the companion number is exact
 * wherever the check can fire, without core having to know the preset's N.
 */
function newToolResults(w: Window, hashes: string[]): number {
  if (w.messages.length === 0) return w.results.length
  let runStart = w.messages.length - 1
  while (runStart > 0 && hashes[runStart - 1] === hashes[hashes.length - 1]) runStart--
  const since = (w.messages[runStart] as Event).seq
  return w.results.filter((e) => e.seq > since).length
}

function assemble(s: SessionImpl, w: Window): CoreVerifyInput {
  const toolCalls = w.calls.map((e) => {
    const d = e.data as { name?: unknown; args?: unknown }
    const name = String(d.name)
    return { name, args: d.args, schemaOk: schemaOk(s, name, d.args) }
  })
  const hashes = w.messages.map((e) => sha256Hex(messageText(e)))
  const last = w.messages[w.messages.length - 1]
  const finish = last
    ? FINISH_REASON[String((last.data as { stopReason?: unknown } | null)?.stopReason)]
    : undefined
  return {
    toolCalls,
    deviations: w.deviations,
    recentToolKeys: toolCalls.map((c) => toolKey(c.name, c.args)),
    surfaceTailHashes: hashes,
    newToolResults: newToolResults(w, hashes),
    ...(finish ? { lastFinishReason: finish } : {}),
  }
}

/**
 * tool scope (approveAndExecute): the one call that just ran. Its schemaOk is the dispatch's own
 * validation result, passed in rather than recomputed, because that is the judgment the call was
 * actually admitted on; the deviation count is this step's, from the open step's start.
 */
export async function toolVerifyInput(
  s: SessionImpl,
  call: { name: string; args: unknown },
  argsSchemaOk: boolean,
): Promise<CoreVerifyInput> {
  const startSeq = s.state.openStep.get(s.lane)?.startSeq ?? s.lastSeq
  const w = await scanWindow(s, startSeq)
  const input = assemble(s, w)
  return {
    ...input,
    toolCalls: [{ name: call.name, args: call.args, schemaOk: argsSchemaOk }],
    recentToolKeys: [toolKey(call.name, call.args)],
  }
}

/** step scope (runToolsPhase, runDeferred): everything the still-open step produced. */
export async function stepVerifyInput(s: SessionImpl, stepStartSeq: Seq): Promise<CoreVerifyInput> {
  return assemble(s, await scanWindow(s, stepStartSeq))
}

/** turn scope (stopGate): the whole turn, from the same triggerSeq the repair history scan uses. */
export async function turnVerifyInput(s: SessionImpl, triggerSeq: Seq): Promise<CoreVerifyInput> {
  return assemble(s, await scanWindow(s, triggerSeq))
}
