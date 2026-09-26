import type { RequestBody as WireBody } from '@agnes/protocol'
import { type InferenceEvent, type JsonValue, type ModelRecord, validateAgainst } from '@agnes/protocol'
import { conservativeSerializedTokens } from '../child/credits.js'
import {
  releaseTreeReservation,
  reserveTreeBudget,
  settleTreeSpend,
  treeBudgetApplies,
  treePermitOf,
} from '../child/runtime-budget.js'
import { effectOutcome } from '../effects/effect.js'
import { withTimeout } from '../effects/wrap.js'
import type { RuntimePromptPreload } from '../kernel.js'
import { scanAll } from '../log/scan-pages.js'
import {
  auxiliaryVisionAvailableForSession,
  runAuxiliaryVisionAssembly,
} from '../orchestrator/auxiliary-vision-assembly.js'
import {
  loadAuxiliaryVisionPreflight,
  persistAuxiliaryVisionPreflight,
  verifyAuxiliaryVisionPreflightMedia,
} from '../orchestrator/request-media-preflight.js'
import {
  type LedgerPreparedRequestMedia,
  prepareRequestMediaFromSurface,
  type RequestMediaScanTruncation,
  restoreRequestMediaFromLedger,
} from '../orchestrator/request-media-surface.js'
import type { BudgetState } from '../reduce/shapes.js'
import { resolveValidatedToolCallPolicy } from '../registry/tool-policy.js'
import { prepareAuxiliaryVisionDerivedText } from '../request/auxiliary-vision-derived-text.js'
import type { ContextBreakdownDiag, ContextSectionSummary, Contribution } from '../request/contribute.js'
import { mergeContributions } from '../request/contribute.js'
import {
  type DeriveInput,
  deriveRequest,
  headerEquals,
  type RequestHeaderData,
  remintRequestWithMaxTokens,
} from '../request/derive.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import { toProviderRequest } from '../request/to-provider.js'
import { CoreError, type Event, type EventInput, type Seq } from '../types.js'
import {
  attemptProviderCount,
  countCalibration,
  type ProviderCountAttempt,
  quoteBudget,
} from './calibrate.js'
import { resolvedModelInput, supportsComputerUse, toolNamesForModel, toolsForModel } from './model-tools.js'
import { type OpStateObj, type ToolCallState, withPhase } from './op-state.js'
import { runCoreReplacement, runSlot } from './reentry.js'
import type { OpContext, SessionImpl, StepOutcome } from './session.js'

/** Truncation reasons already reported per session in this process: one diagnostic row each. */
const reportedMediaWindows = new WeakMap<SessionImpl, Set<RequestMediaScanTruncation['reason']>>()

async function reportMediaWindow(
  s: SessionImpl,
  info: RequestMediaScanTruncation | undefined,
): Promise<void> {
  if (!info) return
  const reported = reportedMediaWindows.get(s) ?? new Set()
  reportedMediaWindows.set(s, reported)
  if (reported.has(info.reason)) return
  reported.add(info.reason)
  await s.diag('request-media-window', { ...info })
}

export async function mediaLedgerForHeader(s: SessionImpl, header: NonNullable<RequestHeaderData['media']>) {
  const resultSeqs = new Set(
    header.selectionOrder.flatMap((index) => {
      const entry = header.manifest[index]
      return entry ? [entry.nodeSeq] : []
    }),
  )
  if (resultSeqs.size === 0) return []
  const results = (
    await scanAll((q) => s.d.log.scan(q), {
      fromSeq: Math.min(...resultSeqs),
      toSeq: Math.max(...resultSeqs),
      type: 'tool/result',
      lane: s.lane,
    })
  ).filter((event) => resultSeqs.has(event.seq))
  const sources = new Set(results.flatMap((event) => event.sourceEventSeqs ?? []))
  const calls =
    sources.size === 0
      ? []
      : (
          await scanAll((q) => s.d.log.scan(q), {
            fromSeq: Math.min(...sources),
            toSeq: Math.max(...sources),
            type: 'tool/call',
            lane: s.lane,
          })
        ).filter((event) => sources.has(event.seq))
  return [...calls, ...results].sort((a, b) => a.seq - b.seq)
}

function auxiliaryAxSomText(events: readonly Event[], media: LedgerPreparedRequestMedia): string {
  const selected = new Set(media.selected.map((image) => image.nodeSeq))
  let text = ''
  for (const event of events) {
    if (!selected.has(event.seq) || event.type !== 'tool/result') continue
    const data = event.data as { content?: unknown }
    if (!Array.isArray(data.content)) continue
    for (const block of data.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      const descriptor = Object.getOwnPropertyDescriptor(block, 'text')
      const type = Object.getOwnPropertyDescriptor(block, 'type')
      if (type?.value !== 'text' || typeof descriptor?.value !== 'string') continue
      const remaining = 262_144 - text.length
      if (remaining <= 0) return text
      text += `${text ? '\n' : ''}${descriptor.value.slice(0, remaining)}`
    }
  }
  return text
}

// Unicode ranges commonly rendered as one glyph per character rather than composed from a small
// alphabet: CJK ideographs and their punctuation, the two Japanese syllabaries, Hangul syllables,
// and full-width forms. A four-characters-per-token divisor is calibrated on Latin script;
// applying it to these ranges silently underprices a token count by roughly half, since a real
// tokenizer spends closer to one token per one to two such characters.
const CJK_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힣]/

/**
 * Four ASCII/Latin characters to a token, roughly 1.7 CJK-range characters to a token: the estimate
 * used where no usage row has been reported yet. Counted per code point rather than assumed from
 * the string's dominant script, because a tool result or a user message commonly mixes both — a
 * file path and a Chinese comment in the same diff, for instance — and a single global divisor
 * would misprice whichever script is the minority in that particular string.
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.7 + other / 4)
}

/** Upper bound on the wire body that will be sent, or null when a field has no supported bound. */
export function boundWireInputTokens(wire: WireBody): number | null {
  for (const message of wire.messages) {
    for (const block of message.content) {
      if (block.type !== 'text' && block.type !== 'thinking') return null
    }
  }
  try {
    const tokens = conservativeSerializedTokens({
      system: wire.system,
      messages: wire.messages,
      tools: wire.tools,
    })
    return Number.isSafeInteger(tokens) ? tokens : null
  } catch {
    return null
  }
}

function wireImageCount(wire: WireBody): number {
  let count = 0
  for (const message of wire.messages)
    for (const block of message.content) if (block.type === 'image') count++
  return count
}

async function fallbackImageInputTokens(
  s: SessionImpl,
  wire: WireBody,
  media: RequestHeaderData['media'],
  imageCount: number,
  estimate: number,
): Promise<number | null> {
  const fallback = s.d.imageInputTokenFallback
  if (!fallback) return null
  try {
    const bound = await withTimeout(
      Promise.resolve(fallback({ wire, ...(media ? { media } : {}), imageCount, signal: s.ac.signal })),
      5000,
      'imageInputTokenFallback',
      s.ac.signal,
    )
    return bound &&
      bound.imageCount === imageCount &&
      Number.isSafeInteger(bound.imageCount) &&
      Number.isSafeInteger(bound.tokens) &&
      bound.tokens > 0
      ? bound.tokens
      : null
  } catch (error) {
    await s.diag('budget-recount', {
      failed: true,
      estimate,
      message: `image token fallback failed: ${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
}

async function releaseTreeReservationOnError<T>(s: SessionImpl, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    await releaseTreeReservation(s)
    throw error
  }
}
const CHUNK_FLUSH = 512
// A provider can pause between two otherwise valid stream events (approval is the real example),
// so size-only batching would hold a short answer forever. The timer is a latency bound, not a
// second terminal condition: the first visible delta flushes immediately, and later deltas get the
// same small batching window while the stream remains active.
const CHUNK_FLUSH_MS = 100
// Streamed text is never written to the ledger. What is written is a start marker, a running count
// at most this often, and the text once if the stream is cut short while this process is alive.
const OUTPUT_PROGRESS_MS = 5_000

/**
 * Only Core reads the accepted prompt body. Extensions receive the deliberately reduced SurfaceNode view.
 * Read from the ledger row, not the surface: compaction may mask the trigger mid-turn, and the turn's
 * preloaded section and suppressed tools must not change when it does.
 */
async function currentPromptText(s: SessionImpl, triggerSeq: number): Promise<string> {
  const [row] = await s.d.log.scan({
    fromSeq: triggerSeq,
    toSeq: triggerSeq,
    type: 'user/message',
    lane: s.lane,
    limit: 1,
  })
  if (row?.type !== 'user/message') return ''
  const content = (row.data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: unknown } =>
        !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text',
    )
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

async function preloadRuntimeSection(
  s: SessionImpl,
  triggerSeq: number,
): Promise<RuntimePromptPreload | undefined> {
  const preloader = s.currentRuntimePromptPreloader()
  const prompt = await currentPromptText(s, triggerSeq)
  if (!preloader || !prompt) return undefined
  try {
    return await preloader({ sessionKey: s.key, prompt })
  } catch (error) {
    s.d.logger.warn('runtime prompt preload failed', {
      sessionKey: s.key,
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/**
 * The route a slot names, and the model id that route is asked to run. They are two different
 * values: a route names an endpoint the assembly declared, a model id names what that endpoint
 * runs. Collapsing them — asking for a model whose id is the route's own name — makes a route
 * table that can never reach `gpt-4.1` or `anthropic/claude-3.5`, because a declared route name is
 * constrained to `^[a-z0-9][a-z0-9-]{0,63}$` and neither `.` nor `/` is in it.
 *
 * Precedence: the preset's pinned id for the slot, then the sealed registry the provider publishes
 * — its record for that route, preferring the one declared for this slot — and only then the route
 * name itself, which is the right answer for a route carrying one model of the same name and is the
 * only answer available from a provider that publishes no models at all.
 */
export function resolveModel(s: SessionImpl, slot: string): { route: string; model: string } {
  const route = s.preset.model.route[slot] ?? 'default'
  const pinned = s.preset.model.id[slot]
  if (pinned) return { route, model: pinned }
  // A provider is free to publish nothing; a registry that throws must not take the turn with it.
  let records: ModelRecord[] = []
  try {
    records = s.d.provider.models().filter((m) => m.route === route)
  } catch {
    records = []
  }
  const id = (records.find((m) => m.slot === slot) ?? records[0])?.id
  return { route, model: id ?? route }
}

/** What the core contribution discloses, which is the preset's disclosure policy read as names. */
export function discloseTools(s: SessionImpl): string[] {
  const snap = s.turn?.snapshot
  if (!snap) return []
  const eager = (): string[] => snap.defs.filter((d) => d.meta.deferLoading !== true).map((d) => d.name)
  let names: string[]
  switch (s.preset.disclosure) {
    case 'code':
      names = eager().filter((name) => name === 'run_code')
      break
    case 'hybrid':
      names = eager()
      break
    default:
      names = eager().filter((name) => name !== 'run_code')
  }
  return s.preset.compaction.enabled && s.preset.compaction.agentCallable && s.compaction.runnable
    ? names
    : names.filter((name) => name !== 'compact')
}

/**
 * The tool uses the conversation already contains, each attributed to the assistant message that
 * asked for it. Read from the ledger rather than from folded state, because the fold keeps a call's
 * name but not its arguments, and it is the arguments the model has to see beside its own request.
 */
export async function surfaceToolCalls(s: SessionImpl): Promise<NonNullable<DeriveInput['toolCalls']>> {
  const onSurface = s
    .surface()
    .filter((n) => n.kind === 'assistant')
    .map((n) => n.seq)
  const first = onSurface[0]
  if (first === undefined) return []
  const visible = new Set(onSurface)
  // Ownership is read off the ledger, not off the surface. A call belongs to the assistant message
  // written in the same settlement transaction, and that is a fact about the rows; inferring it as
  // "the newest *surviving* assistant before this row" re-attributes a call to the previous
  // survivor the moment a summary masks a message in the middle. That is exactly the mis-attachment
  // the derive side drops calls to avoid, so it is settled here rather than left to hold by luck.
  const rows = await scanAll((q) => s.d.log.scan(q), {
    fromSeq: first,
    toSeq: s.lastSeq,
    type: ['assistant/message', 'tool/call'],
    lane: s.lane,
  })
  const out: Array<{
    assistantSeq: Seq
    toolUseId: string
    name: string
    args: unknown
    ordinal: number
  }> = []
  // One ascending pass: the owner of a call is the newest assistant message before it.
  let owner: Seq | undefined
  for (const row of rows) {
    if (row.type === 'assistant/message') {
      owner = row.seq
      continue
    }
    // A call whose own assistant message is no longer on the surface has no landing site: it is
    // dropped with the message rather than moved onto one that did not ask for it.
    if (owner === undefined || !visible.has(owner)) continue
    const d = row.data as { toolUseId?: unknown; name?: unknown; args?: unknown; ordinal?: unknown }
    out.push({
      assistantSeq: owner,
      toolUseId: String(d.toolUseId),
      name: String(d.name),
      args: d.args,
      // The turn-wide ordinal the id was minted from, carried rather than recomputed downstream:
      // an array index disagrees with it the moment one turn has two assistant messages with calls.
      ordinal: Number(d.ordinal ?? 0),
    })
  }
  return out
}

export async function runInference(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op()
  const t = s.turn
  if (!op || !t) return { phase: 'idle' }
  if (
    op.phase.kind === 'inference' &&
    op.phase.gen.status === 'retry_wait' &&
    s.d.clock() < Date.parse(op.phase.gen.notBefore)
  )
    return { phase: 'inference' }
  // A turn whose usage could not be recorded does not get to spend more: the ledger seam is the
  // only record that the spend happened, so an unrecordable spend is refused rather than made.
  if (t.ledgerFailed) {
    await s.endTurn('error', {
      error: { code: 'LEDGER_FAILED', message: 'usage ledger unavailable; refusing inference' },
    })
    return { phase: 'terminal', reason: 'error' }
  }
  const codeTool = t.snapshot.byName.get('run_code')
  if (s.preset.disclosure === 'code' && (!codeTool || codeTool.meta.deferLoading)) {
    await s.endTurn('error', {
      error: { code: 'CODE_RUNTIME_UNAVAILABLE', message: 'code disclosure requires a loaded run_code tool' },
    })
    return { phase: 'terminal', reason: 'error' }
  }
  const step = op.step + 1
  const gate = await s.hooks.beforeStep({ turn: op.meta.turn, step, depth: 0 })
  if (gate.block) {
    await s.endTurn('blocked', { error: { code: 'HOOK_BLOCKED', message: gate.reason ?? '' } })
    return { phase: 'terminal', reason: 'blocked' }
  }
  const attempt = op.phase.kind === 'inference' ? op.phase.gen.attempt : 0
  // Both computed before the contributions rather than after them, because an operation writing a
  // prompt section about this request has to describe the request that is actually sent. Recomputing
  // either one downstream would let the two answers drift, and the drift would read as a prompt that
  // names a model the turn did not go to or a tool the model was never offered.
  const slot = 'primary'
  const target = resolveModel(s, slot)
  // Computer Use depends on the primary model seeing each returned screenshot itself. An
  // auxiliary image model cannot safely steer the primary model's next pointer/keyboard action,
  // so withhold the tool unless this exact primary model advertises native image input. Unknown,
  // duplicate, or malformed catalogue entries resolve to text-only above and therefore fail closed.
  const modelInput = resolvedModelInput(s.d.provider, target)
  const computerUseAllowed = supportsComputerUse(modelInput)
  // Freeze the selected model's contract before asynchronous contribution hooks can run.
  const contract = Object.freeze({ ...(s.d.contractForModel?.(target) ?? s.d.contract) })
  const coreTools = toolNamesForModel(discloseTools(s), computerUseAllowed)
  const ctx: OpContext = {
    session: s,
    preset: s.preset,
    state: op,
    snapshot: toolsForModel(t.snapshot, computerUseAllowed),
    signal: s.ac.signal,
    disclosed: coreTools,
    model: {
      slot,
      ...target,
      ...(s.preset.model.thinking[slot] === undefined ? {} : { thinking: s.preset.model.thinking[slot] }),
    },
  }
  // Before the request this turn is about to send is assembled — the model and the disclosed tool
  // list it reads off `ctx` are already resolved, so an Operation here sees exactly what is about to
  // go out rather than having to recompute either one itself.
  await runSlot(s, 'before-inference', ctx)
  const contribs: Contribution[] = [
    { op: 'core', tools: coreTools },
    ...s.d.operations
      .filter((o) => o.contribute)
      .map((o) => ({ op: o.name, ...(o.contribute as NonNullable<typeof o.contribute>)(ctx) })),
  ]
  const merged = mergeContributions(contribs, t.snapshot)
  for (const c of merged.conflicts) await s.diag('contribute-conflict', c)
  const permitted = new Set(coreTools)
  const preloaded = await preloadRuntimeSection(s, op.meta.triggerSeq)
  const suppressed = new Set(preloaded?.suppressTools ?? [])
  merged.tools = merged.tools.filter((name) => permitted.has(name) && !suppressed.has(name))
  // The Host-private body is appended only after extension context hooks finish. A hook may shape
  // normal contributed context but must never observe raw current-prompt matching or a Skill body.
  const hookSections = await s.hooks.context(merged.sections)
  const sections = preloaded ? [...hookSections, preloaded.section] : hookSections
  if (!computerUseAllowed && t.snapshot.byName.has('computer_use'))
    sections.push({
      id: 'core:computer-use-model',
      order: 111,
      source: 'core',
      text: 'Computer Use is configured but is not offered to this model: its capability record does not include image input. For desktop-control requests, explain that the user needs to select a model that supports images. This model restriction does not mean that the desktop driver is missing or broken.',
    })
  const disclosed = merged.tools.flatMap((n) => {
    const def = t.snapshot.byName.get(n)
    return def ? [def] : []
  })
  const surface = s.surface()
  let requestMedia: LedgerPreparedRequestMedia | undefined
  let auxiliaryVision: ReturnType<typeof prepareAuxiliaryVisionDerivedText> | undefined
  const mediaRuntime = s.d.requestMedia
  if (mediaRuntime) {
    const preflightBinding = {
      sessionKey: s.key,
      lane: s.lane,
      turn: op.meta.turn,
      // A primary retry advances the program-counter step, but it belongs to the same durable
      // media preflight. Subtracting its attempt recovers the first-send logical step; a later
      // tool round starts at attempt zero and therefore cannot collide with this authority.
      step: step - attempt,
      attempt: 0,
      triggerSeq: op.meta.triggerSeq,
    }
    let durablePreflight: Awaited<ReturnType<typeof loadAuxiliaryVisionPreflight>>
    let mediaLedger: Event[]
    try {
      durablePreflight = await loadAuxiliaryVisionPreflight(s, preflightBinding)
      const persistedMedia = attempt > 0 ? t.lastHeader?.media : undefined
      if (durablePreflight) {
        mediaLedger = await mediaLedgerForHeader(s, durablePreflight.header)
        requestMedia = await restoreRequestMediaFromLedger({
          header: durablePreflight.header,
          ledgerEvents: mediaLedger,
          readArtifact: mediaRuntime.readArtifact,
          surfaceLimits: mediaRuntime.surfaceLimits,
          mediaLimits: mediaRuntime.mediaLimits,
          sessionKey: s.key,
          lane: s.lane,
          signal: s.ac.signal,
        })
        verifyAuxiliaryVisionPreflightMedia(durablePreflight, requestMedia, preflightBinding)
      } else if (persistedMedia) {
        mediaLedger = await mediaLedgerForHeader(s, persistedMedia)
        requestMedia = await restoreRequestMediaFromLedger({
          header: persistedMedia,
          ledgerEvents: mediaLedger,
          readArtifact: mediaRuntime.readArtifact,
          surfaceLimits: mediaRuntime.surfaceLimits,
          mediaLimits: mediaRuntime.mediaLimits,
          sessionKey: s.key,
          lane: s.lane,
          signal: s.ac.signal,
        })
      } else {
        mediaLedger = surface.filter((node) => node.kind === 'tool_result').map((node) => node.event)
        let truncation: RequestMediaScanTruncation | undefined
        try {
          requestMedia = await prepareRequestMediaFromSurface({
            sessionKey: s.key,
            surface,
            lookupToolCalls: async (seqs) => {
              const rows = await Promise.all(
                seqs.map((seq) =>
                  s.d.log.scan({ fromSeq: seq, toSeq: seq, type: 'tool/call', lane: s.lane, limit: 1 }),
                ),
              )
              return rows.flat()
            },
            onScanTruncated: (info) => {
              truncation = info
            },
            readArtifact: mediaRuntime.readArtifact,
            surfaceLimits: mediaRuntime.surfaceLimits,
            mediaLimits: mediaRuntime.mediaLimits,
            lane: s.lane,
            signal: s.ac.signal,
            mainModelInput: modelInput,
            auxiliaryVisionAvailable: auxiliaryVisionAvailableForSession(
              s,
              mediaRuntime.auxiliaryVision?.productionAdmission,
            ),
          })
        } finally {
          // Advisory only: it must never replace the preflight's own outcome or error.
          await reportMediaWindow(s, truncation).catch(() => undefined)
        }
      }
    } catch (error) {
      if (!s.ac.signal.aborted) throw error
      await s.endTurn('aborted')
      return { phase: 'terminal', reason: 'aborted' }
    }
    if (requestMedia.header.route === 'auxiliary-vision') {
      const auxiliary = mediaRuntime.auxiliaryVision
      if (!auxiliary) throw new CoreError('E_ENVELOPE', 'auxiliary request media lacks a fitted Core caller')
      const preflight =
        durablePreflight ?? (await persistAuxiliaryVisionPreflight(s, preflightBinding, requestMedia))
      const outcome = await runAuxiliaryVisionAssembly({
        session: s,
        media: requestMedia,
        ...(auxiliary.productionAdmission ? { productionAdmission: auxiliary.productionAdmission } : {}),
        effectId: preflight.effectId,
        axSomText: auxiliaryAxSomText(mediaLedger, requestMedia),
        timeoutMs: auxiliary.timeoutMs,
        imageLimits: auxiliary.imageLimits,
        maxOutputTokens: auxiliary.maxOutputTokens,
        signal: s.ac.signal,
        ...(auxiliary.transformImage ? { transformImage: auxiliary.transformImage } : {}),
      })
      auxiliaryVision = prepareAuxiliaryVisionDerivedText({
        sessionKey: s.key,
        lane: s.lane,
        media: requestMedia,
        terminalOutcome: outcome,
      })
    }
  }
  await s.ensureEnvelopeEpochs()
  let out = deriveRequest({
    kind: 'turn',
    merged: { ...merged, sections },
    harnessEntries: [...s.state.registers.harnessEntries.values()].map((c) => c.value),
    surface,
    disclosed,
    toolCalls: await surfaceToolCalls(s),
    model: {
      slot,
      ...target,
      ...(s.preset.model.thinking[slot] === undefined ? {} : { thinking: s.preset.model.thinking[slot] }),
    },
    contract,
    nonce: t.nonce,
    envelopeNonceFor: (nodeSeq) => s.envelopeNonceFor(nodeSeq),
    envelopeCache: s.envelopeCache,
    ...(requestMedia ? { media: requestMedia, mediaSessionKey: s.key } : {}),
    ...(auxiliaryVision ? { auxiliaryVision } : {}),
  })
  out = await s.hooks.beforeRequest(out, slot, attempt)
  // Cheap and unconditional: section text never leaves process memory (to-provider.ts flattens it
  // away before the wire body exists), so this is the only point that can ever record what the
  // request's system prefix was actually made of. Written every turn, not deduplicated against the
  // previous one -- a `/context` reader always wants the latest snapshot, and the event itself is a
  // few hundred bytes at most (order/source/token count only, no text).
  await s.diag('context-breakdown', {
    sections: out.request.sections.map(
      (section): ContextSectionSummary => ({
        id: section.id,
        order: section.order,
        source: section.source,
        tokens: estimateTokens(section.text),
      }),
    ),
  } satisfies ContextBreakdownDiag)
  // Converted here rather than at the call to `infer`, because the recount below has to be given the
  // body that will actually be sent: counting the derived shape would bill against a request the
  // provider never sees. Tools, system, and messages are all on that wire; omitting any of them
  // lets a legal request reserve below the bytes that actually ship.
  let wire = toProviderRequest(out.request, { sessionKey: s.key, derivedHash: out.header.derived_hash })
  const estimate = (s.latest('budget.state') as BudgetState | undefined)?.lastPreflight?.tokens ?? 0
  let earlyCount: ProviderCountAttempt | undefined
  const imageCount = wireImageCount(wire)
  let imageInputTokens: number | undefined
  if (imageCount > 0) {
    earlyCount = await attemptProviderCount(s, wire, estimate)
    if (s.ac.signal.aborted) {
      await s.endTurn('aborted')
      return { phase: 'terminal', reason: 'aborted' }
    }
    if (earlyCount.kind === 'counted' && earlyCount.count.tokens > 0) {
      imageInputTokens = earlyCount.count.tokens
    } else {
      // A zero provider count is schema-valid but cannot conservatively describe a non-empty
      // image request. Do not expose it to the later calibration path as a usable recount.
      if (earlyCount.kind === 'counted') earlyCount = { kind: 'unavailable', reason: 'failed' }
      imageInputTokens =
        (await fallbackImageInputTokens(s, wire, out.header.media, imageCount, estimate)) ?? undefined
      if (s.ac.signal.aborted) {
        await s.endTurn('aborted')
        return { phase: 'terminal', reason: 'aborted' }
      }
    }
    if (imageInputTokens === undefined) {
      await s.endTurn('budget')
      return { phase: 'terminal', reason: 'budget' }
    }
  }
  if (await treeBudgetApplies(s)) {
    const inputTokens = imageInputTokens ?? boundWireInputTokens(wire)
    if (inputTokens === null) {
      await s.endTurn('budget')
      return { phase: 'terminal', reason: 'budget' }
    }
    const projected = await s.d.runtime.ledgerProjected({
      tokensEstimate: inputTokens,
      model: target.model,
    })
    const tree = await reserveTreeBudget(s, projected.credits, target, inputTokens)
    if (tree !== 'ok') return { phase: 'terminal', reason: tree.reason }
    const bound = treePermitOf(s)
    if (bound?.maxTokens !== undefined) {
      const previousDerivedHash = wire.derivedHash
      const { request, derivedHash } = await releaseTreeReservationOnError(s, () =>
        remintRequestWithMaxTokens(out.request, out.media, bound.maxTokens as number),
      )
      out = { ...out, request, header: { ...out.header, derived_hash: derivedHash } }
      wire = await releaseTreeReservationOnError(s, () =>
        toProviderRequest(out.request, { sessionKey: s.key, derivedHash: out.header.derived_hash }),
      )
      if (imageCount > 0 && previousDerivedHash !== derivedHash) {
        earlyCount = { kind: 'unavailable', reason: 'failed' }
        imageInputTokens = await releaseTreeReservationOnError(
          s,
          async () =>
            (await fallbackImageInputTokens(s, wire, out.header.media, imageCount, estimate)) ?? undefined,
        )
        if (s.ac.signal.aborted) {
          await releaseTreeReservation(s)
          await s.endTurn('aborted')
          return { phase: 'terminal', reason: 'aborted' }
        }
        if (imageInputTokens === undefined) {
          await releaseTreeReservation(s)
          await s.endTurn('budget')
          return { phase: 'terminal', reason: 'budget' }
        }
      }
      if (wire.sampling?.maxTokens !== out.request.maxTokens) {
        await releaseTreeReservation(s)
        await s.endTurn('budget')
        return { phase: 'terminal', reason: 'budget' }
      }
    }
  }
  const offered = new Set(wire.tools.map((tool) => tool.name))
  // The recount, before anything is announced and before anything is sent. A request the preset
  // wants counted is held to the cap here, where the request finally exists — refusing it after the
  // intent row would leave an effect nobody can settle, for a call that never happened.
  const cal = await releaseTreeReservationOnError(s, () =>
    countCalibration(
      s,
      wire,
      estimate,
      earlyCount,
      earlyCount?.kind === 'unavailable' ? imageInputTokens : undefined,
    ),
  )
  if (cal.deny) {
    const deny = cal.deny
    const counted = cal.event ? [cal.event] : []
    if (s.preset.budget.onExceed === 'deny') {
      await releaseTreeReservation(s)
      await s.endTurn('budget', { error: deny, events: counted })
      return { phase: 'terminal', reason: 'budget' }
    }
    const quoted = await releaseTreeReservationOnError(s, () =>
      quoteBudget(s, deny.message, { events: counted }),
    )
    if (quoted !== 'ok') {
      await releaseTreeReservation(s)
      return { phase: 'terminal', reason: quoted.reason }
    }
  }
  if (s.ac.signal.aborted) {
    await releaseTreeReservation(s)
    await s.endTurn('aborted')
    return { phase: 'terminal', reason: 'aborted' }
  }
  const { effect, header, effectIntentSeq, headerSeq } = await releaseTreeReservationOnError(s, async () => {
    const effect = s.effects.start({ kind: 'inference', replay: 'never', slot })
    const header: RequestHeaderData = out.header
    const writesHeader = !t.lastHeader || !headerEquals(t.lastHeader, header)
    const headerEvent = writesHeader ? s.ev('request/header', header) : undefined
    const pre: EventInput[] = [
      s.ev('step/start', { turn: op.meta.turn, step }),
      // Only when the deny path did not already write it: that path carries the count in its own
      // transaction, and a second copy here would record one recount as two.
      ...(cal.event && !cal.deny ? [cal.event] : []),
      ...(out.runtimeContext.event ? [out.runtimeContext.event] : []),
      ...(headerEvent ? [headerEvent] : []),
      effect.intent,
    ]
    const headerIndex = headerEvent ? pre.indexOf(headerEvent) : -1
    const intentIndex = pre.indexOf(effect.intent)
    const transitionSeqs = await s.transition(
      pre,
      withPhase(
        op,
        {
          kind: 'inference',
          gen: { status: 'effect_pending', attempt, effectId: effect.effectId, slot },
        },
        { step },
      ),
    )
    // Update the in-memory dedup key only after the atomic transition committed the header. A retry
    // that derives the same request reuses that durable header; each actual dispatch still gets its
    // own provider receipt below.
    if (writesHeader) {
      t.lastHeader = header
      t.lastHeaderSeq = transitionSeqs[headerIndex] ?? null
      if (t.lastHeaderSeq !== null) s.recordEnvelopeHeader(t.lastHeaderSeq, header.envelopeNonce)
    }
    const effectIntentSeq = transitionSeqs[intentIndex]
    if (t.lastHeaderSeq === null || effectIntentSeq === undefined)
      throw new CoreError('E_RELATION', 'inference dispatch lacks durable header/effect sources')
    return { effect, header, effectIntentSeq, headerSeq: t.lastHeaderSeq }
  })

  let text = ''
  let thinking = ''
  let buffered = ''
  // The kind the buffer currently holds. One buffer, not two, so a switch between reasoning and
  // visible text flushes rather than interleaving two streams into one row out of order.
  let bufferedKind: 'text' | 'thinking' = 'text'
  let sentWritten = false
  let firstChunkFlushed = false
  let outputStarted = false
  let outputCut = false
  // Set once the settling rows are admitted; after that the settlement itself carries the text.
  let settleAdmitted = false
  let outputAt = 0
  let outputChars = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let flushQueue = Promise.resolve()
  let flushFailure: { error: unknown } | undefined
  // This is the one pending `iterator.next()` at a time. A timer failure wakes it directly instead
  // of racing every next call against one never-settling Promise (which would retain one reaction
  // per streamed chunk). The same wake path makes session cancellation bounded for a provider that
  // has not yet observed its signal.
  let wakeStream: ((error: unknown) => void) | undefined
  const streamAbort = new AbortController()
  const outputRow = (state: 'started' | 'progress' | 'interrupted'): EventInput =>
    s.ev(
      'assistant/output',
      {
        state,
        effectId: effect.effectId,
        chars: { text: text.length, thinking: thinking.length },
        estimatedTokens: estimateTokens(text + thinking),
        ...(state === 'interrupted'
          ? {
              content: [
                ...(thinking ? [{ type: 'thinking', text: thinking }] : []),
                ...(text ? [{ type: 'text', text }] : []),
              ],
            }
          : {}),
      },
      { origin: 'model' },
    )
  /** The text said so far, once, for a stream that is stopping before its answer is written. */
  const cutRow = (): EventInput[] => {
    if (!outputStarted || outputCut || settleAdmitted) return []
    outputCut = true
    return [outputRow('interrupted')]
  }
  const onSessionAbort = (): void => {
    // A session abort is also how a close stops a running inference, and close seals the log before
    // this inference's own error path can write anything. append admits synchronously and close
    // drains what it admitted, so recording the text here, in the abort callback, is what keeps it.
    const cut = cutRow()
    if (cut.length > 0) void s.d.log.append(cut).catch(() => undefined)
    streamAbort.abort(s.ac.signal.reason)
    wakeStream?.(s.ac.signal.reason ?? new Error('inference aborted'))
  }
  if (s.ac.signal.aborted) onSessionAbort()
  else s.ac.signal.addEventListener('abort', onSessionAbort, { once: true })
  const calls: Array<{ name: string; args: unknown; via: string }> = []
  const deviations: EventInput[] = []
  let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
  let done: Extract<InferenceEvent, { type: 'done' }> | undefined
  let error: Extract<InferenceEvent, { type: 'error' }> | undefined
  let unparsed = false
  const deviation = (rule: string, sampleHash: string): EventInput => {
    // Observe category: fire-and-forget, and `.catch` keeps a failing hook from ever blocking the
    // `format/deviation` ledger row it sits beside — unlike the transform hooks above, which do get
    // to reject the whole dispatch.
    if (s.hooks.formatDeviation)
      void s.hooks.formatDeviation({ rule, model: target.model, sampleHash }).catch(() => undefined)
    return s.ev('format/deviation', {
      rule,
      model: target.model,
      sampleHash,
      parserVersion: contract.parser_version,
    })
  }
  const cancelFlushTimer = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
  }
  const flush = async (): Promise<void> => {
    cancelFlushTimer()
    if (flushFailure) throw flushFailure.error
    if (buffered) {
      const delta = buffered
      const kind = bufferedKind
      buffered = ''
      const streamed = kind === 'text' ? text : thinking
      const offset = streamed.length - delta.length
      // Rows are appended by direct calls, so they are admitted in call order: a cut recorded by
      // the abort callback always lands after every count written before it. The promise only
      // carries a failure to the inference owner.
      const written = (row: EventInput): void => {
        const pending = s.d.log.append([row]).then(() => undefined)
        pending.catch(() => undefined)
        flushQueue = Promise.all([flushQueue, pending]).then(() => undefined)
      }
      if (!outputStarted) {
        // The start marker is committed before any viewer sees text, so the node a viewer joins the
        // stream through always exists by the time its first preview arrives.
        outputStarted = true
        outputAt = s.d.clock()
        outputChars = text.length + thinking.length
        written(outputRow('started'))
        await flushQueue
      }
      s.preview.publish({ lane: s.lane, effectId: effect.effectId, stream: kind, offset, delta })
      const now = s.d.clock()
      const said = text.length + thinking.length
      if (!outputCut && now - outputAt >= OUTPUT_PROGRESS_MS && said !== outputChars) {
        outputAt = now
        outputChars = said
        written(outputRow('progress'))
      }
    }
    await flushQueue
  }
  const armFlushTimer = (): void => {
    if (flushTimer !== undefined || !buffered) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      // There is no consumer to await from a timer callback. Retain the rejection and surface it
      // from the next stream event or the final flush; an unhandled rejection would tear down the
      // process while the inference operation is still the one responsible for the error.
      void flush().catch((error: unknown) => {
        flushFailure = { error }
        streamAbort.abort(error)
        wakeStream?.(error)
      })
    }, CHUNK_FLUSH_MS)
  }
  const nextStream = (
    next: Promise<IteratorResult<InferenceEvent>>,
  ): Promise<IteratorResult<InferenceEvent>> => {
    return new Promise((resolve, reject) => {
      let settled = false
      const clear = (): void => {
        if (wakeStream === fail) wakeStream = undefined
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        clear()
        reject(error)
      }
      wakeStream = fail
      next.then(
        (value) => {
          if (settled) return
          settled = true
          clear()
          resolve(value)
        },
        (error: unknown) => fail(error),
      )
      // `iterator.next()` is created by the caller before this wrapper, so even a pre-existing
      // flush failure or cancellation must attach the rejection observer above. Failing first
      // would leave a provider's later rejection unhandled while the owner is already settling.
      if (flushFailure) fail(flushFailure.error)
      else if (s.ac.signal.aborted) fail(s.ac.signal.reason ?? new Error('inference aborted'))
    })
  }
  const emit = async (kind: 'text' | 'thinking', delta: string): Promise<void> => {
    // Empty provider deltas carry no visible information and must not consume the first-flush
    // guarantee. Some adapters emit an empty boundary while assembling a response.
    if (!delta) return
    if (buffered && bufferedKind !== kind) await flush()
    bufferedKind = kind
    buffered += delta
    if (!firstChunkFlushed) {
      firstChunkFlushed = true
      await flush()
    } else if (buffered.length >= CHUNK_FLUSH) await flush()
    else armFlushTimer()
  }
  const untrackPreview = s.preview.track(effect.effectId, () => ({
    lane: s.lane,
    effectId: effect.effectId,
    text,
    thinking,
  }))
  try {
    const inferOptions = { signal: streamAbort.signal, toolNames: merged.tools }
    const stream = s.d.segments?.Inference
      ? await runCoreReplacement(s, 'Inference', ctx, { request: wire, options: inferOptions }, async () =>
          s.d.provider.infer(wire, inferOptions),
        )
      : s.d.provider.infer(wire, inferOptions)
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function')
      throw new Error('Inference replacement returned a non-async stream')
    const iterator = stream[Symbol.asyncIterator]()
    let streamDone = false
    try {
      for (;;) {
        const next = await nextStream(Promise.resolve(iterator.next()))
        if (next.done) {
          streamDone = true
          break
        }
        const ev = next.value
        if (ev.type === 'sent') {
          if (sentWritten) {
            error = {
              type: 'error',
              reason: 'error',
              code: 'TRANSPORT',
              message: 'duplicate sent',
              retryable: true,
            }
            break
          }
          if (
            ev.stamp.derived_hash !== header.derived_hash ||
            ev.stamp.tool_schema_hash !== header.tool_schema_hash ||
            ev.stamp.parser_version !== header.parser_version ||
            ev.stamp.contract_id !== header.contract_id ||
            ev.stamp.model.id !== target.model ||
            ev.stamp.model.route !== target.route
          ) {
            error = {
              type: 'error',
              reason: 'error',
              code: 'CONTRACT_MISMATCH',
              message: 'provider sent stamp does not match the dispatched request',
              retryable: false,
            }
            break
          }
          // The stamp is provider-owned evidence about the actual dispatch. Persist it immediately:
          // no model output may be appended before this receipt, and a duplicate must never create
          // a second receipt for the same dispatch.
          await s.d.log.append([
            s.ev('request/sent', ev.stamp, {
              sourceEventSeqs: [headerSeq, effectIntentSeq],
            }),
          ])
          sentWritten = true
        } else if (!sentWritten && ev.type !== 'error') {
          error = {
            type: 'error',
            reason: 'error',
            code: 'TRANSPORT',
            message: 'missing sent',
            retryable: true,
          }
          break
        } else if (ev.type === 'text_delta') {
          text += ev.delta
          await emit('text', ev.delta)
        } else if (ev.type === 'thinking_delta') {
          // Streamed like visible text rather than only accumulated: a viewer renders reasoning from
          // the thinking previews, and never flushing it meant no consumer ever saw one.
          thinking += ev.delta
          await emit('thinking', ev.delta)
        } else if (ev.type === 'toolcall_end') {
          calls.push({ name: ev.call.name, args: ev.call.args, via: ev.via })
          // The deviation names the shape that was parsed, and the sample it was parsed from is the
          // call itself: a hash of nothing cannot be compared against a later sample.
          if (ev.via !== 'native')
            deviations.push(
              deviation(ev.via, sha256Hex(canonicalJson({ name: ev.call.name, args: ev.call.args }))),
            )
        } else if (ev.type === 'deviation') {
          unparsed = true
          deviations.push(deviation('unparsed', ev.sampleHash))
        } else if (ev.type === 'usage') usage = ev
        else if (ev.type === 'done') done = ev
        else if (ev.type === 'error') {
          error = ev
          break
        }
      }
    } finally {
      // The normal async-iterator protocol closes after a break. Do the same here, but do not wait
      // for a provider that ignores return() forever: the owner has already received the failure or
      // cancellation that made this inference stop.
      if (!streamDone) void iterator.return?.(undefined)?.then(undefined, () => {})
    }
  } catch (err) {
    cancelFlushTimer()
    error = {
      type: 'error',
      reason: s.ac.signal.aborted ? 'aborted' : 'error',
      code: s.ac.signal.aborted ? 'ABORTED' : 'TRANSPORT',
      message: err instanceof Error ? err.message : String(err),
      retryable: !s.ac.signal.aborted,
    }
  }
  // The listener stays until the settling rows are admitted: a close that lands after the stream
  // has ended but before the settlement is written would otherwise take the whole text with it.
  try {
    cancelFlushTimer()
    try {
      await flush()
    } finally {
      untrackPreview()
    }
    if (!error && !sentWritten) {
      error = {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message: 'missing sent',
        retryable: true,
      }
    }
    const tokens = usage?.tokens ?? {
      input: 0,
      output: estimateTokens(text + thinking),
      cacheRead: 0,
      cacheWrite: 0,
    }
    const spend = {
      purpose: 'inference' as const,
      effectId: effect.effectId,
      tokens,
      ...(usage?.credits !== undefined ? { credits: usage.credits } : {}),
      creditSource: usage?.creditSource ?? 'estimated',
      model: target.model,
      ...(usage?.billing ? { billing: usage.billing } : {}),
      ...(usage?.timing ? { timing: usage.timing } : {}),
    }
    const cost = (interrupted: boolean): EventInput =>
      s.ev('cost/ledger', { ...spend, ...(interrupted ? { interrupted: true } : {}) })
    /**
     * The spend is told to the ledger seam on every exit, not only the successful one. The seam is
     * the only record that the spend happened; an interrupted request still burned the tokens it
     * burned, and skipping the call means `ledgerFailed` can never trip on it and the fail-closed
     * refusal above never fires for an unrecordable interrupted spend.
     */
    const record = async (interrupted: boolean): Promise<void> => {
      const ok = await s.d.runtime.ledgerRecord({
        ...spend,
        ...(interrupted ? { interrupted: true } : {}),
        sessionKey: s.key,
        lane: s.lane,
        turn: op.meta.turn,
        step,
      })
      if (!ok) {
        t.ledgerFailed = true
        await s.diag('seam-failed', { seam: 'ledger', op: 'record' })
      }
      await settleTreeSpend(s, spend.credits, (s.lastSeq + 1) as Seq)
    }
    // A step spans this inference plus the tools it asks for. Every exit that does not hand the step
    // to the tools phase closes it here: an open step makes the next step/start illegal and blocks
    // turn/end, so a retry, a drain and a compaction would all be unreachable without this.
    const stepEnd = (): EventInput => s.ev('step/end', { turn: op.meta.turn, step })
    const cur = s.op() as OpStateObj
    if (error) {
      // Admitted now rather than with the settlement: the hooks and the lock ahead of the settlement
      // can outlast a close, and close only drains what was admitted before it sealed the log.
      const cut = cutRow()
      if (cut.length > 0) void s.d.log.append(cut).catch(() => undefined)
      await record(true)
      // Observe category, mode 'parallel': HookDispatch already contains a failing handler internally
      // (it reports and moves on rather than rejecting), so this cannot itself throw into the retry/
      // drain/compaction decisions that follow. `attempt` is the same retry counter those decisions
      // read below, not the request's own id — there is no request id to report here.
      if (s.hooks.requestError)
        await s.hooks.requestError({
          code: error.code,
          message: error.message,
          attempt,
          retryable: error.retryable,
        })
      if (error.reason === 'aborted') {
        await s.transition(
          [cost(true), effect.settle('aborted'), stepEnd()],
          withPhase(cur, {
            kind: 'failure_drain',
            error: { code: 'ABORTED', message: error.message },
            provenance: { kind: 'inference' },
          }),
        )
        // The settlement and the step's close are already written; what is missing is the turn's own
        // terminal row, and the drain phase is where `step()` writes it. Reporting `terminal` here
        // ended the run with the turn still open, which is a ledger the next reader has to repair
        // before it can do anything else.
        return { phase: 'failure_drain' }
      }
      if (
        error.code === 'OVERFLOW' &&
        s.preset.compaction.enabled &&
        s.compaction.onOverflow() === 'compaction'
      ) {
        await s.transition(
          [cost(true), effect.settle('error'), stepEnd()],
          withPhase(cur, {
            kind: 'compaction',
            reason: 'overflow',
            resumeAfter: {
              kind: 'checkpoint',
              continuation: 'need_assistant',
              triggerSeq: op.meta.triggerSeq,
            },
          }),
        )
        return { phase: 'compaction' }
      }
      if (error.retryable && attempt + 1 < s.preset.model.retry.maxAttempts) {
        const notBefore = new Date(
          s.d.clock() + s.preset.model.retry.baseDelayMs * 2 ** attempt,
        ).toISOString()
        await s.transition(
          [cost(true), effect.settle('error'), stepEnd()],
          withPhase(cur, {
            kind: 'inference',
            gen: { status: 'retry_wait', attempt: attempt + 1, notBefore, code: error.code },
          }),
        )
        return { phase: 'inference' }
      }
      await s.transition(
        [cost(true), effect.settle('error'), stepEnd()],
        withPhase(cur, {
          kind: 'failure_drain',
          error: { code: error.code, message: error.message },
          provenance: { kind: 'inference' },
        }),
      )
      return { phase: 'failure_drain' }
    }

    const events: EventInput[] = []
    const truncated = done?.reason === 'length'
    // An empty text block is not shipped. It is content the model never produced, it goes back to the
    // provider on the next request as part of the assistant turn, and a provider that rejects empty
    // text blocks refuses the whole request over a block core invented.
    const content = [
      ...(thinking ? [{ type: 'thinking', text: thinking }] : []),
      ...(text ? [{ type: 'text', text }] : []),
    ]
    const stopReason = truncated ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn'
    events.push(
      s.ev('assistant/message', { content, stopReason, requestSeq: s.lastSeq }, { origin: 'model' }),
    )
    const planned: ToolCallState[] = []
    const refusedCalls: EventInput[] = []
    // A truncated answer's tool calls are dropped rather than run: the arguments were cut off
    // mid-serialisation, so what survives is a call the model did not finish asking for.
    if (!truncated)
      for (const c of calls) {
        const ordinal = t.ordinal++
        const toolUseId = s.d.ids.toolUseId(ordinal)
        const def = t.snapshot.byName.get(c.name)
        let refusal:
          | {
              code: 'TOOL_NOT_FOUND' | 'TOOL_ARGS_INVALID' | 'TOOL_POLICY_INVALID' | 'TOOL_NOT_DISCLOSED'
              text: string
            }
          | undefined
        let policy: ReturnType<typeof resolveValidatedToolCallPolicy> | undefined
        if (!def) refusal = { code: 'TOOL_NOT_FOUND', text: `unknown tool ${c.name}` }
        else if (!offered.has(c.name))
          refusal = { code: 'TOOL_NOT_DISCLOSED', text: 'tool was not disclosed in this request' }
        else {
          let valid = false
          try {
            valid = validateAgainst(def.parameters, c.args).ok
          } catch {
            // A malformed schema is an argument refusal, never permission to invoke a classifier.
          }
          if (!valid)
            refusal = {
              code: 'TOOL_ARGS_INVALID',
              text: 'tool arguments do not match the registered schema',
            }
          else {
            try {
              policy = resolveValidatedToolCallPolicy(def, c.args as JsonValue)
            } catch (error) {
              refusal = {
                code: 'TOOL_POLICY_INVALID',
                text: error instanceof Error ? error.message : 'tool policy classifier failed',
              }
            }
          }
        }
        events.push(
          s.ev(
            'tool/call',
            {
              toolUseId,
              name: c.name,
              args: c.args,
              ordinal,
              ...(policy ?? {}),
            },
            { origin: 'model' },
          ),
        )
        if (refusal)
          refusedCalls.push(
            s.ev('tool/result', {
              toolUseId,
              isError: true,
              code: refusal.code,
              content: [{ type: 'text', text: refusal.text }],
              enforcement: s.d.runtime.enforcement(),
              authz: { decisionId: 'n/a' },
            }),
          )
        const baseCall = {
          ordinal,
          toolUseId,
          name: c.name,
          argsSeq: 1,
          replay: policy?.resolvedPolicy.replay ?? 'never',
        }
        if (refusal) {
          planned.push(
            policy ? { ...baseCall, status: 'completed', ...policy } : { ...baseCall, status: 'completed' },
          )
        } else {
          if (!policy) throw new Error('validated tool call lacks resolved policy')
          planned.push({ ...baseCall, status: 'planned', ...policy })
        }
      }
    events.push(...refusedCalls, ...deviations, cost(false), effect.settle(effectOutcome({})))
    if ((truncated && calls.length) || unparsed)
      events.push(
        s.ev('user/message', {
          content: [
            {
              type: 'text',
              text: truncated
                ? 'Output was truncated; tool calls were discarded. Continue.'
                : 'INVALID_TOOL_CALL_FORMAT: a tool call was emitted as text and was not executed.',
            },
          ],
          kind: 'runtime_context',
        }),
      )
    if (planned.length === 0) events.push(stepEnd())
    const assistantAt = events.findIndex((e) => e.type === 'assistant/message')
    // The assistant message's own sequence number, computed from the number this batch's first row
    // will be committed at rather than from `lastSeq` read before the queue. Everything the turn is
    // addressed by hangs off it — `batch.assistantSeq`, every `argsSeq`, `latestAssistantSeq` — so a
    // row landing between the guess and the append would misname all of them at once.
    await s.transition(events, (curOp, nextSeq) => {
      settleAdmitted = true
      const base = curOp ?? cur
      const assistantSeq = (nextSeq + assistantAt) as Seq
      return planned.length
        ? withPhase(
            base,
            {
              kind: 'tools',
              batch: {
                assistantSeq,
                calls: planned.map((p, i) => ({ ...p, argsSeq: assistantSeq + 1 + i })),
              },
            },
            { latestAssistantSeq: assistantSeq },
          )
        : withPhase(
            base,
            {
              kind: 'checkpoint',
              continuation: (truncated && calls.length) || unparsed ? 'need_assistant' : 'may_finish',
              triggerSeq: op.meta.triggerSeq,
            },
            { latestAssistantSeq: assistantSeq },
          )
    })
    await record(false)
    return { phase: planned.length ? 'tools' : 'checkpoint' }
  } finally {
    s.ac.signal.removeEventListener('abort', onSessionAbort)
  }
}
