import {
  type ArtifactRef,
  DEFAULT_OUTPUT_MAX_BYTES,
  type ToolContext,
  type ToolResult,
} from '@agnes/extension-api'

// The bound on how much a tool result may put into the model's context. Whatever a tool produces
// passes through here: over either limit, the whole text goes to the artifact store and the result
// keeps only a head and a tail, so the cost of a tool call stays bounded no matter what the file,
// the command or the match count turns out to be.
//
// Counted in UTF-8 bytes rather than UTF-16 code units. A code-unit budget is not the same budget
// for every script -- a CJK character costs three bytes and an ASCII one costs one, so counting
// units let a Chinese result through at roughly three times the payload an English one got. Bytes
// are also the closer stand-in for what this is really protecting, which is tokens: characters per
// token swings widely by script while bytes per token barely moves. Every other content budget in
// this repository is already in bytes.
//
// The byte limit is a deployment setting (preset `tools.output_max_bytes`, handed to a tool as
// `ctx.outputMaxBytes`). The head and tail kept when a result is cut follow it in the proportions the
// limit has always had, half and an eighth, so one number moves all three together.
export type OutputLimits = { maxBytes: number; maxLines: number; headBytes: number; tailBytes: number }

export function outputLimits(maxBytes: number): OutputLimits {
  return {
    maxBytes,
    maxLines: 2000,
    headBytes: Math.floor(maxBytes / 2),
    tailBytes: Math.floor(maxBytes / 8),
  }
}

/** The limits of a deployment that set nothing. */
export const OUTPUT_LIMITS = outputLimits(DEFAULT_OUTPUT_MAX_BYTES)

export type GuardedOutput = { text: string; ref?: ArtifactRef; truncated: boolean }

// The message in a store-failure note comes from outside this package — an artifact backend can
// hand back a whole HTTP response body or a stack trace — and the note is the one part of a guarded
// result that no limit applies to. Uncut, a large enough message puts more text into the context
// than this guard exists to allow, on the exact path taken when storage is already failing.
const MAX_STORE_ERROR_BYTES = 200

const encoder = new TextEncoder()
// ignoreBOM keeps a leading EF BB BF as the U+FEFF character it is. The default strips it from
// every decode call, not just from a document's first bytes, and both cuts below decode from index
// zero of their own subarray -- so without this a truncated Windows-authored file or a CSV export
// would quietly lose its first character, and a mark sitting where the tail cut begins would
// vanish from the middle. Silently rewriting content is the failure this guard exists to avoid.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

/** What `text` weighs on the wire, which is what every limit here is stated in. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

// Cutting at a byte offset can land inside a multi-byte character. Decoding the halves back would
// silently substitute U+FFFD, turning a truncation into corruption the reader cannot tell from
// content, so both cuts walk to the nearest character boundary instead. A UTF-8 continuation byte
// is 10xxxxxx; stepping off those reaches the start of whatever character the offset fell inside.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000

// Cutting by UTF-16 code unit can land in the middle of a surrogate pair and leave a lone half,
// which is not valid text any more. Trimming the orphan costs at most one code unit per cut.
// Both cuts round-trip through the encoder even when nothing needs removing. Encoding is what
// replaces a lone surrogate with U+FFFD, and a lone surrogate is exactly what arrives when the
// text came from outside this process -- an artifact backend's error message, a tool that built a
// string by slicing bytes of its own. Returning early on the short path would let that half
// through untouched, which is the one case this trimming exists for.
export function cutHead(text: string, endBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= endBytes) return decoder.decode(bytes)
  let end = endBytes
  while (end > 0 && isContinuation(bytes[end] as number)) end--
  return decoder.decode(bytes.subarray(0, end))
}

function cutTail(text: string, startBytes: number): string {
  const bytes = encoder.encode(text)
  if (startBytes <= 0) return decoder.decode(bytes)
  let start = Math.min(startBytes, bytes.length)
  while (start < bytes.length && isContinuation(bytes[start] as number)) start++
  return decoder.decode(bytes.subarray(start))
}

// What an artifact backend rejects with is an arbitrary value, not necessarily an `Error`: a
// null-prototype object, a value whose `toString` or `Symbol.toPrimitive` throws, a proxy that
// throws on every get. Converting one of those to text throws, and this runs inside a `catch` that
// the tools call outside their own `try`, so a throw here would leave the tool's `execute` and end
// the turn — on the exact path taken when storage is already broken. The conversion is therefore
// guarded, and the result is cut with the same two trims the head and the tail get: a cut at a
// fixed code-unit count can leave a lone surrogate half. `cutTail` is applied at offset 0 rather
// than to a cut, because the message arrives from outside and may already start with an orphan;
// the note is text this guard writes, so it is well-formed whatever it is handed.
export function describeFailure(e: unknown): string {
  try {
    return cutTail(cutHead(String((e as Error)?.message ?? e), MAX_STORE_ERROR_BYTES), 0)
  } catch {
    return 'unprintable error'
  }
}

// What the model is given to get back to text the guard cut. `size` is part of the locator because
// the artifact store checks the stored size against the one asked for, so a digest alone cannot be
// turned back into a reference. Digest and size travel together, exactly as the note writes them.
const SPILL_LOCATOR = /^artifact:\/\/([0-9a-f]{64})\?size=(\d{1,16})$/

export function spillLocator(ref: ArtifactRef): string {
  return `artifact://${ref.sha256}?size=${ref.size}`
}

/** The reference a locator names, or `undefined` for anything that is not exactly one. */
export function parseSpillLocator(path: string): ArtifactRef | undefined {
  const m = SPILL_LOCATOR.exec(path)
  if (m === null) return undefined
  const size = Number(m[2])
  return Number.isSafeInteger(size) ? { sha256: m[1] as string, size, mime: 'text/plain' } : undefined
}

/**
 * Splits `text` into pieces of at most `maxBytes` UTF-8 bytes. Every cut is moved back to a
 * character boundary, so no piece starts or ends inside a multi-byte character.
 */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return [text]
  const pieces: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length)
    while (end < bytes.length && end > start && isContinuation(bytes[end] as number)) end--
    // A budget smaller than one character still has to make progress.
    if (end === start) end = Math.min(start + 4, bytes.length)
    pieces.push(decoder.decode(bytes.subarray(start, end)))
    start = end
  }
  return pieces
}

function reason(bytes: number, lines: number, limits: OutputLimits): string {
  const over: string[] = []
  if (bytes > limits.maxBytes) over.push(`${limits.maxBytes}-byte`)
  if (lines > limits.maxLines) over.push(`${limits.maxLines}-line`)
  return over.length === 2 ? `${over.join(' and ')} limits` : `${over[0]} limit`
}

export async function guardOutput(
  ctx: ToolContext,
  text: string,
  opts: { mime?: string } = {},
): Promise<GuardedOutput> {
  const limits = outputLimits(ctx.outputMaxBytes)
  const lines = text.split('\n').length
  const bytes = byteLength(text)
  if (bytes <= limits.maxBytes && lines <= limits.maxLines) return { text, truncated: false }
  const mime = opts.mime ?? 'text/plain'
  let ref: ArtifactRef | undefined
  let stored: string
  try {
    ref = await ctx.artifacts.put(new TextEncoder().encode(text), { mime })
    stored = `full output stored at ${spillLocator(ref)}. To read the rest, call read with that full path, ?size= included, and an offset/limit, or grep that full path to search it`
  } catch (e) {
    // Truncate anyway. Handing back the untruncated text because the store is unavailable would
    // turn a storage failure into an unbounded context, which is the failure this guard exists to
    // prevent; the model is told the middle is gone for good.
    stored = `full output could not be stored: ${describeFailure(e)}`
  }
  const head = cutHead(text, limits.headBytes)
  // Start of the tail is clamped past the head, so the two never overlap. Without the clamp a text
  // that is over the line limit but shorter than head+tail would come back with its middle
  // duplicated — longer than what it replaced.
  const tail = cutTail(text, Math.max(limits.headBytes, bytes - limits.tailBytes))
  const note = `\n[truncated: ${bytes} bytes, ${lines} lines; over the ${reason(bytes, lines, limits)}; ${stored}]\n`
  return ref === undefined
    ? { text: head + note + tail, truncated: true }
    : { text: head + note + tail, ref, truncated: true }
}

export function refBlock(ref: ArtifactRef, mime?: string): { type: 'ref'; ref: ArtifactRef; mime: string } {
  return { type: 'ref', ref, mime: mime ?? ref.mime }
}

// The total one tool call may put into the model's context across every content block it returns,
// once each block has already passed its own single-block guard above: four single-block limits, so
// roughly four blocks at full size fit before the call itself gets cut off, a similar ratio to
// claude-code's 200 KB whole-message cap over its 50 KB single-item limit. Nothing here has been
// tuned against real MCP traffic yet; this is where a later pass would plug in.
export const callOutputLimitBytes = (ctx: Pick<ToolContext, 'outputMaxBytes'>): number =>
  4 * ctx.outputMaxBytes

// One block of a tool call's result, described so guardOutputSet can charge it against the call's
// shared budget. A `text` block still gets guardOutput's own head/tail guard below, and it is the
// post-truncation size that the aggregate budget is charged for -- a block already cut down to a few
// KB by its own guard should not also spend the aggregate budget as if it were still the original
// size. A `passthrough` block is one the caller already turned into whatever it will appear as in the
// result -- an MCP image already converted to an artifact ref, say -- and only declares the byte
// weight the aggregate budget should charge for it.
//
// Every member of this union must carry a real cost. A passthrough block that cost nothing would be
// free budget, which is the specific gap a text-only aggregate cap leaves open: codex bounds its text
// items this way but lets image and encrypted blocks through uncharged, with no comment admitting it.
// A hundred free blocks defeat a cap exactly as well as having no cap at all.
export type GuardedBlock =
  | { kind: 'text'; text: string }
  | { kind: 'passthrough'; bytes: number; content: ToolResult['content'][number] }

export type GuardedSet = {
  /** The content a tool call's result should carry, already within the call's aggregate budget. */
  blocks: ToolResult['content']
  /** How many trailing input blocks the budget could not afford, and so dropped entirely. */
  omitted: number
  /** Where the full, unbounded set of blocks was stored -- present whenever anything was omitted. */
  ref?: ArtifactRef
}

// Guards a whole tool call rather than one block of it. A server returning a hundred blocks that each
// individually pass guardOutput can still put all hundred into the context, because the per-block
// check never sees the other ninety-nine; this is that check, run once per call instead of once per
// block. Blocks are admitted in the order given while the running budget allows it. Once a block
// cannot be afforded, it and every block after it are dropped and counted in `omitted`, rather than
// skipping ahead to let a later, smaller block take its place -- a call's blocks keep the order the
// server sent them in even where the budget cuts them off, the same way guardOutput keeps a single
// block's head before its tail rather than picking whichever half is cheaper.
export async function guardOutputSet(
  ctx: ToolContext,
  input: readonly GuardedBlock[],
  opts: { mime?: string } = {},
): Promise<GuardedSet> {
  const blocks: ToolResult['content'] = []
  const callLimit = callOutputLimitBytes(ctx)
  let remaining = callLimit
  let omitted = 0
  let exhausted = false
  for (const block of input) {
    if (exhausted) {
      omitted++
      continue
    }
    if (block.kind === 'text') {
      const guarded = await guardOutput(ctx, block.text, opts)
      const cost = byteLength(guarded.text)
      if (cost > remaining) {
        exhausted = true
        omitted++
        continue
      }
      blocks.push({ type: 'text', text: guarded.text })
      if (guarded.ref) blocks.push(refBlock(guarded.ref))
      remaining -= cost
    } else {
      if (block.bytes > remaining) {
        exhausted = true
        omitted++
        continue
      }
      blocks.push(block.content)
      remaining -= block.bytes
    }
  }
  if (omitted === 0) return { blocks, omitted }
  // The call's full input, not only the dropped tail, is stored as one artifact -- the same
  // "truncate but keep a pointer to the whole thing" contract guardOutput keeps for a single
  // oversized block, so hitting the aggregate cap loses nothing but the inline view.
  const manifest = JSON.stringify(
    input.map((block) =>
      block.kind === 'text'
        ? { kind: 'text', text: block.text }
        : { kind: 'passthrough', bytes: block.bytes, content: block.content },
    ),
  )
  let ref: ArtifactRef | undefined
  let stored: string
  try {
    ref = await ctx.artifacts.put(new TextEncoder().encode(manifest), { mime: 'application/json' })
    stored = `full set stored at ${spillLocator(ref)}. To read it, call read with that full path, ?size= included, and an offset/limit, or grep that full path to search it; it is a JSON array with one entry per content block`
  } catch (e) {
    // Same failure mode guardOutput guards against: an artifact store outage must not turn into an
    // unbounded result just because the pointer that would have replaced it could not be written.
    stored = `full set could not be stored: ${describeFailure(e)}`
  }
  const note = `\n[omitted ${omitted} of ${input.length} content blocks: over the ${callLimit}-byte call limit; ${stored}]\n`
  blocks.push({ type: 'text', text: note })
  // Same convention guardOutput uses for a single truncated block: the note names the artifact in
  // prose for a human reading the transcript, and a `ref` block carries the same pointer in the
  // structured form artifacts.get actually consumes.
  if (ref !== undefined) blocks.push(refBlock(ref))
  return ref === undefined ? { blocks, omitted } : { blocks, omitted, ref }
}

// How every tool that produces text turns it into a result: guarded, and carrying a reference to
// the whole of it whenever the guard had to cut. Written once so that a tool cannot accidentally
// keep the truncated text and drop the pointer to what was truncated, which would leave the model
// with no way to reach the rest.
export async function guardedResult(ctx: ToolContext, text: string): Promise<ToolResult> {
  const g = await guardOutput(ctx, text)
  const block = { type: 'text' as const, text: g.text }
  return { content: g.ref ? [block, refBlock(g.ref)] : [block] }
}
