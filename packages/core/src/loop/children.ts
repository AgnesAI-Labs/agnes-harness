import type { ChildAgentHandle, ChildAgentParentScope, ChildAgentSessionService } from '@agnes/extension-api'
import { MICROCREDITS_PER_CREDIT } from '../child/credits.js'
import { hasChildControl } from '../child/store.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'

/** Read the parent's current ceiling, including already held/settled tree spend. */
async function remainingBudget(s: SessionImpl): Promise<number | undefined> {
  const caps = [s.turnBudgetCap(), s.preset.treeBudgetCredits].filter((cap): cap is number => cap !== null)
  const storage = s.d.log.storage
  if (hasChildControl(storage)) {
    const record = await storage.lookupByKey(s.key)
    const root = record?.rootTaskId ?? `${s.key}:${s.lane}:${s.state.openTurn.get(s.lane)?.startSeq ?? 0}`
    const tree = await storage.projectTree(root)
    const scope = await storage.scopeForChild(s.key)
    for (const budget of [tree, scope])
      if (budget)
        caps.push(
          Number(budget.capMicro - budget.settledMicro - budget.heldMicro) / Number(MICROCREDITS_PER_CREDIT),
        )
  }
  if (caps.some((cap) => !Number.isFinite(cap) || cap < 0))
    throw new CoreError('E_BUDGET', 'Parent child budget is exhausted or invalid')
  return caps.length ? Math.min(...caps) : undefined
}

/** Own the public facade for the session lifetime; bind lazily after Host pins its generation. */
export class LoopChildren {
  private readonly lifetime = new AbortController()
  private bound: ChildAgentSessionService | undefined
  private closing: Promise<void> | undefined
  readonly port: ChildAgentSessionService

  constructor(private readonly s: SessionImpl) {
    this.port = Object.freeze({
      start: (task, options = {}) =>
        this.owned(async () => {
          const budget = await remainingBudget(s)
          this.lifetime.signal.throwIfAborted()
          this.bind()
          const service = this.required()
          const cap =
            options.budget === undefined
              ? budget
              : budget === undefined
                ? options.budget
                : Math.min(budget, options.budget)
          const handle = await service.start(task, {
            ...options,
            signal: options.signal ? AbortSignal.any([s.ac.signal, options.signal]) : s.ac.signal,
            ...(cap === undefined ? {} : { budget: cap }),
          })
          return this.wrap(handle)
        }),
      adoptStart: (task, options) =>
        this.owned(async () => {
          this.bind()
          if (!this.required().adoptStart) throw new CoreError('E_UNSUPPORTED', 'Child provider cannot adopt')
          const handle = await this.required().adoptStart!(task, {
            ...options,
            signal: options.signal ? AbortSignal.any([s.ac.signal, options.signal]) : s.ac.signal,
          })
          return this.wrap(handle)
        }),
      list: () => this.owned(async () => (this.bound ? this.bound.list() : [])),
      sendMessage: (id, text, signal) =>
        this.owned(() =>
          this.required().sendMessage(
            id,
            text,
            signal ? AbortSignal.any([s.ac.signal, signal]) : s.ac.signal,
          ),
        ),
      interrupt: (id) => this.owned(() => this.required().interrupt(id)),
      result: (id) => this.owned(() => this.required().result(id)),
      events: (id) => this.required().events(id),
      dispose: (id) => (id === undefined ? this.close() : this.required().dispose(id)),
    } satisfies ChildAgentSessionService)
  }
  /** Returned handles retain Core ownership, admission and cancellation on every operation. */
  private wrap(handle: ChildAgentHandle): ChildAgentHandle {
    return Object.freeze({
      id: handle.id,
      providerId: handle.providerId,
      capabilities: handle.capabilities,
      sendMessage: (text: string, signal: AbortSignal) => this.port.sendMessage(handle.id, text, signal),
      interrupt: () => this.port.interrupt(handle.id),
      result: () => this.port.result(handle.id),
      events: () => this.port.events(handle.id),
      dispose: () => this.port.dispose(handle.id),
    })
  }
  private bind(): void {
    if (this.bound) return
    const s = this.s
    const parent: ChildAgentParentScope = {
      sessionKey: s.key,
      cwd: s.d.cwd,
      signal: this.lifetime.signal,
      ...(s.preset.treeBudgetCredits === null ? {} : { budget: s.preset.treeBudgetCredits }),
      ...(s.d.loopChildToolFilter ? { toolFilter: s.d.loopChildToolFilter } : {}),
    }
    this.bound = s.d.loopChildren ?? s.d.bindLoopChildren?.(parent)
  }
  private required(): ChildAgentSessionService {
    if (!this.bound) throw new CoreError('E_RELATION', 'No child is owned by this loop session')
    return this.bound
  }
  private async owned<T>(work: () => Promise<T>): Promise<T> {
    const done = this.s.beginLoopOperation()
    try {
      this.lifetime.signal.throwIfAborted()
      return await work()
    } finally {
      done()
    }
  }
  cancel(): void {
    this.lifetime.abort(this.s.ac.signal.reason)
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.cancel()
      await this.bound?.dispose()
    })()
    return this.closing
  }
}
