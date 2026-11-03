import { namesWorkspace, type RefinementSettingsView, type WorkspaceSaveRequest } from '@agnes/core'
import type { MemoryParagraphPort, MemorySession, MemorySource } from '@agnes/extension-api'
import {
  PROMOTION_CONFIRMATIONS,
  type RefinementRegistry,
  type SaveReceipt,
  type SaveRefusal,
} from '@agnes/host-infrastructure/refinement-registry'
import { reconcileParagraphs, WORKSPACE_MEMORY_KEY } from './reconcile.js'
import { paragraphText, sourceRuleProblem } from './save-rules.js'
import {
  code,
  commitParagraph,
  pendingIntent,
  putReceipt,
  refusalOf,
  resumeSaves,
  writeFresh,
} from './workspace-commit.js'
import { placement, receiptBase, refuse, type Step, steps, type WorkspaceSave } from './workspace-save.js'

/**
 * The provider's port to managed sections of user memory, or undefined when it has none that works: the
 * member must be a function, the call must not throw, and what it returns must have the port's methods.
 */
export function userPortOf(
  session: MemorySession,
  source: MemorySource,
  signal: AbortSignal,
): MemoryParagraphPort | undefined {
  if (typeof session.userParagraphs !== 'function') return undefined
  try {
    const port = session.userParagraphs(source, signal) as Partial<MemoryParagraphPort> | null | undefined
    return port &&
      typeof port.list === 'function' &&
      typeof port.propose === 'function' &&
      typeof port.commit === 'function'
      ? (port as MemoryParagraphPort)
      : undefined
  } catch {
    return undefined
  }
}

export type UserSaveDeps = {
  /** The one registry of user memory sections. */
  registry(): RefinementRegistry
  /** A workspace's registry: what a person took back there bars the same content here too. */
  workspaceRegistry(workspaceRoot: string): RefinementRegistry
  settings(): RefinementSettingsView
  /** Memory opened for a workspace outside any session; it reaches user memory too. Closed after use. */
  memory(workspaceRoot: string): MemorySession | undefined
  clock: () => number
}

/** What a promotion came to: a receipt, or `workspace` when the lesson names its workspace and stays there. */
export type UserSaveResult = SaveReceipt | 'workspace'

export type UserSave = {
  save(request: WorkspaceSaveRequest): Promise<UserSaveResult>
  /** Brings the user registry in line with the user memory file and settles cut-off promotions. */
  resume(workspaceRoot: string): Promise<void>
  settled(receiptIds: readonly string[]): Promise<SaveReceipt[]>
}

/**
 * Reconciles the user registry with the user memory file: a recorded section whose markers are no longer
 * in the file is taken back (removed, with a revocation), whether a person deleted it, took its markers
 * off or damaged them, so its content is not promoted again. Nothing while the registry is unreadable.
 */
export async function reconcileUser(
  registry: RefinementRegistry,
  memory: MemorySession,
  clock: () => number,
): Promise<void> {
  const port = userPortOf(memory, { sessionKey: WORKSPACE_MEMORY_KEY, turn: 0 }, new AbortController().signal)
  if (!port) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = registry.read()
    if (!read.paragraphs.some((entry) => entry.state === 'active')) return
    let paragraphs: readonly { id: string }[]
    try {
      paragraphs = (await port.list()).paragraphs
    } catch {
      return
    }
    try {
      reconcileParagraphs(registry, read, { paragraphs, text: '' }, clock())
      return
    } catch (error) {
      if (code(error) !== 'REGISTRY_REVISION_CONFLICT') return
    }
  }
}

/**
 * A save to user memory: the riskiest save there is, since nobody reviews it and every workspace may
 * read it. It is the automatic promotion of a confirmed lesson, a person's own request
 * (`/refine --user`) or the model's (`harness_refine` or `harness_propose` with target user), and
 * judged in the same fixed order as a workspace save:
 * 1. switch: refinement is on, at the revision the request was made under (nothing is read or written
 *    otherwise);
 * 2. revocation: content a user took back from user memory, or from this workspace, is refused, a
 *    request of a person or the model included;
 * 3. confirmations: `PROMOTION_CONFIRMATIONS` for the automatic promotion; a request skips the count;
 * 4. source and safety rules, as for the workspace; text that names its workspace (`namesWorkspace`)
 *    is not promoted but handed back (`workspace`) to be saved to its workspace instead;
 * 5. the provider must keep managed sections of user memory (`unsupported-provider`); whether this
 *    workspace reads user memory is recorded on the receipt and changes nothing: no setting is touched;
 * 6. capacity: the section must fit the user memory budget with the hand-written text and the sections
 *    in force (`user-memory-budget`); nothing is trimmed, merged or removed to make room.
 * The write is one compare-and-swap on the user memory file, under an admission that holds only while
 * the switch is still on at the same revision; the section is recorded in force for 30 days only after
 * the file commit. Promotions run one at a time in this process.
 */
export function createUserSave(deps: UserSaveDeps): UserSave {
  let queue: Promise<unknown> = Promise.resolve()
  const inFlight = new Set<string>()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  const switchAt = (revision: string): boolean => {
    try {
      const view = deps.settings()
      return view.enabled === true && view.revision === revision
    } catch {
      return false
    }
  }
  const withMemory = async <T>(root: string, work: (memory: MemorySession | undefined) => Promise<T>) => {
    let memory: MemorySession | undefined
    try {
      memory = deps.memory(root)
    } catch {
      memory = undefined
    }
    try {
      return await work(memory)
    } finally {
      await Promise.resolve(memory?.close?.()).catch(() => undefined)
    }
  }
  const settle = async (registry: RefinementRegistry, memory: MemorySession | undefined) => {
    if (!memory) return
    await reconcileUser(registry, memory, deps.clock).catch(() => undefined)
    await resumeSaves(registry, memory, deps.clock, inFlight, userPortOf).catch(() => undefined)
  }

  async function judge(
    request: WorkspaceSaveRequest,
    base: SaveReceipt,
    registry: RefinementRegistry,
    memory: MemorySession | undefined,
  ): Promise<UserSaveResult> {
    await settle(registry, memory)
    const verdicts: Partial<Record<Step, 'pass' | 'fail' | 'skip'>> = { switch: 'pass' }
    const refused = (reason: SaveRefusal, step: Step) =>
      refuse(registry, base, reason, { ...verdicts, [step]: 'fail' })
    if (registry.unreadable())
      return {
        ...base,
        outcome: 'refused',
        reason: 'unavailable',
        steps: steps({ ...verdicts, revocation: 'fail' }),
      }
    const snapshot = registry.read()
    const repeated = snapshot.receipts.find(
      (receipt) =>
        receipt.commandId === request.commandId &&
        receipt.source.sessionKey === base.source.sessionKey &&
        receipt.source.entryId === base.source.entryId &&
        receipt.outcome !== 'unknown',
    )
    if (repeated) return repeated
    // 1 (cont.). Only a source with a request behind it writes user memory: the automatic promotion, a
    // person's own request or the model's.
    if (request.initiator !== 'auto' && request.initiator !== 'user' && request.initiator !== 'model')
      return refused('source-rules', 'rules')
    // 2. Revocation: taken back from user memory, or from this workspace.
    const local = deps.workspaceRegistry(request.session.workspaceRoot)
    if (registry.revoked(base.source) || local.revoked(base.source))
      return refused('user-revoked', 'revocation')
    verdicts.revocation = 'pass'
    // 3. Confirmations: only the automatic promotion needs them; a request skips the count.
    if (request.initiator === 'auto') {
      if (!(request.confirmations >= PROMOTION_CONFIRMATIONS)) return refused('unconfirmed', 'confirmations')
      verdicts.confirmations = 'pass'
    }
    // 4. Source and safety rules; text naming its workspace stays in that workspace.
    const problem = sourceRuleProblem(request)
    if (problem) return refused(problem, 'rules')
    if (request.entry.kind !== 'memory' && request.entry.kind !== 'prompt')
      return refused('source-rules', 'rules')
    const text = paragraphText(request.entry)
    if (namesWorkspace(text, request.session.workspaceRoot)) return 'workspace'
    verdicts.rules = 'pass'
    // 5. A provider that keeps managed sections of user memory.
    const source: MemorySource = {
      sessionKey: request.session.key,
      turn: request.evidenceTurn ?? 0,
      maintenance: request.runId ?? request.commandId,
    }
    const port = memory ? userPortOf(memory, source, new AbortController().signal) : undefined
    if (!memory || !port) return refused('unsupported-provider', 'memory-mode')
    let read: SaveReceipt
    try {
      const { settings } = await memory.inspect()
      read = { ...base, userMemoryRead: settings.mode !== 'off' && settings.userEnabled === true }
    } catch {
      return refused('unavailable', 'memory-mode')
    }
    verdicts['memory-mode'] = 'pass'
    // 6. Capacity, known once the change is proposed.
    let inFile: ReadonlyMap<string, string>
    try {
      inFile = new Map((await port.list()).paragraphs.map((entry) => [entry.id, entry.text] as const))
    } catch {
      return refuse(registry, read, 'unavailable', { ...verdicts, capacity: 'fail' })
    }
    const placed = placement(snapshot, base.source, text, deps.clock(), inFile)
    if (placed === 'busy') return refuse(registry, read, 'conflict', { ...verdicts, capacity: 'fail' })
    if ('existing' in placed) {
      const receipt: SaveReceipt = {
        ...read,
        outcome: 'saved',
        steps: steps({ ...verdicts, capacity: 'pass' }),
        target: {
          kind: 'memory-paragraph',
          paragraphId: placed.existing.id,
          fileHash: placed.existing.fileHash,
        },
      }
      writeFresh(registry, (draft) => putReceipt(draft, receipt))
      return receipt
    }
    const result = await commitParagraph({
      registry,
      memory,
      port,
      paragraph: { id: placed.id, text },
      receipt: { ...read, steps: steps({ ...verdicts, capacity: 'pass' }) },
      switchCurrent: () => switchAt(request.settingsRevision),
      clock: deps.clock,
      decided: { revision: snapshot.revision },
      ...(placed.untouched ? { untouched: placed.untouched } : {}),
      inFlight,
    })
    if ('stale' in result) return refuse(registry, read, 'conflict', { ...verdicts, capacity: 'fail' })
    const { receipt } = result
    return receipt.reason === 'user-memory-budget' || receipt.reason === 'memory-full'
      ? { ...receipt, steps: steps({ ...verdicts, capacity: 'fail' }) }
      : receipt
  }

  return {
    async save(request) {
      const base: SaveReceipt = { ...receiptBase(request, deps.clock()), layer: 'user' }
      if (!switchAt(request.settingsRevision))
        return { ...base, outcome: 'refused', reason: 'refinement-off', steps: steps({ switch: 'fail' }) }
      return serial(() =>
        withMemory(request.session.workspaceRoot, async (memory) => {
          const registry = deps.registry()
          for (let attempt = 0; ; attempt++) {
            try {
              return await judge(request, base, registry, memory)
            } catch (error) {
              const failure = code(error)
              if (failure === 'REGISTRY_REVISION_CONFLICT' && attempt === 0) continue
              const reason: SaveRefusal =
                failure === 'REGISTRY_REVISION_CONFLICT' ? 'conflict' : refusalOf(error)
              return refuse(registry, base, reason, { switch: 'pass' })
            }
          }
        }),
      )
    },
    async resume(workspaceRoot) {
      try {
        if (!deps.settings().enabled) return
      } catch {
        return
      }
      await serial(async () => {
        const registry = deps.registry()
        if (
          !registry.read().paragraphs.some((entry) => entry.state === 'active') &&
          !registry.read().receipts.some(pendingIntent)
        )
          return
        await withMemory(workspaceRoot, (memory) => settle(registry, memory))
      }).catch(() => undefined)
    },
    async settled(receiptIds) {
      try {
        if (!deps.settings().enabled) return []
      } catch {
        return []
      }
      const wanted = new Set(receiptIds)
      return deps
        .registry()
        .read()
        .receipts.filter((receipt) => wanted.has(receipt.receiptId) && !pendingIntent(receipt))
    },
  }
}

/**
 * The one save path every entry point reaches: a request for user memory goes to the promotion, and one
 * whose text names its workspace comes back from it to be saved to the workspace as any other automatic
 * save; every other request is a workspace save. Settled outcomes are read from both registries.
 */
export function routedSaves(saves: WorkspaceSave, promotions: UserSave): WorkspaceSave {
  return {
    ...saves,
    async save(request) {
      if (request.target !== 'user') return saves.save(request)
      const promoted = await promotions.save(request)
      if (promoted !== 'workspace') return promoted
      const { target: _user, ...workspaceRequest } = request
      return saves.save(workspaceRequest)
    },
    async settled(workspaceRoot, receiptIds) {
      const [local, user] = await Promise.all([
        saves.settled(workspaceRoot, receiptIds),
        promotions.settled(receiptIds),
      ])
      return [...local, ...user]
    },
  }
}
