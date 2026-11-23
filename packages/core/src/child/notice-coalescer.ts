import { requireChildControl } from '@agnes/core-child-control/child/store'
import { type ChildTaskRecord, isTerminalChildState } from '@agnes/core-child-control/child/types'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import type { JsonValue, SystemInput } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { compactChildHandoff } from './child-prompt-budget.js'
import { childResultCollected } from './collected-result.js'
import {
  CHILD_COMPLETION_SOURCE,
  type ChildCompletionOptions,
  childCompletionInput,
  isBackgroundChild,
} from './completion-notice.js'
import { clipText } from './failure.js'
import { childLifecycle } from './lifecycle.js'

export const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const
export function pollWaitMetadata(consecutivePolls: number) {
  const index = Math.max(0, Math.trunc(consecutivePolls) || 0)
  return {
    suggestedWaitMs:
      POLL_WAIT_LADDER_MS[Math.min(index, POLL_WAIT_LADDER_MS.length - 1)] ?? POLL_WAIT_LADDER_MS[0],
  }
}

type Notice = Awaited<ReturnType<typeof childCompletionInput>> & {
  childKey: string
  omitClosingText?: boolean
  uncertainEffects?: readonly { toolName: string; argsHash: string; effectId: string }[]
}
type Owner = { parentKey: string; parentEpoch: AbortSignal }
type Options = { coalesceWindowMs?: number; maxWaitMs?: number }

/** One queue per live parent epoch. Every producer awaits delivery of its own batch. */
export class ChildNoticeCoalescer {
  private entries = new Map<string, Notice>()
  private waiters: ((delivery: Promise<void>) => void)[] = []
  private timer?: ReturnType<typeof setTimeout>
  private deadline = 0

  constructor(
    private readonly owner: Owner,
    private readonly deliver: (entries: Notice[]) => Promise<void>,
    private readonly options: Options = {},
  ) {}

  enqueue(owner: Owner, notice: Notice, allIdle = false): Promise<void> {
    if (
      owner.parentKey !== this.owner.parentKey ||
      owner.parentEpoch !== this.owner.parentEpoch ||
      owner.parentEpoch.aborted
    )
      return Promise.resolve()
    const window = this.options.coalesceWindowMs ?? 150
    if (!this.waiters.length) this.deadline = Date.now() + (this.options.maxWaitMs ?? 300)
    const promise = new Promise<void>((resolve) => this.waiters.push(resolve))
    this.entries.set(notice.commandId, notice)
    clearTimeout(this.timer)
    const delay = Math.min(window, this.deadline - Date.now())
    if (allIdle || delay <= 0) this.flushNow()
    else this.timer = setTimeout(() => this.flushNow(), delay)
    return promise
  }
  flushNow(): void {
    clearTimeout(this.timer)
    const entries = [...this.entries.values()]
    this.entries.clear()
    if (!entries.length) return
    const waiters = this.waiters.splice(0)
    const delivery = (async () => {
      if (!this.owner.parentEpoch.aborted) await this.deliver(entries)
    })()
    for (const resolve of waiters) resolve(delivery)
  }
}

function childData(entry: Notice): Record<string, JsonValue> {
  const data = {
    ...(entry.system.data as Record<string, JsonValue>),
    childKey: entry.childKey,
    commandId: entry.commandId,
    resultSeq: entry.resultSeq,
  } as Record<string, JsonValue>
  const result = data.result
  delete data.result
  if (entry.omitClosingText) {
    delete data.truncated
    data.omitClosingText = true
  } else if (typeof result === 'string') data.handoff = compactChildHandoff(result)
  if (entry.uncertainEffects?.length)
    data.uncertainEffects = entry.uncertainEffects.map(({ toolName, argsHash, effectId }) => ({
      toolName,
      argsHash,
      effectId,
    }))
  return data
}

export function completionBatch(entries: Notice[]): SystemInput {
  const summaries = entries.map((entry) =>
    entry.omitClosingText ? `Child ${entry.childKey} reported to its parent.` : entry.system.summary,
  )
  return {
    source: CHILD_COMPLETION_SOURCE,
    type: 'child-batch-completed',
    data: { children: entries.map(childData) },
    summary: clipText(summaries.join('\n'), 2048),
  }
}

// Compare individual command IDs under the inbox lock: recovery may regroup the same completions.
async function undelivered(parent: SessionImpl, entries: Notice[]) {
  const pending = new Map(entries.map((entry) => [entry.commandId, entry]))
  for (const entry of entries) {
    if (await childResultCollected(parent, entry.childKey, entry.commandId, entry.resultSeq))
      pending.delete(entry.commandId)
  }
  for await (const rows of scanPages((q) => parent.scan(q), {
    type: 'inbox',
    lane: parent.lane,
    toSeq: parent.lastSeq,
  })) {
    for (const row of rows) {
      if (row.origin !== 'system' || row.trust !== 'trusted') continue
      for (const item of (row.data as Inbox).items) {
        if (item.origin !== 'system' || item.system?.source !== CHILD_COMPLETION_SOURCE) continue
        if (item.commandId) pending.delete(item.commandId)
        if (item.system.type !== 'child-batch-completed') continue
        for (const child of (item.system.data as { children: { commandId: string }[] }).children)
          pending.delete(child.commandId)
      }
    }
    if (!pending.size) break
  }
  return [...pending.values()]
}

async function deliverBatch(parent: SessionImpl, epoch: AbortSignal, entries: Notice[]) {
  while (entries.length && !epoch.aborted && !parent.closingOrClosed) {
    const one = entries.length === 1 ? entries[0] : undefined
    const system =
      one && !one.omitClosingText && !one.uncertainEffects?.length ? one.system : completionBatch(entries)
    const commandId =
      one?.commandId ?? `child-batch:${sha256Hex(canonicalJson(entries.map((e) => e.commandId).sort()))}`
    let retry: Notice[] = []
    await parent.enqueue(
      'next-turn',
      {
        content: [{ type: 'text', text: system.summary }],
        system,
        commandId,
        signal: epoch,
        actor: parent.d.actor,
        origin: 'system',
        trust: 'untrusted',
        kind: 'follow_up',
      },
      {
        skipIf: async () => {
          const remaining = await undelivered(parent, entries)
          if (epoch.aborted || parent.closingOrClosed) return true
          if (remaining.length === entries.length) return false
          retry = remaining
          return true
        },
      },
    )
    entries = retry
  }
}

const queues = new WeakMap<AbortSignal, ChildNoticeCoalescer>()
const active = new WeakMap<AbortSignal, Set<string>>()

/** Capture at run admission, before siblings can publish terminal states ahead of their notices. */
export function expectChildNotice(parentEpoch: AbortSignal, childKey: string) {
  const children = active.get(parentEpoch) ?? new Set<string>()
  active.set(parentEpoch, children.add(childKey))
}

export async function deliverCoalescedChildCompletion(
  parent: SessionImpl,
  record: ChildTaskRecord,
  outcome: Parameters<typeof childCompletionInput>[2],
  options: ChildCompletionOptions & Pick<Notice, 'omitClosingText' | 'uncertainEffects'> = {},
  parentEpoch = childLifecycle(parent).signal,
) {
  if (
    record.parentKey !== parent.key ||
    parentEpoch !== childLifecycle(parent).signal ||
    parentEpoch.aborted ||
    parent.closingOrClosed ||
    !isBackgroundChild(parent, record)
  )
    return
  const owner = { parentKey: parent.key, parentEpoch }
  let queue = queues.get(parentEpoch)
  if (!queue) {
    queue = new ChildNoticeCoalescer(owner, (entries) => deliverBatch(parent, parentEpoch, entries))
    queues.set(parentEpoch, queue)
  }
  expectChildNotice(parentEpoch, record.childKey)
  const [notice, peers] = await Promise.all([
    childCompletionInput(parent, record, outcome, options),
    requireChildControl(parent.d.log.storage).listByParent(parent.key),
  ]).catch((error) => {
    active.get(parentEpoch)?.delete(record.childKey)
    throw error
  })
  active.get(parentEpoch)?.delete(record.childKey)
  const idle =
    !active.get(parentEpoch)?.size &&
    peers.every(
      (peer) => !isBackgroundChild(parent, peer) || peer.state === 'idle' || isTerminalChildState(peer.state),
    )
  await queue.enqueue(owner, { ...options, ...notice, childKey: record.childKey }, idle)
}
