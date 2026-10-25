import { attachmentOmittedThrough, attachmentSurface } from '../../request/attachment-surface.js'
import { estimateTokens } from '../model-tokens.js'

export { estimateTokens } from '../model-tokens.js'

import { conservativeSerializedTokens } from '@agnes/core-child-control/child/credits'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { type OpStateObj, type ToolCallState, withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type Event, type EventInput, type Seq } from '@agnes/core-common/types'
import { withTimeout } from '@agnes/core-effects/effects/wrap'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { isNestedCall } from '@agnes/core-ledger/project/surface'
import type { BudgetState } from '@agnes/core-ledger/reduce/shapes'
import type { InferenceEvent, JsonValue, ModelRecord, RequestBody as WireBody } from '@agnes/protocol'
import { childReceiptNarrative } from '../../child/receipts.js'
import {
  releaseTreeReservation,
  reserveTreeBudget,
  treeBudgetApplies,
  treePermitOf,
} from '../../child/runtime-budget.js'
import type { RuntimePromptPreload } from '../../kernel.js'
import { beforeLoopModelRequest, loopEventContext } from '../../loop/events.js'
import { loopRequestHistory, loopTailNote, withLoopSampling } from '../../loop/request-options.js'
import { sessionIdentity } from '../../loop/scope.js'
import {
  auxiliaryVisionAvailableForSession,
  runAuxiliaryVisionAssembly,
} from '../../orchestrator/auxiliary-vision-assembly.js'
import {
  loadAuxiliaryVisionPreflight,
  persistAuxiliaryVisionPreflight,
  verifyAuxiliaryVisionPreflightMedia,
} from '../../orchestrator/request-media-preflight.js'
import {
  type LedgerPreparedRequestMedia,
  prepareRequestMediaFromSurface,
  type RequestMediaScanTruncation,
  restoreRequestMediaFromLedger,
} from '../../orchestrator/request-media-surface.js'
import { prepareAuxiliaryVisionDerivedText } from '../../request/auxiliary-vision-derived-text.js'
import type {
  ContextBreakdownDiag,
  ContextSectionSummary,
  Contribution,
  Merged,
} from '../../request/contribute.js'
import { mergeContributions } from '../../request/contribute.js'
import { deferredToolsSection } from '../../request/deferred-tools.js'
import {
  type DeriveInput,
  type DeriveOutput,
  deriveRequest,
  HOOK_CONTEXT_PREFIX,
  headerEquals,
  type RequestHeaderData,
  remintRequestWithMaxTokens,
  requestMemoryRevision,
  SKILL_LOADED_PREFIX,
  TURN_TIME_PREFIX,
} from '../../request/derive.js'
import { inlineImageMediaSurface } from '../../request/inline-images.js'
import { toProviderRequest } from '../../request/to-provider.js'
import {
  attemptProviderCount,
  countCalibration,
  type ProviderCountAttempt,
  quoteBudget,
} from '../../step/calibrate.js'
import { finishAborted } from '../../step/control.js'
import {
  modelVisibleTool,
  resolvedModelRecord,
  supportsComputerUse,
  toolNamesForModel,
  toolsForModel,
} from '../../step/model-tools.js'
import { runSlot } from '../../step/reentry.js'
import type { OpContext, SessionImpl, StepOutcome } from '../../step/session.js'
import { restoreToolArgumentRecovery, toolArgumentsDisabled } from '../../step/tool-argument-recovery.js'
import { toolCallPayload } from '../../step/tool-call.js'
import { isUnattended } from '../../step/turn-restore.js'
import { ModelExecution } from '../model-execution.js'
import { beforeStepGate, builtinBudgetPreflight, contextBudgetError } from './gate.js'
import { appendHookData } from './hook-data-note.js'
import { progressCheckNote } from './progress-check.js'
import { bindToolAvailability, disclosureRestriction, prepareToolAvailability } from './tool-availability.js'
import { checkModelToolCall } from './tool-call-check.js'
import { loadedToolNames, restoreToolDisclosure } from './tool-disclosure.js'
import { turnLimitSection, turnTimeNote } from './turn-limits.js'

/**
 * What the model is told in a turn whose input declared that nobody attends it. The first line is
 * the title an attended turn's tombstone keeps, so clearing the note does not repeat its body.
 */
export const UNATTENDED_NOTE =
  'Unattended run\nThis run is unattended: nobody can answer questions, review a plan or look at a UI surface before it ends, and your final reply is all that is returned. Do not ask the user or wait for input. Finish the task end to end on your own best judgment: where it is ambiguous, choose the most reasonable interpretation, carry it out, and state the assumptions you made in the final reply.'

/** Truncation reasons already reported per session in this process: one diagnostic row each. */
const reportedMediaWindows = new WeakMap<object, Set<RequestMediaScanTruncation['reason']>>()

async function reportMediaWindow(
  s: SessionImpl,
  info: RequestMediaScanTruncation | undefined,
): Promise<void> {
  if (!info) return
  const reported = reportedMediaWindows.get(sessionIdentity(s)) ?? new Set()
  reportedMediaWindows.set(sessionIdentity(s), reported)
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
 * Read from the ledger row, not the surface: compaction may mask the trigger mid-turn, but the
 * turn's Host-selected Skill preload remains memoized and its note may be restored.
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

/** Shared prompt assembly for a primary request and a cold compaction before its first send. */
export async function assembleRequestPrefix(
  s: SessionImpl,
  ctx: OpContext,
  triggerSeq: number,
): Promise<{
  merged: Merged
  disclosed: DeriveInput['disclosed']
  additionalContext: string
  untrustedContext: string
  preloaded: RuntimePromptPreload | null
  memoryRevision?: string
}> {
  const t = s.turn
  if (!t) throw new CoreError('E_RELATION', 'request prefix outside an active turn')
  const contribs: Contribution[] = [
    { op: 'core', tools: [...ctx.disclosed] },
    ...s.d.operations
      .filter((o) => o.contribute)
      .map((o) => ({ op: o.name, ...(o.contribute as NonNullable<typeof o.contribute>)(ctx) })),
  ]
  const deferred = deferredToolsSection(ctx.snapshot.defs)
  if (deferred) contribs.push({ op: 'core:deferred-tools', promptSections: [deferred] })
  const memory = await s.d.memory?.snapshot(ctx.state?.meta.turn ?? 0)
  if (memory) {
    if (!(await s.d.log.scan({ type: 'x/core/memory-private', limit: 1 })).length)
      await s.d.log.append([s.ev('x/core/memory-private', { files: 1 }, { ignorable: true })])
    // A file changed outside the provider (e.g. by an unconfined shell) is still injected; say so.
    if (memory.externalChanges?.length)
      await s.diag('memory-external-change', { paths: [...memory.externalChanges] })
    contribs.push({
      op: 'memory',
      promptSections: [
        { id: 'memory:index', order: 131, source: 'memory', text: memory.content, delivery: 'live-note' },
      ],
    })
  }
  const receipts = await childReceiptNarrative(s)
  if (receipts)
    contribs.push({
      op: 'child-receipts',
      promptSections: [
        { id: 'core:child-receipts', order: 112, source: 'core', text: receipts, delivery: 'live-note' },
      ],
    })
  // A live note rather than a stable section: it changes with each turn's trigger, so the system
  // prompt stays cacheable and an attended turn after it clears the note instead of rebuilding.
  if (isUnattended(t))
    contribs.push({
      op: 'core:unattended',
      promptSections: [
        {
          id: 'core:unattended-run',
          order: 116,
          source: 'core',
          text: UNATTENDED_NOTE,
          delivery: 'live-note',
        },
      ],
    })
  // Limits the turn runs under (time, steps, a prompt's credit cap), and how much of the nearest is
  // used: a live note for the same reason as above, re-sent only when it crosses a threshold.
  const limits = turnLimitSection(s, t)
  if (limits) contribs.push({ op: 'core:turn-limits', promptSections: [limits] })
  const merged = mergeContributions(contribs, t.snapshot)
  for (const conflict of merged.conflicts) await s.diag('contribute-conflict', conflict)
  if (t.preload === undefined) t.preload = (await preloadRuntimeSection(s, triggerSeq)) ?? null
  const preloaded = t.preload
  const permitted = new Set(ctx.disclosed)
  merged.tools = merged.tools.filter((name) => permitted.has(name))
  // Cache ordinary context hooks for identical assembly inputs; opted-in contributors refresh. Current-prompt
  // matching and the selected Skill body remain Host-private until their note lands.
  const prefixKey = canonicalJson([
    ctx.model.route,
    ctx.model.model,
    s.preset.name,
    s.preset.disclosure,
    t.snapshot.hash,
    sha256Hex(canonicalJson(merged.sections)),
  ])
  const hookContext =
    t.prefix?.key === prefixKey
      ? s.hooks.refreshContext
        ? await s.hooks.refreshContext(merged.sections)
        : structuredClone({
            sections: t.prefix.sections,
            additionalContext: t.prefix.additionalContext,
            untrustedContext: t.prefix.untrustedContext,
          })
      : await s.hooks.context(merged.sections)
  t.prefix = { key: prefixKey, ...structuredClone(hookContext) }
  merged.sections = hookContext.sections
  if (
    !s.computerUseAllowed({ route: ctx.model.route, model: ctx.model.model }) &&
    t.snapshot.byName.has('computer_use')
  )
    merged.sections.push({
      id: 'core:computer-use-model',
      order: 111,
      source: 'core',
      text: 'Computer Use is configured but is not offered to this model: its capability record does not include image input. For desktop-control requests, explain that the user needs to select a model that supports images. This model restriction does not mean that the desktop driver is missing or broken.',
    })
  const disclosed = merged.tools.flatMap((name) => {
    const def = t.snapshot.byName.get(name)
    return def ? [def] : []
  })
  return {
    merged,
    disclosed,
    additionalContext: hookContext.additionalContext,
    untrustedContext: hookContext.untrustedContext,
    preloaded,
    ...(memory ? { memoryRevision: memory.revision } : {}),
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
  if (
    slot === 'compaction' &&
    s.preset.model.route.compaction === undefined &&
    s.preset.model.id.compaction === undefined
  )
    return resolveModel(s, 'primary')
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
  const eager = (): string[] =>
    snap.defs
      .filter(
        (d) => modelVisibleTool(d, true) && (d.meta.deferLoading !== true || loadedToolNames(s).has(d.name)),
      )
      .map((d) => d.name)
  return eager().filter((name) => !toolArgumentsDisabled(s, name) && !disclosureRestriction(s, { name }))
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
    // A nested call (a tool's own `ctx.tools.invoke`) was never asked for by the model.
    if (isNestedCall(row.data)) continue
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

export async function prepareInferenceRequest(
  s: SessionImpl,
  options: import('@agnes/extension-api').LoopRequestOptions = {},
): Promise<DeriveOutput | StepOutcome> {
  const op = s.op()
  const t = s.turn
  if (!op || !t) throw new CoreError('E_RELATION', 'Request preparation requires an accepted input')
  const tailNote = loopTailNote(options)
  await restoreToolDisclosure(s)
  await restoreToolArgumentRecovery(s)
  const attempt = op.phase.kind === 'inference' ? op.phase.gen.attempt : 0
  const step = op.step + 1
  const slot = options.slot ?? 'primary'
  const target = resolveModel(s, slot)
  // Computer Use depends on the primary model seeing each returned screenshot itself. An
  // auxiliary image model cannot safely steer the primary model's next pointer/keyboard action,
  // so withhold the tool unless this exact primary model advertises native image input. Unknown,
  // duplicate, or malformed catalogue entries resolve to text-only above and therefore fail closed.
  const inlineImageModel = resolvedModelRecord(s.d.provider, target)
  const modelInput = inlineImageModel?.input ?? (['text'] as const)
  const computerUseAllowed = supportsComputerUse(modelInput)
  // Freeze the selected model's contract before asynchronous contribution hooks can run.
  const contract = Object.freeze({ ...(s.d.contractForModel?.(target) ?? s.d.contract) })
  const coreTools = toolNamesForModel(
    (options.tools ? [...options.tools] : discloseTools(s)).filter((name) => !toolArgumentsDisabled(s, name)),
    t.snapshot,
    computerUseAllowed,
  )
  if (coreTools.some((name) => !t.snapshot.byName.has(name)))
    throw new CoreError('E_ENVELOPE', 'Request names a tool outside the frozen turn catalog')
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
  const { merged, disclosed, additionalContext, untrustedContext, preloaded, memoryRevision } =
    await assembleRequestPrefix(s, ctx, op.meta.triggerSeq)
  // A loop's own message list is not the ledger surface, so a row written for it would never be read.
  if (!options.messages) await appendHookData(s, untrustedContext)
  const { surface, imageIndices } = await attachmentSurface(s, loopRequestHistory(s, merged, options))
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
            surface: inlineImageMediaSurface(surface),
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
  // Measured now, as late as assembly allows, so the figure is as fresh as the request.
  const turnTime = turnTimeNote(s, t)
  const progressCheck = await progressCheckNote(s, t, op)
  let out = deriveRequest({
    ...(memoryRevision === undefined ? {} : { memoryRevision }),
    ...(s.d.systemPrompt ? { systemPrompt: s.d.systemPrompt } : {}),
    kind: 'turn',
    inlineImages: {
      model: inlineImageModel,
      selectedImageIndices: imageIndices,
      canRead: Boolean(s.d.requestMedia && disclosed.some((tool) => tool.name === 'read')),
    },
    merged,
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
    notes: [
      { prefix: HOOK_CONTEXT_PREFIX, text: additionalContext, dedup: { kind: 'latest' } },
      // Empty in a turn without a time limit, which marks an earlier turn's figure as no longer current.
      { prefix: TURN_TIME_PREFIX, text: turnTime ?? '', dedup: { kind: 'latest' } },
      ...(progressCheck ? [progressCheck] : []),
      ...(preloaded
        ? [
            {
              prefix: SKILL_LOADED_PREFIX,
              text: `${preloaded.key}\n${preloaded.note}`,
              dedup: { kind: 'present' as const, key: preloaded.key },
            },
          ]
        : []),
    ],
    ...(requestMedia ? { media: requestMedia, mediaSessionKey: s.key } : {}),
    ...(auxiliaryVision ? { auxiliaryVision } : {}),
    ...(tailNote ? { tailNote } : {}),
  })
  if (attachmentOmittedThrough(s)) out.header.attachmentImagesOmittedThrough = attachmentOmittedThrough(s)
  if (slot === 'primary' && s.preset.model.maxTokens !== undefined) {
    const { request, derivedHash } = remintRequestWithMaxTokens(
      out.request,
      out.media,
      s.preset.model.maxTokens,
    )
    out = { ...out, request, header: { ...out.header, derived_hash: derivedHash } }
  }
  out = await beforeLoopModelRequest(s, withLoopSampling(out, options), slot, attempt)
  prepareToolAvailability(out, {
    imageInput: computerUseAllowed,
    defaultSelection: options.tools === undefined,
  })
  return out
}

/** Shared request admission, including image bounds, tree reservations and overage disposition. */
export async function admitInferenceRequest(
  s: SessionImpl,
  initial: DeriveOutput,
  projectPreparedWire = false,
): Promise<
  | { output: DeriveOutput; wire: WireBody; calibration: Awaited<ReturnType<typeof countCalibration>> }
  | StepOutcome
> {
  let out: DeriveOutput = initial
  const slot = out.request.model.slot
  const target = { route: out.request.model.route, model: out.request.model.model }
  let wire = toProviderRequest(out.request, {
    sessionKey: s.key,
    derivedHash: out.header.derived_hash,
    compactionBoundary: s.d.surface
      .nodes()
      .findLast((node) => node.masked && out.request.messages.some((message) => message.seq === node.seq))
      ?.masked?.end,
  })
  const contextError = contextBudgetError(s, slot, { system: wire.system, tools: wire.tools })
  if (contextError) {
    await s.endTurn('budget', { error: contextError })
    return { phase: 'terminal', reason: 'budget' }
  }
  const estimate = projectPreparedWire
    ? estimateTokens(canonicalJson({ system: wire.system, messages: wire.messages, tools: wire.tools }))
    : ((s.latest('budget.state') as BudgetState | undefined)?.lastPreflight?.tokens ?? 0)
  // A custom loop can replace messages, prompts or model slots after step admission. Recheck
  // its complete prepared wire so a tiny inbox prompt cannot authorize a large private request.
  const cap = s.turnBudgetCap()
  if (projectPreparedWire && cap !== null) {
    const projected = await s.d.runtime.billingProjected({ tokensEstimate: estimate, model: target.model })
    if (projected.credits > cap) {
      if (s.turn?.hardBudgetCap !== undefined || s.preset.budget.onExceed === 'deny') {
        await s.endTurn('budget')
        return { phase: 'terminal', reason: 'budget' }
      }
      const quote = await quoteBudget(
        s,
        `prepared request estimated ${projected.credits} credits > cap ${cap}`,
      )
      if (quote !== 'ok') return { phase: 'terminal', reason: quote.reason }
    }
  }
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
    const projected = await s.d.runtime.billingProjected({
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
        toProviderRequest(out.request, {
          sessionKey: s.key,
          derivedHash: out.header.derived_hash,
          compactionBoundary: s.d.surface
            .nodes()
            .findLast(
              (node) => node.masked && out.request.messages.some((message) => message.seq === node.seq),
            )?.masked?.end,
        }),
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
    if (s.turn?.hardBudgetCap !== undefined || s.preset.budget.onExceed === 'deny') {
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
  bindToolAvailability(initial, wire)
  return { output: out, wire, calibration: cal }
}

export async function runInference(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op()
  const t = s.turn
  if (!op || !t) return { phase: 'idle' }
  const admission = await builtinBudgetPreflight(s, true)
  if (admission !== 'ok') return { phase: 'terminal', reason: admission.reason }

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
  const hooked = await beforeStepGate(s, step)
  if (hooked !== 'ok') return hooked
  const attempt = op.phase.kind === 'inference' ? op.phase.gen.attempt : 0
  // Both computed before the contributions rather than after them, because an operation writing a
  // prompt section about this request has to describe the request that is actually sent. Recomputing
  // either one downstream would let the two answers drift, and the drift would read as a prompt that
  // names a model the turn did not go to or a tool the model was never offered.
  const slot = 'primary'
  const target = resolveModel(s, slot)
  const preparedOutput = await prepareInferenceRequest(s)
  if ('phase' in preparedOutput) return preparedOutput
  let out: DeriveOutput = preparedOutput
  const ctx: OpContext = {
    session: s,
    preset: s.preset,
    state: op,
    snapshot: toolsForModel(t.snapshot, s.computerUseAllowed(target)),
    signal: s.ac.signal,
    disclosed: out.request.tools.map((tool) => tool.name),
    model: { slot, ...target },
  }
  const memoryRevision = requestMemoryRevision(out.request)
  const mintedPrefix = {
    ...(memoryRevision === undefined ? {} : { memoryRevision }),
    sections: out.request.sections,
    tools: out.request.tools,
    model: out.request.model,
    ...(out.request.samplingParams ? { samplingParams: out.request.samplingParams } : {}),
  }
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
  const admitted = await admitInferenceRequest(s, out)
  if ('phase' in admitted) return admitted
  out = admitted.output
  const wire = admitted.wire
  const cal = admitted.calibration
  const offered = new Set(wire.tools.map((tool) => tool.name))
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
      ...out.notes,
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

  const sessionSignal = s.ac.signal
  const execution = new ModelExecution(s, {
    wire,
    header,
    effect,
    headerSeq,
    intentSeq: effectIntentSeq,
    signal: sessionSignal,
    context: ctx,
    turnId: op.meta.turn,
    step,
    memory: t,
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
  // A failed output flush interrupts the shared Core transport, even if the provider ignores abort.
  const streamAbort = execution.controller
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
    streamAbort.abort(sessionSignal.reason)
  }
  if (sessionSignal.aborted) onSessionAbort()
  else sessionSignal.addEventListener('abort', onSessionAbort, { once: true })
  const calls: Array<{ name: string; args: unknown; via: string }> = []
  const deviations: EventInput[] = []
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
      parserVersion: out.header.parser_version,
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
        // Streaming writes report to flushQueue; per-delta diagnostics would duplicate that failure.
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
      })
    }, CHUNK_FLUSH_MS)
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
    for await (const ev of execution.stream()) {
      if (ev.type === 'sent') {
        t.lastPrefix = mintedPrefix
        sentWritten = true
      } else if (ev.type === 'text_delta') {
        text += ev.delta
        await emit('text', ev.delta)
      } else if (ev.type === 'thinking_delta') {
        thinking += ev.delta
        await emit('thinking', ev.delta)
      } else if (ev.type === 'toolcall_end') {
        calls.push({ name: ev.call.name, args: ev.call.args, via: ev.via })
        if (ev.via !== 'native')
          deviations.push(
            deviation(ev.via, sha256Hex(canonicalJson({ name: ev.call.name, args: ev.call.args }))),
          )
      } else if (ev.type === 'deviation') {
        unparsed = true
        deviations.push(deviation('unparsed', ev.sampleHash))
      } else if (ev.type === 'done') done = ev
      else if (ev.type === 'error') {
        error = ev
        break
      }
    }
  } catch (err) {
    cancelFlushTimer()
    error = {
      type: 'error',
      reason: sessionSignal.aborted ? 'aborted' : 'error',
      code: sessionSignal.aborted ? 'ABORTED' : 'TRANSPORT',
      message: err instanceof Error ? err.message : String(err),
      retryable: !sessionSignal.aborted,
    }
  }
  // The listener stays until the settling rows are admitted: a close that lands after the stream
  // has ended but before the settlement is written would otherwise take the whole text with it.
  const settle = async (): Promise<StepOutcome> => {
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
        await execution.commit(
          [...execution.rows('aborted', true), stepEnd()],
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
        await execution.commit(
          [...execution.rows('error', true), stepEnd()],
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
        await execution.commit(
          [...execution.rows('error', true), stepEnd()],
          withPhase(cur, {
            kind: 'inference',
            gen: { status: 'retry_wait', attempt: attempt + 1, notBefore, code: error.code },
          }),
        )
        return { phase: 'inference' }
      }
      await execution.commit(
        [...execution.rows('error', true), stepEnd()],
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
      ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ]
    const stopReason = truncated ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn'
    await s.loopEvents.dispatch(
      'after_model_response',
      { content, stopReason },
      loopEventContext(s, sessionSignal),
    )
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
        const { refusal, policy, events: validationEvents } = checkModelToolCall(s, c, offered, toolUseId)
        refusedCalls.push(...validationEvents)
        events.push(
          s.ev(
            'tool/call',
            toolCallPayload(
              { toolUseId, name: c.name, args: c.args, ordinal },
              t.snapshot.byName.get(c.name)?.meta.presentation,
              policy,
            ),
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
    events.push(...refusedCalls, ...deviations, ...execution.rows('ok', false))
    if (truncated || unparsed)
      events.push(
        s.ev('user/message', {
          content: [
            {
              type: 'text',
              text: truncated
                ? 'Output limit reached; this turn stopped and its unfinished tool calls were discarded. Continue with smaller tool calls and build large files incrementally, or configure a higher request output allowance.'
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
    await execution.commit(events, (curOp, nextSeq) => {
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
            truncated
              ? {
                  kind: 'failure_drain',
                  error: {
                    code: 'OUTPUT_LIMIT',
                    message:
                      'Model output limit reached. Use smaller requests or increase model.max_tokens before continuing.',
                  },
                  provenance: { kind: 'inference' },
                }
              : {
                  kind: 'checkpoint',
                  continuation: unparsed ? 'need_assistant' : 'may_finish',
                  triggerSeq: op.meta.triggerSeq,
                },
            { latestAssistantSeq: assistantSeq },
          )
    })
    return { phase: planned.length ? 'tools' : truncated ? 'failure_drain' : 'checkpoint' }
  }
  let settlement: { ok: true; result: StepOutcome } | { ok: false; error: unknown }
  try {
    settlement = { ok: true, result: await settle() }
  } catch (error) {
    settlement = { ok: false, error }
  } finally {
    sessionSignal.removeEventListener('abort', onSessionAbort)
  }
  if (!execution.settled) {
    try {
      await execution.commit(execution.rows(execution.outcome, execution.outcome !== 'ok'), (cur) => cur)
    } catch (error) {
      // Preserve the original failure if both settlement and its fallback fail.
      if (settlement.ok) throw error
    }
  }
  if (!settlement.ok) throw settlement.error
  return settlement.result
}
