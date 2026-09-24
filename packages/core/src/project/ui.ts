import {
  type ApprovalAsked,
  type ApprovalDecided,
  type ArtifactJob,
  type AssistantMessage,
  type AssistantOutput,
  type CostLedger,
  type EffectIntent,
  type EffectSettled,
  isEventType,
  normalize,
  type OpState,
  type SlotFillView,
  type ThinkingLevel,
  type ToolCall,
  type ToolResult,
  UI_SLOT_MAX_BYTES,
  UI_SLOT_TABLE,
  type UINode,
  type UIProjectionNodeChange,
  type UIProjectionTurnChange,
  type UITimeline,
  type UITimelinePatch,
  type UITurn,
  type UsageView,
  type UserMessage,
  validateAgainst,
  validateSlotPayload,
} from '@agnes/protocol'
import { SlotFillView as SlotFillSchema } from '@agnes/protocol/gen/agnes-v1'
import { reduce } from '../reduce/reducer.js'
import { initialState, type LedgerState } from '../reduce/state.js'
import type { Conflict, ContextBreakdownDiag } from '../request/contribute.js'
import { canonicalJson } from '../request/hash.js'
import { CoreError, type Event, type Seq } from '../types.js'
import {
  applyCacheHealthEvent,
  type CacheHealthState,
  cacheHealthView,
  initialCacheHealthState,
} from './cache-health.js'
import { clipUtf16 as clip } from './clip.js'
import { SurfaceCache } from './surface.js'
import { TurnProjection, turnsForNodes } from './turns.js'

/** Generation belongs to the daemon's writer ownership, not to a core ledger projection. */
export type CoreUITimeline = Omit<UITimeline, 'generation'>
export type SlotFill = SlotFillView
export type SlotTrigger = { kind: 'tool_result'; toolUseId: string } | { kind: 'turn_end' } | { kind: 'tick' }
/** The host supplies its bounded extension runner; core filters its output for this surface. */
export type SlotFillRunner = (surface: 'tui' | 'web' | 'channel', trigger: SlotTrigger) => Promise<SlotFill[]>
export type UIOptions = {
  sessionKey: string
  /** The program counter's live value, when the projection is taken at the head it belongs to. */
  op?: OpState
  upto?: Seq
  /** Exclusive watermark: the first applied event must have seq `afterSeq + 1`. */
  afterSeq?: Seq
  lane?: string
  surface?: 'tui' | 'web' | 'channel'
  fills?: SlotFillRunner
  usage?: UsageView
}

export type CoreUITimelinePatch = Omit<UITimelinePatch, 'generation'>
export type CoreUIProjectionUpdate =
  | { kind: 'patch'; patch: CoreUITimelinePatch }
  | { kind: 'replace'; timeline: CoreUITimeline }
export type CoreUIOpeningResult = {
  timeline: CoreUITimeline
  hasEarlier: boolean
  startIndex: number
  totalNodes: number
}
export type CoreUIHistoryPage = {
  sessionId: string
  cut: Seq
  nodes: UINode[]
  turns: UITurn[]
  hasEarlier: boolean
  startIndex: number
  totalNodes: number
}
export type UIProjectionUsageOptions = {
  route: string
  model: { id: string; contextWindow: number; maxTokens?: number }
  thinking: ThinkingLevel
  autoCompact: boolean
}

type ToolNode = Extract<UINode, { kind: 'tool' }>
type AssistantNode = Extract<UINode, { kind: 'assistant' }>
type ApprovalNode = Extract<UINode, { kind: 'approval' }>
const text = (blocks: ReadonlyArray<{ type: string; text?: string }>, kind = 'text') =>
  blocks
    .filter((block) => block.type === kind)
    .map((block) => block.text ?? '')
    .join('')

type JournalEntry = {
  seq: Seq
  changes: UIProjectionNodeChange[]
  turnChanges: UIProjectionTurnChange[]
  bytes: number
}
const DEFAULT_JOURNAL_EVENTS = 2048
const DEFAULT_JOURNAL_BYTES = 4 * 1024 * 1024
const encoder = new TextEncoder()
type BoundedNodePage = {
  nodes: UINode[]
  hasEarlier: boolean
  startIndex: number
  totalNodes: number
}

/**
 * Selects a backwards page without cloning the full timeline. Nodes are indivisible protocol
 * values: an individually oversized node is returned alone so the transport can explicitly reject
 * it instead of silently skipping history or returning an empty, non-advancing page.
 */
export const boundedTimelinePage = (
  source: readonly UINode[],
  beforeIndex: number,
  maxNodes: number,
  maxBytes: number,
  extraBytes?: (node: UINode) => number,
): BoundedNodePage => {
  const totalNodes = source.length
  const end = Math.min(beforeIndex, totalNodes)
  let start = end
  let bytes = 2 // JSON array brackets
  while (start > 0 && end - start < maxNodes) {
    const next = source[start - 1]
    if (!next) break
    const nextBytes =
      encoder.encode(JSON.stringify(next)).byteLength + (start < end ? 1 : 0) + (extraBytes?.(next) ?? 0)
    if (start < end && bytes + nextBytes > maxBytes) break
    bytes += nextBytes
    start -= 1
  }
  return {
    nodes: source.slice(start, end).map((node) => structuredClone(node)),
    hasEarlier: start > 0,
    startIndex: start,
    totalNodes,
  }
}

/**
 * Page bytes for the turns a node brings into a page the first time, as a paging `extraBytes`.
 * Call it on nodes in paging order; each turn is charged once, by the given byte count.
 */
export const turnCharge = (
  turns: readonly UITurn[],
  turnBytes: (turn: UITurn) => number,
): ((node: UINode) => number) => {
  const byNode = new Map<string, UITurn[]>()
  for (const turn of turns)
    for (const id of turn.nodeIds) {
      const owners = byNode.get(id)
      if (owners) owners.push(turn)
      else byNode.set(id, [turn])
    }
  const charged = new Set<string>()
  return (node) => {
    let extra = 0
    for (const turn of byNode.get(node.id) ?? []) {
      if (charged.has(turn.id)) continue
      // The first turn brings the array brackets, each later one a comma.
      extra += (charged.size === 0 ? 2 : 1) + turnBytes(turn)
      charged.add(turn.id)
    }
    return extra
  }
}
const emptyTotals = (): UsageView['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})
const estimatedContentTokens = (event: Event): number => {
  const blocks = (event.data as { content?: Array<{ text?: string }> } | null)?.content ?? []
  return blocks.reduce((total, block) => total + Math.ceil((block.text ?? '').length / 4), 0)
}

let markIncompleteImpl: (cell: UIProjectionCell) => void

/**
 * The session-live form of the built-in UI projection. Opening a session replays the
 * committed ledger through this cell once; every later append applies exactly once at the log's
 * post-commit callback. The bounded journal is an optimization only: a cursor older than its floor
 * gets a full authoritative replacement from SessionImpl.
 */
export class UIProjectionCell {
  #complete = true

  static {
    markIncompleteImpl = (cell) => {
      cell.#complete = false
    }
  }

  /** False for a cell that starts after rows it never saw: it cannot stand in for a full replay. */
  get complete(): boolean {
    return this.#complete
  }
  private state: LedgerState = initialState()
  private readonly nodes: UINode[] = []
  private readonly nodeIndexes = new Map<string, number>()
  private readonly tools = new Map<string, ToolNode>()
  private readonly approvals = new Map<string, ApprovalNode>()
  private readonly approvalTools = new Map<string, string>()
  private readonly effectTools = new Map<string, string>()
  private readonly assistantEffects = new Map<string, AssistantNode>()
  // What each running inference has said so far by count, and which ones kept their text when cut.
  // The text itself never reaches this cell while streaming; only a cut stream records it.
  private readonly outputChars = new Map<string, number>()
  private readonly keptOutput = new Set<string>()
  private readonly completedResults: Array<{ seq: Seq; toolUseId: string }> = []
  private readonly turnEnds: Seq[] = []
  private activeInference: string | undefined
  private turn = 0
  private step = 0
  // The program counter's value from the register, once told. Until then the running operation
  // is inferred from the ledger alone, which is all a projection of a past cut has.
  private op: OpState | undefined = undefined

  private readonly usageTotals = emptyTotals()
  private readonly seenCostEffects = new Set<string>()
  private usageCredits = 0
  private hasCredits = false
  private creditsComplete = true
  private creditsGateway = true
  private usageUsdMicros = 0
  private hasBilling = false
  private incompleteBilling = false
  private reasoningComplete = true
  private allGateway = true
  private allSubscription = true
  private readonly contextSurface: SurfaceCache
  private contextBase: { seq: Seq; total: number } | undefined
  private contextTokensValue = 0
  private readonly turnsProjection = new TurnProjection()
  private cacheHealth: CacheHealthState = initialCacheHealthState()

  private recording = false
  private journal: JournalEntry[] = []
  private journalBytes = 0
  private journalFloor = 0
  private applied = 0
  private readonly maxJournalEvents: number
  private readonly maxJournalBytes: number

  constructor(
    private readonly sessionKey: string,
    private readonly lane = 'main',
    limits: { maxEvents?: number; maxBytes?: number } = {},
  ) {
    this.contextSurface = new SurfaceCache(lane)
    this.maxJournalEvents = limits.maxEvents ?? DEFAULT_JOURNAL_EVENTS
    this.maxJournalBytes = limits.maxBytes ?? DEFAULT_JOURNAL_BYTES
  }

  get upto(): Seq {
    return this.state.lastSeq
  }

  apply(events: readonly Event[]): void {
    for (const raw of events) this.applyOne(raw)
  }

  /** Set the exclusive seq watermark before any rows are applied (child ledgers start after a fork). */
  startAfter(seq: Seq): void {
    if (this.applied !== 0) throw new TypeError('UI projection watermark can only be set before apply')
    if (!Number.isSafeInteger(seq) || seq < 0)
      throw new CoreError('E_ENVELOPE', 'UI afterSeq must be a nonnegative safe sequence number')
    this.state = { ...this.state, lastSeq: seq }
  }

  /** Tells the cell the program counter's current value; `null` means no operation is open. */
  setOp(op: OpState): void {
    this.op = op
  }

  /** Initial replay must not consume the live change budget or pretend old rows are fresh deltas. */
  sealReplay(): void {
    this.recording = true
    this.journal = []
    this.journalBytes = 0
    this.journalFloor = this.upto
  }

  diagnostics(): { applied: number; floor: number; entries: number; bytes: number } {
    return {
      applied: this.applied,
      floor: this.journalFloor,
      entries: this.journal.length,
      bytes: this.journalBytes,
    }
  }

  usage(options: UIProjectionUsageOptions): UsageView {
    const cost: UsageView['cost'] = this.hasBilling
      ? {
          usdMicros: Math.max(0, this.usageUsdMicros),
          source: this.allGateway && !this.incompleteBilling ? 'gateway' : 'estimated',
          subscription: this.allSubscription,
        }
      : undefined
    return {
      totals: { ...this.usageTotals },
      ...(this.hasCredits
        ? {
            credits: {
              amount: Math.max(0, this.usageCredits),
              source:
                this.creditsGateway && this.creditsComplete ? ('gateway' as const) : ('estimated' as const),
              complete: this.creditsComplete,
            },
          }
        : {}),
      reasoningComplete: this.seenCostEffects.size > 0 && this.reasoningComplete,
      billingComplete: this.hasBilling && !this.incompleteBilling,
      ...(cost ? { cost } : {}),
      context: {
        source: 'estimated',
        tokens: this.contextTokensValue,
        window: options.model.contextWindow,
        autoCompact: options.autoCompact,
      },
      model: {
        route: options.route,
        id: options.model.id,
        thinking: options.thinking,
        ...(options.model.maxTokens ? { maxTokens: options.model.maxTokens } : {}),
      },
      ...(Object.keys(cacheHealthView(this.cacheHealth)).length > 0
        ? { cache: cacheHealthView(this.cacheHealth) }
        : {}),
    }
  }

  async view(opts: Pick<UIOptions, 'surface' | 'fills' | 'usage'> = {}): Promise<CoreUITimeline> {
    const nodes = structuredClone(this.nodes)
    const tools = new Map(
      nodes.filter((node): node is ToolNode => node.kind === 'tool').map((node) => [node.toolUseId, node]),
    )
    if (opts.surface && opts.fills) {
      const surface = opts.surface
      const fill = async (trigger: SlotTrigger, seq: Seq, tool?: ToolNode) => {
        let results: SlotFill[]
        try {
          results = (await opts.fills?.(surface, trigger)) ?? []
        } catch {
          return
        }
        if (!Array.isArray(results)) return
        for (const [index, result] of results.entries()) {
          try {
            if (!validateAgainst(SlotFillSchema, result).ok) continue
            const row = UI_SLOT_TABLE[result.slot]
            if (!row?.surfaces.includes(surface) || !row.trigger.includes(trigger.kind)) continue
            if (!validateSlotPayload(result.slot, result.payload).ok) continue
            if (encoder.encode(JSON.stringify(result.payload)).byteLength > UI_SLOT_MAX_BYTES) continue
            const copy = structuredClone(result)
            if (result.slot === 'tool.card.inline' && tool) {
              tool.slots ??= []
              tool.slots.push(copy)
            } else {
              nodes.push({
                kind: 'slot',
                id: `${seq}#${result.slot}#${result.extId}#${index}`,
                seq,
                fill: copy,
              })
            }
          } catch {
            // Malformed extension output is discarded under the UI slots' open failure policy.
          }
        }
      }
      for (const trigger of this.completedResults)
        await fill(
          { kind: 'tool_result', toolUseId: trigger.toolUseId },
          trigger.seq,
          tools.get(trigger.toolUseId),
        )
      for (const seq of this.turnEnds) await fill({ kind: 'turn_end' }, seq)
      await fill({ kind: 'tick' }, this.upto)
    }
    nodes.sort((a, b) => (a.seq ?? this.upto) - (b.seq ?? this.upto))
    return this.timeline(nodes, opts.usage)
  }

  /** The live turn list, not a copy; callers only read it. */
  get turnList(): readonly UITurn[] {
    return this.turnsProjection.turns
  }

  /**
   * Returns the live tail without first cloning every retained node. Dynamic extension fills are
   * the one deliberate slow path because their synthesized nodes do not exist in the cell; daemon
   * opening calls never provide a fill runner.
   */
  async opening(
    opts: Pick<UIOptions, 'surface' | 'fills' | 'usage'> & {
      maxNodes: number
      maxBytes: number
      /** Bytes a turn adds to the page when a node first brings it in; turns are free when absent. */
      turnBytes?: (turn: UITurn) => number
    },
  ): Promise<CoreUIOpeningResult> {
    if (opts.fills) {
      const full = await this.view(opts)
      const page = boundedTimelinePage(
        full.nodes,
        full.nodes.length,
        opts.maxNodes,
        opts.maxBytes,
        opts.turnBytes && turnCharge(full.turns, opts.turnBytes),
      )
      return {
        timeline: { ...full, nodes: page.nodes, turns: turnsForNodes(full.turns, page.nodes) },
        hasEarlier: page.hasEarlier,
        startIndex: page.startIndex,
        totalNodes: page.totalNodes,
      }
    }
    const page = boundedTimelinePage(
      this.nodes,
      this.nodes.length,
      opts.maxNodes,
      opts.maxBytes,
      opts.turnBytes && turnCharge(this.turnsProjection.turns, opts.turnBytes),
    )
    return {
      timeline: this.timeline(page.nodes, opts.usage, turnsForNodes(this.turnsProjection.turns, page.nodes)),
      hasEarlier: page.hasEarlier,
      startIndex: page.startIndex,
      totalNodes: page.totalNodes,
    }
  }

  /** A page ending at an exclusive, full-timeline node index. Returned nodes remain ascending. */
  history(
    cut: Seq,
    beforeIndex: number,
    maxNodes: number,
    maxBytes: number,
    turnBytes?: (turn: UITurn) => number,
  ): CoreUIHistoryPage {
    const page = boundedTimelinePage(
      this.nodes,
      beforeIndex,
      maxNodes,
      maxBytes,
      turnBytes && turnCharge(this.turnsProjection.turns, turnBytes),
    )
    return {
      sessionId: this.sessionKey,
      cut,
      ...page,
      turns: turnsForNodes(this.turnsProjection.turns, page.nodes, false),
    }
  }

  /** Returns null when the caller's baseline fell below the bounded live journal floor. */
  journalPatch(after: Seq, usage?: UsageView): CoreUITimelinePatch | null {
    if (!Number.isSafeInteger(after) || after < this.journalFloor || after > this.upto) return null
    const entries = this.journal.filter((entry) => entry.seq > after)
    if (after < this.upto) {
      let expected = after + 1
      for (const entry of entries) {
        if (entry.seq !== expected) return null
        expected += 1
      }
      if (expected !== this.upto + 1) return null
    }
    const latest = new Map<string, UIProjectionNodeChange>()
    const latestTurns = new Map<string, UIProjectionTurnChange>()
    for (const entry of entries)
      for (const change of entry.changes)
        latest.set(change.op === 'remove' ? change.id : change.node.id, structuredClone(change))
    for (const entry of entries)
      for (const change of entry.turnChanges)
        latestTurns.set(change.op === 'remove' ? change.id : change.turn.id, structuredClone(change))
    const removals = [...latest.values()].filter(
      (change): change is Extract<UIProjectionNodeChange, { op: 'remove' }> => change.op === 'remove',
    )
    const upserts = [...latest.values()]
      .filter((change): change is Extract<UIProjectionNodeChange, { op: 'upsert' }> => change.op === 'upsert')
      .sort((a, b) => a.index - b.index)
    const turnRemovals = [...latestTurns.values()].filter(
      (change): change is Extract<UIProjectionTurnChange, { op: 'remove' }> => change.op === 'remove',
    )
    const turnUpserts = [...latestTurns.values()]
      .filter((change): change is Extract<UIProjectionTurnChange, { op: 'upsert' }> => change.op === 'upsert')
      .sort((a, b) => a.index - b.index)
    const meta = this.metadata()
    return {
      sessionId: this.sessionKey,
      from: after,
      upto: this.upto,
      totalNodes: this.nodes.length,
      opState: meta.opState,
      changes: [...removals, ...upserts],
      turnChanges: [...turnRemovals, ...turnUpserts],
      ...(meta.budget ? { budget: meta.budget } : {}),
      ...(usage ? { usage: structuredClone(usage) } : {}),
    }
  }

  private applyOne(raw: Event): void {
    if (raw.seq !== this.upto + 1)
      throw new CoreError('E_STORAGE_FAULT', 'UI projection cell received a non-contiguous ledger', {
        expectedSeq: this.upto + 1,
        actualSeq: raw.seq,
      })
    const event = isEventType(raw.type) ? normalize(raw) : raw
    const nextState = reduce(this.state, event)
    this.applyUsage(event)
    const isForkBoundary =
      event.type === 'session/start' && (event.data as { parent?: unknown } | null)?.parent !== undefined
    const turnUpdate =
      isForkBoundary || (event.lane ?? 'main') === this.lane
        ? this.turnsProjection.apply(event)
        : { changed: new Set<string>(), owner: undefined }
    const changed = this.applyNode(event)
    for (const id of this.turnsProjection.associate(event, changed, turnUpdate.owner))
      turnUpdate.changed.add(id)
    this.state = nextState
    this.applied += 1
    if (this.recording) this.record(event.seq, changed, turnUpdate.changed)
  }

  private applyUsage(event: Event): void {
    this.cacheHealth = applyCacheHealthEvent(this.cacheHealth, event, this.lane)
    this.contextSurface.push([event])
    if (event.type === 'session/start' && (event.data as { parent?: unknown } | null)?.parent) {
      Object.assign(this.usageTotals, emptyTotals())
      this.seenCostEffects.clear()
      this.usageCredits = 0
      this.hasCredits = false
      this.creditsComplete = true
      this.creditsGateway = true
      this.usageUsdMicros = 0
      this.hasBilling = false
      this.incompleteBilling = false
      this.reasoningComplete = true
      this.allGateway = true
      this.allSubscription = true
      return
    }
    if ((event.lane ?? 'main') !== this.lane) return
    if (event.type === 'cost/ledger') {
      const row = event.data as CostLedger
      if (
        row.purpose !== 'title' &&
        row.purpose !== 'approval-guardian' &&
        row.purpose !== 'media' &&
        !row.interrupted &&
        !row.adjustment
      ) {
        this.contextBase = {
          seq: event.seq,
          total: row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite,
        }
        this.contextTokensValue = this.contextBase.total
      }
      if (this.seenCostEffects.has(row.effectId)) return
      this.seenCostEffects.add(row.effectId)
      if (row.adjustment) {
        const boundary = this.state.session?.parent?.boundarySeq
        if (boundary !== undefined && row.adjustment.of <= boundary) return
        if (this.hasCredits) this.usageCredits += row.adjustment.delta
        if (this.hasBilling && row.adjustment.usdMicrosDelta !== undefined)
          this.usageUsdMicros += row.adjustment.usdMicrosDelta
        return
      }
      if (row.credits !== undefined) {
        this.hasCredits = true
        this.usageCredits += row.credits
        this.creditsGateway &&= row.creditSource === 'gateway'
      } else this.creditsComplete = false
      this.usageTotals.input += row.tokens.input
      this.usageTotals.output += row.tokens.output
      this.usageTotals.cacheRead += row.tokens.cacheRead
      this.usageTotals.cacheWrite += row.tokens.cacheWrite
      this.usageTotals.reasoning += row.tokens.reasoning ?? 0
      this.reasoningComplete &&= row.tokens.reasoning !== undefined
      if (row.billing) {
        this.hasBilling = true
        this.usageUsdMicros += row.billing.usdMicros
        this.allGateway &&= row.billing.source === 'gateway'
        this.allSubscription &&= row.billing.subscription
      } else this.incompleteBilling = true
      return
    }
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return
    if (typeof event.surfaceOp === 'object') {
      const base = this.contextBase
      this.contextTokensValue = base?.total ?? 0
      for (const node of this.contextSurface.nodes()) {
        if (base && node.seq <= base.seq) continue
        this.contextTokensValue += estimatedContentTokens(node.event)
      }
    } else if (!this.contextBase || event.seq > this.contextBase.seq) {
      this.contextTokensValue += estimatedContentTokens(event)
    }
  }

  private applyNode(event: Event): Set<string> {
    const changed = new Set<string>()
    if ((event.lane ?? 'main') !== this.lane) return changed
    const { id, seq } = event
    const data = event.data
    if (typeof event.surfaceOp === 'object') {
      const value = data as {
        content?: Array<{ type: string; text?: string }>
        customInstructions?: string
        tokensBefore?: number
        tokensAfter?: number
      }
      this.pushNode({
        kind: 'compaction',
        id,
        seq,
        range: [event.surfaceOp.start, event.surfaceOp.end],
        ...(value.content ? { summary: text(value.content) } : {}),
        ...(value.customInstructions !== undefined ? { customInstructions: value.customInstructions } : {}),
        ...(value.tokensBefore !== undefined ? { tokensBefore: value.tokensBefore } : {}),
        ...(value.tokensAfter !== undefined ? { tokensAfter: value.tokensAfter } : {}),
      })
      changed.add(id)
      return changed
    }
    switch (event.type) {
      case 'user/message': {
        const message = data as UserMessage
        if (message.kind === 'runtime_context') {
          // Hook notices and per-request fact snapshots ride the user/message
          // channel for ordering, but were never typed by the operator — keep
          // them out of the 'user' node kind so renderers don't disguise them
          // as user input.
          this.pushNode({ kind: 'context', id, seq, text: text(message.content) })
        } else {
          this.pushNode({
            kind: 'user',
            id,
            seq,
            content: structuredClone(message.content),
            actorLabel: clip(event.actor.id, 128),
          })
        }
        changed.add(id)
        break
      }
      case 'effect/intent': {
        const intent = data as EffectIntent
        if (intent.kind === 'inference') this.activeInference = intent.effectId
        if (intent.tool) {
          this.effectTools.set(intent.effectId, intent.tool.toolUseId)
          const tool = this.tools.get(intent.tool.toolUseId)
          if (tool) {
            tool.status = 'running'
            changed.add(tool.id)
          }
          const parentId = intent.parentEffectId && this.effectTools.get(intent.parentEffectId)
          const parent = parentId ? this.tools.get(parentId) : undefined
          if (tool && parent) {
            tool.depth = (parent.depth ?? 0) + 1
            parent.children ??= []
            parent.children.push(tool.id)
            changed.add(tool.id)
            changed.add(parent.id)
          }
        }
        break
      }
      case 'assistant/output': {
        const output = data as AssistantOutput
        let node = this.assistantEffects.get(output.effectId)
        if (!node) {
          node = { kind: 'assistant', id, seq, text: '', streaming: true, effectId: output.effectId }
          this.assistantEffects.set(output.effectId, node)
          this.pushNode(node)
          changed.add(node.id)
        }
        this.outputChars.set(output.effectId, output.chars.text + output.chars.thinking)
        if (output.state === 'interrupted') {
          node.text = text(output.content)
          const thinking = text(output.content, 'thinking')
          if (thinking) node.thinking = thinking
          else delete node.thinking
          node.streaming = false
          this.keptOutput.add(output.effectId)
          changed.add(node.id)
        }
        break
      }
      case 'assistant/message': {
        const message = data as AssistantMessage
        const node = this.activeInference ? this.assistantEffects.get(this.activeInference) : undefined
        const final: AssistantNode = {
          kind: 'assistant',
          id,
          seq,
          text: text(message.content),
          streaming: false,
        }
        const thinking = text(message.content, 'thinking')
        if (thinking) final.thinking = thinking
        if (node) {
          node.text = final.text
          node.streaming = false
          if (thinking) node.thinking = thinking
          else delete node.thinking
          changed.add(node.id)
        } else {
          this.pushNode(final)
          changed.add(final.id)
        }
        break
      }
      case 'effect/settled': {
        const settled = data as EffectSettled
        const node = this.assistantEffects.get(settled.effectId)
        if (node) {
          // Still streaming at settlement with no recorded text: the process that held the text died.
          if (node.streaming && !this.keptOutput.has(settled.effectId))
            node.lostChars = this.outputChars.get(settled.effectId) ?? 0
          node.streaming = false
          changed.add(node.id)
        }
        this.outputChars.delete(settled.effectId)
        this.keptOutput.delete(settled.effectId)
        if (this.activeInference === settled.effectId) this.activeInference = undefined
        break
      }
      case 'tool/call': {
        const call = data as ToolCall
        const node: ToolNode = {
          kind: 'tool',
          id,
          seq,
          toolUseId: call.toolUseId,
          name: call.name,
          status: 'planned',
          summary: clip(call.name, 512),
          argsPreview: clip(canonicalJson(call.args), 2048),
        }
        this.tools.set(call.toolUseId, node)
        this.pushNode(node)
        changed.add(id)
        break
      }
      case 'tool/result': {
        const result = data as ToolResult
        const node = this.tools.get(result.toolUseId)
        if (node) {
          node.status =
            result.code === 'CANCELLED' || result.code === 'ABORTED' || result.cancelledBy
              ? 'cancelled'
              : result.isError
                ? 'failed'
                : 'completed'
          node.resultPreview = clip(text(result.content), 4096)
          node.enforcement = structuredClone(result.enforcement)
          this.completedResults.push({ seq, toolUseId: node.toolUseId })
          changed.add(node.id)
        }
        break
      }
      case 'approval/asked': {
        const asked = data as ApprovalAsked
        const options = asked.options?.map((option) => {
          if (option === 'allowed-once') return 'allow_once' as const
          if (option === 'allowed-session') return 'allow_always' as const
          if (option === 'allowed-permanent') return 'allow_permanent' as const
          return 'reject_once' as const
        }) ?? ['allow_once', 'allow_always', 'reject_once']
        const node: ApprovalNode = {
          kind: 'approval',
          id,
          seq,
          state: 'pending',
          summary: asked.summary,
          risk: asked.risk,
          options,
          requestSeq: seq,
          ...(asked.pending ? { ticket: asked.pending.ticket, expiresAt: asked.pending.expiresAt } : {}),
        }
        this.approvals.set(asked.requestId, node)
        this.pushNode(node)
        changed.add(id)
        if (asked.toolUseId) {
          this.approvalTools.set(asked.requestId, asked.toolUseId)
          const tool = this.tools.get(asked.toolUseId)
          if (tool) {
            tool.status = 'awaiting_approval'
            changed.add(tool.id)
          }
        }
        break
      }
      case 'approval/decided': {
        const decided = data as ApprovalDecided
        const node = this.approvals.get(decided.requestId)
        if (node) {
          node.state = decided.via === 'timeout' ? 'expired' : 'decided'
          node.decision = {
            verdict: decided.verdict,
            via: decided.via,
            ...(decided.decidedBy ? { byLabel: clip(decided.decidedBy.id, 128) } : {}),
          }
          changed.add(node.id)
        }
        const toolId = this.approvalTools.get(decided.requestId)
        const tool = toolId ? this.tools.get(toolId) : undefined
        if (tool) {
          tool.status = decided.verdict.startsWith('allowed')
            ? 'planned'
            : decided.verdict === 'cancelled'
              ? 'cancelled'
              : 'failed'
          changed.add(tool.id)
        }
        break
      }
      case 'cost/ledger': {
        const cost = data as CostLedger
        this.pushNode({
          kind: 'cost',
          id,
          seq,
          source: cost.creditSource,
          purpose: cost.purpose,
          ...(!cost.adjustment ? { tokens: structuredClone(cost.tokens) } : {}),
          ...(cost.billing ? { billing: structuredClone(cost.billing) } : {}),
          model: cost.model,
          ...(cost.interrupted !== undefined ? { interrupted: cost.interrupted } : {}),
          ...(cost.timing
            ? {
                timing: {
                  ...(cost.timing.ttftMs !== undefined ? { ttftMs: cost.timing.ttftMs } : {}),
                  ...(cost.timing.durationMs !== undefined ? { durationMs: cost.timing.durationMs } : {}),
                },
              }
            : {}),
          ...(cost.credits !== undefined ? { credits: cost.credits } : {}),
        })
        changed.add(id)
        break
      }
      case 'artifact/job': {
        const job = data as ArtifactJob
        if (job?.ref) {
          this.pushNode({
            kind: 'artifact',
            id,
            seq,
            name: clip(job.jobId, 256),
            ref: structuredClone(job.ref),
          })
          changed.add(id)
        }
        break
      }
      case 'x/core/context-breakdown': {
        const info = data as ContextBreakdownDiag
        const sections = info.sections.map((section) => ({
          ...section,
          id: clip(section.id, 256),
          source: clip(section.source, 256),
        }))
        this.pushNode({ kind: 'context-sections', id, seq, sections })
        changed.add(id)
        break
      }
      case 'x/core/contribute-conflict': {
        const conflict = data as Conflict
        this.pushNode({
          kind: 'contribute-conflict',
          id,
          seq,
          key: clip(conflict.key, 256),
          ops: conflict.ops.map((op) => clip(op, 128)),
        })
        changed.add(id)
        break
      }
      case 'turn/start':
        this.turn = (data as { turn: number }).turn
        this.step = 0
        break
      case 'step/start':
        this.step = (data as { step: number }).step
        break
      case 'turn/end':
        this.turnEnds.push(seq)
        break
    }
    return changed
  }

  private pushNode(node: UINode): void {
    this.nodeIndexes.set(node.id, this.nodes.length)
    this.nodes.push(node)
  }

  private record(seq: Seq, ids: Set<string>, turnIds: Set<string>): void {
    const changes: UIProjectionNodeChange[] = []
    for (const id of ids) {
      const index = this.nodeIndexes.get(id)
      const node = index === undefined ? undefined : this.nodes[index]
      if (index !== undefined && node) changes.push({ op: 'upsert', index, node: structuredClone(node) })
    }
    changes.sort((a, b) => (a.op === 'upsert' ? a.index : 0) - (b.op === 'upsert' ? b.index : 0))
    const turnChanges: UIProjectionTurnChange[] = []
    for (const id of turnIds) {
      const index = this.turnsProjection.turns.findIndex((turn) => turn.id === id)
      const turn = index < 0 ? undefined : this.turnsProjection.turns[index]
      if (turn) turnChanges.push({ op: 'upsert', index, turn: structuredClone(turn) })
    }
    turnChanges.sort((a, b) => (a.op === 'upsert' ? a.index : 0) - (b.op === 'upsert' ? b.index : 0))
    const bytes = encoder.encode(JSON.stringify({ seq, changes, turnChanges })).byteLength
    this.journal.push({ seq, changes, turnChanges, bytes })
    this.journalBytes += bytes
    while (
      this.journal.length > this.maxJournalEvents ||
      (this.journalBytes > this.maxJournalBytes && this.journal.length > 0)
    ) {
      const removed = this.journal.shift()
      if (!removed) break
      this.journalBytes -= removed.bytes
      this.journalFloor = removed.seq
    }
  }

  private metadata(): Pick<CoreUITimeline, 'opState' | 'budget'> {
    const op = this.op
    const parked = [...this.state.pendingApprovals.values()].find(
      (approval) => approval.lane === this.lane && approval.pending,
    )
    const opState: CoreUITimeline['opState'] = op
      ? {
          turn: op.meta.turn,
          step: op.step,
          phase: op.control.status === 'cancel_requested' ? 'cancel_requested' : op.phase.kind,
        }
      : op === undefined && this.state.openTurn.has(this.lane)
        ? { turn: this.turn, step: this.step, phase: 'running' }
        : parked?.pending
          ? { turn: this.turn, step: this.step, phase: 'parked', parked: { ...parked.pending } }
          : null
    const budget = this.state.registers.budgetState.get(this.lane)?.value
    return {
      opState,
      ...(budget ? { budget: structuredClone(budget) } : {}),
    }
  }

  private timeline(nodes: UINode[], usage?: UsageView, turns?: UITurn[]): CoreUITimeline {
    const meta = this.metadata()
    return {
      sessionId: this.sessionKey,
      upto: this.upto,
      opState: meta.opState,
      nodes,
      turns: turns ?? this.turnsProjection.turns.map((turn) => structuredClone(turn)),
      ...(meta.budget ? { budget: meta.budget } : {}),
      ...(usage ? { usage: structuredClone(usage) } : {}),
    }
  }
}

/**
 * Replays the transcript and its status at one ledger cut. Replacements mark when compaction
 * happened; they never hide or repeat the original transcript. The running operation is inferred
 * from the rows alone unless the caller passes `op`, the program counter's live value, which it
 * does only for a cut that is still the head.
 */
export async function projectUI(events: Iterable<Event>, opts: UIOptions): Promise<CoreUITimeline> {
  if (opts.upto !== undefined && (!Number.isSafeInteger(opts.upto) || opts.upto < 0))
    throw new CoreError('E_ENVELOPE', 'UI upper bound must be a nonnegative safe sequence number')
  const prefix = [...events].filter((event) => opts.upto === undefined || event.seq <= opts.upto)
  const cell = new UIProjectionCell(opts.sessionKey, opts.lane ?? 'main')
  if (opts.afterSeq !== undefined) cell.startAfter(opts.afterSeq)
  cell.apply(prefix)
  cell.sealReplay()
  if (opts.op !== undefined) cell.setOp(opts.op)
  return cell.view(opts)
}

/** Marks a cell that does not hold its session's whole history. Not exported from core. */
export function markIncomplete(cell: UIProjectionCell): void {
  markIncompleteImpl(cell)
}
