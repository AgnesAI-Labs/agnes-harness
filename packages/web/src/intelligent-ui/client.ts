import { validateAgainst } from '@agnes/protocol'
import {
  UiActionParams,
  UiActionReceipt,
  UiReadResult,
  X_AGNES_UI_LIMITS,
  type JsonValue,
  type UiAction,
  type UiRowContext,
  type UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { boundedUiJson, validIntelligentSurface } from '@agnes/web-ui'
import type { IntelligentUiServer, UiCommandStorage } from './types.js'

export interface UiDraft {
  revision: number
  input: Record<string, JsonValue>
  selection: Record<string, string[]>
  invalid: Set<string>
}
export type UiSnapshot = Readonly<{
  surfaces: readonly UiSurfaceRecord[]
  receipts: readonly UiActionReceipt[]
  ready: boolean
  error?: 'ui.unavailable' | 'ui.transport' | 'ui.duplicate'
  watermark: number
}>
const active = (receipt: UiActionReceipt) =>
  ['received', 'pending-approval', 'executing'].includes(receipt.status) ||
  receipt.failure?.outcomeUnknown === true
const storageKey = (sessionId: string) => `agnes.ui.commands:${encodeURIComponent(sessionId)}`

/** One session projection for both placements. All authority remains in backend receipts. */
export class IntelligentUiClient {
  private snapshot: UiSnapshot = { surfaces: [], receipts: [], ready: false, watermark: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly drafts = new Map<string, UiDraft>()
  private readonly changed = new Set<string>()
  private readonly commands = new Map<string, UiActionParams>()
  private readonly sending = new Set<string>()
  private readonly recheck = new Set<string>()
  private readonly reviewed = new Set<string>()
  private readonly confirming = new Map<
    string,
    { action: UiAction; row?: UiRowContext; retryOf?: string; revision: number }
  >()
  private stopListening: (() => void) | undefined
  private disposed = false
  private recovery: Promise<void> | undefined
  private refreshRequested = false
  private lastSeen = 0
  private events: Array<{ seq: number; type: string }> = []
  private version = 0

  constructor(
    readonly sessionId: string,
    private readonly server: IntelligentUiServer,
    private readonly storage?: UiCommandStorage,
    private readonly commandId: () => string = () => crypto.randomUUID(),
  ) {
    // Persist only transport identity, never invent a receipt on reload.
    try {
      const raw: unknown = JSON.parse(storage?.getItem(storageKey(sessionId)) ?? '[]')
      if (Array.isArray(raw) && raw.length <= X_AGNES_UI_LIMITS.pendingCommandsPerSession)
        for (const item of raw) {
          if (!boundedUiJson(item, X_AGNES_UI_LIMITS.actionBytes)) continue
          const parsed = validateAgainst<UiActionParams>(UiActionParams, item)
          if (parsed.ok && parsed.value.sessionId === sessionId)
            this.commands.set(parsed.value.commandId, parsed.value)
        }
    } catch {
      /* an unavailable browser store does not prevent server recovery */
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getVersion = (): number => this.version
  getSnapshot = (): UiSnapshot => this.snapshot
  private emit(): void {
    if (this.disposed) return
    this.version++
    for (const listener of this.listeners) listener()
  }
  private persist(): void {
    try {
      if (this.commands.size)
        this.storage?.setItem(storageKey(this.sessionId), JSON.stringify([...this.commands.values()]))
      else this.storage?.removeItem(storageKey(this.sessionId))
    } catch {
      /* same command remains in memory across reconnect */
    }
  }

  async start(): Promise<void> {
    if (this.stopListening || this.disposed) return
    this.stopListening = this.server.listen(
      (event) => {
        if (this.disposed) return
        if (this.recovery) {
          this.events.push(event)
          return
        }
        this.observe(event)
      },
      () => {
        void this.refresh()
      },
    )
    await this.refresh(true)
  }

  private observe(event: { seq: number; type: string }): void {
    if (event.seq <= this.lastSeen) return
    const gap = event.seq !== this.lastSeen + 1
    this.lastSeen = event.seq
    if (gap || event.type.startsWith('x/agnes/intelligent-ui/')) void this.refresh()
  }

  /** Snapshot pages use one watermark. Subscribe first, catch up after that sequence, then drain buffered events. */
  refresh(attach = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.recovery) {
      this.refreshRequested = true
      return this.recovery
    }
    this.snapshot = { ...this.snapshot, ready: false }
    this.emit()
    const work = this.recover(attach)
      .catch(() => {
        if (!this.disposed) {
          this.snapshot = { ...this.snapshot, ready: false, error: 'ui.unavailable' }
          this.emit()
        }
      })
      .finally(() => {
        this.recovery = undefined
        if (this.disposed) return
        const buffered = this.events.splice(0)
        const again = this.refreshRequested
        this.refreshRequested = false
        for (const event of buffered) this.observe(event)
        if (again && !this.recovery) void this.refresh()
      })
    this.recovery = work
    return work
  }

  private async recover(attach: boolean): Promise<void> {
    // Cursor expiry or a changing watermark starts a new snapshot; bounded attempts fail closed.
    let surfaces: UiSurfaceRecord[] = [],
      receipts: UiActionReceipt[] = [],
      watermark = 0
    let completed = false
    for (let attempt = 0; attempt < 3 && !completed; attempt++) {
      surfaces = []
      receipts = []
      let cursor: string | undefined
      const cursors = new Set<string>()
      try {
        do {
          const page = await this.server.read({
            sessionId: this.sessionId,
            limit: 16,
            ...(cursor ? { cursor } : {}),
          })
          if (this.disposed) return
          if (
            !boundedUiJson(page, X_AGNES_UI_LIMITS.projectionBytes) ||
            !validateAgainst<UiReadResult>(UiReadResult, page).ok ||
            page.sessionId !== this.sessionId
          )
            throw new Error('invalid UI projection')
          if (cursor && page.lastSeq !== watermark) throw new Error('UI snapshot changed')
          watermark = page.lastSeq
          if (
            page.surfaces.some(
              (record) => !validIntelligentSurface(record.surface) || record.updatedSeq > watermark,
            ) ||
            page.actions.some((receipt) => !this.validReceipt(receipt) || receipt.seq > watermark)
          )
            throw new Error('UI evidence gap')
          surfaces.push(...page.surfaces)
          receipts.push(...page.actions)
          if (!boundedUiJson({ surfaces, receipts }, X_AGNES_UI_LIMITS.projectionBytes))
            throw new Error('UI projection capacity')
          cursor = page.nextCursor
          if (cursor) {
            if (cursors.has(cursor) || cursors.size >= 256) throw new Error('UI cursor cycle')
            cursors.add(cursor)
          }
        } while (cursor)
        completed = true
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    if (
      surfaces.filter((item) => item.status === 'open').length > 16 ||
      new Set(surfaces.map((item) => item.surface.id)).size !== surfaces.length
    )
      throw new Error('invalid UI surfaces')
    // A display page/cache may omit a durable command. Recover its identity explicitly.
    for (const command of this.commands.values()) {
      if (receipts.some((item) => item.commandId === command.commandId)) continue
      const page = await this.server.read({ sessionId: this.sessionId, commandId: command.commandId })
      if (
        !validateAgainst<UiReadResult>(UiReadResult, page).ok ||
        page.sessionId !== this.sessionId ||
        !boundedUiJson(page, X_AGNES_UI_LIMITS.projectionBytes) ||
        page.actions.some((item) => !this.validReceipt(item) || item.commandId !== command.commandId)
      )
        throw new Error('invalid command recovery')
      // These newer receipts do not advance the surface snapshot/event cursor.
      receipts.push(...page.actions)
    }
    if (this.disposed) return
    for (const record of surfaces) {
      const previous = this.snapshot.surfaces.find((item) => item.surface.id === record.surface.id)
      if (
        (previous && previous.surface.revision !== record.surface.revision) ||
        (this.drafts.has(record.surface.id) &&
          this.drafts.get(record.surface.id)!.revision !== record.surface.revision)
      ) {
        this.changed.add(record.surface.id)
        this.confirming.delete(record.surface.id)
        this.drafts.delete(record.surface.id)
      }
    }
    const latest = new Map<string, UiActionReceipt>()
    for (const receipt of receipts)
      if ((latest.get(receipt.commandId)?.seq ?? 0) < receipt.seq) latest.set(receipt.commandId, receipt)
    // An action response can arrive while an older snapshot is being read. Keep that newer evidence.
    for (const receipt of this.snapshot.receipts)
      if (receipt.seq > watermark && (latest.get(receipt.commandId)?.seq ?? 0) < receipt.seq)
        latest.set(receipt.commandId, receipt)
    this.snapshot = {
      surfaces: surfaces.sort((a, b) => b.updatedSeq - a.updatedSeq),
      receipts: [...latest.values()].sort((a, b) => a.seq - b.seq),
      ready: true,
      watermark,
    }
    this.lastSeen = watermark
    for (const receipt of latest.values()) this.finishCommand(receipt)
    this.persist()
    if (attach) await this.server.attach(watermark)
    if (this.disposed) return
    this.emit()
  }

  private validReceipt(receipt: UiActionReceipt): boolean {
    if (
      !validateAgainst<UiActionReceipt>(UiActionReceipt, receipt).ok ||
      receipt.sessionId !== this.sessionId
    )
      return false
    if (receipt.status === 'rejected') return !!receipt.refusal && !receipt.failure
    if (receipt.status === 'failed')
      return (
        !!receipt.failure &&
        !receipt.refusal &&
        !(receipt.failure.outcomeUnknown && receipt.failure.retryable)
      )
    if (receipt.failure || receipt.refusal) return false
    if (receipt.status === 'pending-approval') return !!receipt.approvalId && !!receipt.invocationId
    if (receipt.status === 'succeeded') return !!receipt.resultSeq && !!receipt.invocationId
    return true
  }

  record(id: string): UiSurfaceRecord | undefined {
    return this.snapshot.surfaces.find((item) => item.surface.id === id)
  }
  receipts(id: string): UiActionReceipt[] {
    return this.snapshot.receipts.filter((item) => item.surfaceId === id)
  }
  draft(id: string): UiDraft {
    let draft = this.drafts.get(id)
    if (!draft || draft.revision !== this.record(id)?.surface.revision) {
      draft = {
        revision: this.record(id)?.surface.revision ?? 0,
        input: {},
        selection: {},
        invalid: new Set(),
      }
      for (const component of this.record(id)?.surface.components ?? [])
        if (component.kind === 'form')
          draft.input[component.id] = structuredClone(this.record(id)!.surface.data[component.dataKey]!)
      this.drafts.set(id, draft)
    }
    return draft
  }
  locked(id: string): boolean {
    return (
      !this.snapshot.ready ||
      this.record(id)?.status !== 'open' ||
      this.commandsFor(id).length > 0 ||
      this.receipts(id).some(active) ||
      this.recheck.has(id) ||
      this.changed.has(id)
    )
  }
  hasRevisionChange(id: string): boolean {
    return this.changed.has(id)
  }
  needsReview(id: string): boolean {
    return this.recheck.has(id) || this.changed.has(id)
  }
  async review(id: string): Promise<void> {
    await this.refresh()
    if (!this.snapshot.ready) return
    for (const receipt of this.receipts(id))
      if (receipt.refusal?.reason === 'stale' || receipt.refusal?.reason === 'closed')
        this.reviewed.add(receipt.commandId)
    this.recheck.delete(id)
    this.changed.delete(id)
    this.confirming.delete(id)
    this.drafts.delete(id)
    this.emit()
  }
  setInput(id: string, componentId: string, value: unknown): void {
    if (this.locked(id)) return
    const draft = this.draft(id)
    if (!boundedUiJson(value, X_AGNES_UI_LIMITS.actionBytes)) {
      draft.invalid.add(`${componentId}:bounds`)
      this.emit()
      return
    }
    draft.invalid.delete(`${componentId}:bounds`)
    draft.input[componentId] = value as JsonValue
    this.emit()
  }
  setSelection(id: string, componentId: string, ids: string[]): void {
    if (this.locked(id)) return
    this.draft(id).selection[componentId] = [...ids]
    this.emit()
  }
  setInvalid(id: string, componentId: string, path: string, invalid: boolean): void {
    if (this.disposed) return
    const draft = this.draft(id),
      key = `${componentId}:${path}`
    if (draft.invalid.has(key) === invalid) return
    if (invalid) draft.invalid.add(key)
    else draft.invalid.delete(key)
    this.emit()
  }
  confirmation(id: string) {
    return this.confirming.get(id)
  }
  cancelConfirmation(id: string): void {
    this.confirming.delete(id)
    this.emit()
  }
  choose(id: string, action: UiAction, row?: UiRowContext, retryOf?: string): void {
    if (
      this.locked(id) ||
      this.draft(id).invalid.size ||
      !this.record(id)?.surface.actions.some((item) => item.id === action.id)
    )
      return
    this.confirming.set(id, {
      action,
      revision: this.record(id)!.surface.revision,
      ...(row ? { row } : {}),
      ...(retryOf ? { retryOf } : {}),
    })
    this.emit()
  }
  async confirm(id: string): Promise<void> {
    const decision = this.confirming.get(id),
      record = this.record(id)
    if (
      !decision ||
      !record ||
      this.locked(id) ||
      decision.revision !== record.surface.revision ||
      this.draft(id).invalid.size
    )
      return
    if (decision.retryOf) {
      const old = this.receipts(id).find((item) => item.commandId === decision.retryOf)
      if (old?.status !== 'failed' || !old.failure?.retryable || old.failure.outcomeUnknown) return
    }
    const draft = this.draft(id)
    const params: UiActionParams = {
      sessionId: this.sessionId,
      surfaceId: id,
      revision: record.surface.revision,
      actionId: decision.action.id,
      commandId: this.commandId(),
      input: structuredClone(draft.input),
      selection: structuredClone(draft.selection),
      ...(decision.row
        ? {
            row: decision.row,
            selection: { ...draft.selection, [decision.row.tableId]: [decision.row.rowId] },
          }
        : {}),
      ...(decision.action.confirm ? { confirmed: true } : {}),
      ...(decision.retryOf ? { retryOf: decision.retryOf } : {}),
    }
    if (!boundedUiJson(params, X_AGNES_UI_LIMITS.actionBytes)) {
      this.snapshot = { ...this.snapshot, error: 'ui.unavailable' }
      this.emit()
      return
    }
    this.confirming.delete(id)
    this.commands.set(params.commandId, params)
    this.persist()
    this.emit()
    await this.send(params)
  }
  private commandsFor(id: string) {
    return [...this.commands.values()].filter((item) => item.surfaceId === id)
  }
  pendingCommands(id: string): readonly UiActionParams[] {
    return this.commandsFor(id)
  }
  async resend(id: string): Promise<void> {
    await this.refresh()
    if (!this.snapshot.ready) return
    for (const params of this.commandsFor(id)) {
      if (this.snapshot.receipts.some((item) => item.commandId === params.commandId)) continue
      await this.send(params)
    }
  }
  private async send(params: UiActionParams): Promise<void> {
    if (this.disposed || this.sending.has(params.commandId)) return
    this.sending.add(params.commandId)
    try {
      const receipt = await this.server.action(params)
      if (this.disposed) return
      if (
        !this.validReceipt(receipt) ||
        receipt.commandId !== params.commandId ||
        receipt.surfaceId !== params.surfaceId ||
        receipt.actionId !== params.actionId ||
        receipt.revision !== params.revision
      )
        throw new Error('invalid action receipt')
      const old = this.snapshot.receipts.find((item) => item.commandId === receipt.commandId)
      const { error: _error, ...previous } = this.snapshot
      this.snapshot = {
        ...previous,
        receipts:
          old && old.seq > receipt.seq
            ? this.snapshot.receipts
            : [...this.snapshot.receipts.filter((item) => item.commandId !== receipt.commandId), receipt],
      }
      this.finishCommand(receipt)
      this.persist()
      this.emit()
      if (receipt.refusal?.reason === 'stale' || receipt.refusal?.reason === 'closed') await this.refresh()
    } catch (error) {
      if (this.disposed) return
      const conflict =
        error &&
        typeof error === 'object' &&
        'data' in error &&
        JSON.stringify(error.data).includes('UI_COMMAND_CONFLICT')
      this.snapshot = { ...this.snapshot, error: conflict ? 'ui.duplicate' : 'ui.transport' }
      this.emit()
      // Keep the immutable request locked; reconnect/recovery cannot turn ambiguity into safe retry.
    } finally {
      this.sending.delete(params.commandId)
    }
  }
  private finishCommand(receipt: UiActionReceipt): void {
    if (
      !this.reviewed.has(receipt.commandId) &&
      receipt.status === 'rejected' &&
      (receipt.refusal?.reason === 'stale' || receipt.refusal?.reason === 'closed')
    )
      this.recheck.add(receipt.surfaceId)
    if (!active(receipt)) this.commands.delete(receipt.commandId)
  }
  dispose(): void {
    this.disposed = true
    this.stopListening?.()
    this.stopListening = undefined
    this.listeners.clear()
    this.confirming.clear()
    this.drafts.clear()
  }
}
