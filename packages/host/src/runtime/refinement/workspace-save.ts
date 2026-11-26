import { randomBytes, randomUUID } from 'node:crypto'
import {
  type RefinementSettingsView,
  type RefinementWorkflowRuns,
  type RefinementWorkspacePort,
  WORKFLOW_RUN_LOOKUP_MS,
  type WorkflowRunView,
  type WorkspaceSaveRequest,
} from '@agnes/core'
import type {
  MemoryParagraphList,
  MemoryParagraphPort,
  MemoryProposal,
  MemorySession,
  MemorySource,
} from '@agnes/extension-api'
import {
  APPROVAL_TTL_MS,
  normalizedContentHash,
  PROMOTION_CONFIRMATIONS,
  type RefinementRegistry,
  type RegistryParagraph,
  type RegistryRecords,
  type RegistrySnapshot,
  revocationMatches,
  type SaveReceipt,
  type SaveRefusal,
  type SaveSource,
} from '@agnes/host-infrastructure/refinement-registry'
import { sha256Hex } from '@agnes/protocol'
import {
  fileRevisionGuard,
  liveTargetDeadline,
  paragraphVisibility,
  targetDeadline,
} from './paragraph-visibility.js'
import { paragraphPortOf, reconcileWorkspace, recordedTextHash } from './reconcile.js'
import { paragraphText, sourceRuleProblem } from './save-rules.js'
import { reconcileSkillDeletions, saveSkillChange, type WorkspaceSkills } from './skill-update.js'
import { normalizedWorkflowHash, workflowTextProblem } from './workflow-runs.js'
import {
  code,
  commitParagraph,
  type ExistingParagraph,
  failedRules,
  INTENT_SETTLE_MS,
  type ParagraphCommit,
  pendingIntent,
  putReceipt,
  recordExisting,
  refusalOf,
  resumeSaves,
  writeFresh,
} from './workspace-commit.js'

export type Step = SaveReceipt['steps'][number]['step']
const STEPS: readonly Step[] = ['switch', 'revocation', 'confirmations', 'rules', 'memory-mode', 'capacity']

/** A paragraph proposal waiting for the user, with what is needed to commit it once approved. */
export type PendingParagraph = Readonly<{
  workspaceRoot: string
  /** The receipt recorded for it, outcome `awaiting-approval`, naming the paragraph and the file hash. */
  receipt: SaveReceipt
  paragraph: ParagraphCommit['paragraph']
  /** Whether the source explicitly requested a rewrite of an in-force paragraph. */
  requiresActiveTarget?: boolean
  targetReviewAfter?: number
  /** The memory source the proposal was made for. */
  source: MemorySource
  settingsRevision: string
}>

/**
 * Where saves wait for the user when workspace memory is under ask. `request` hands over the exact
 * proposal and answers with the receipt to keep: normally the `awaiting-approval` receipt it was given,
 * or a refusal when the approval cannot be asked for.
 */
export type RefinementApprovals = {
  request(
    request: WorkspaceSaveRequest,
    proposal: MemoryProposal,
    pending: PendingParagraph,
  ): Promise<SaveReceipt>
  /** The receipts of this workspace a request in the decision list names; undefined when unreadable. */
  named?(workspaceRoot: string): Promise<ReadonlySet<string> | undefined>
}

export type WorkspaceSaveDeps = {
  registry(workspaceRoot: string): RefinementRegistry
  settings(): RefinementSettingsView
  /** The workspace's memory, opened outside any session; closed again after each use. */
  memory(workspaceRoot: string): MemorySession | undefined
  /** Absent: a save under ask is refused `unavailable`. */
  approvals?: RefinementApprovals
  /** The skill installer and the drafts kept for a person. Absent: a skill save is refused `unavailable`. */
  skills?: WorkspaceSkills
  /** The finished `workflow` runs of a session. Absent: a skill that names one is refused `workflow-run-unavailable`. */
  workflowRuns?: RefinementWorkflowRuns
  clock: () => number
}

/** A commit of a proposal the user approved, as the approval path hands it back. */
export type ApprovedCommit = PendingParagraph & { approved: { baseHash: string; newHash: string } }

export type WorkspaceSave = RefinementWorkspacePort & {
  /** Settles what a save cut off by a crash left in this workspace; nothing while refinement is off. */
  resume(workspaceRoot: string): Promise<void>
  /**
   * Commits an approved proposal. The registry must still hold its receipt as `awaiting-approval` for
   * the same paragraph and proposal, within `APPROVAL_TTL_MS`; the switch must be on at the revision it
   * was asked under; and the file must still give exactly that proposal. Otherwise `stale`, nothing
   * written. The revocation step is judged again: a save the user did not ask for is refused
   * `user-revoked` when the content was taken back meanwhile; the user's own clears the record once
   * it lands. The approval path does no judging of its own.
   */
  commitApproved(input: ApprovedCommit): Promise<{ receipt: SaveReceipt } | { stale: true }>
  settled: NonNullable<RefinementWorkspacePort['settled']>
}

export const steps = (verdicts: Partial<Record<Step, 'pass' | 'fail' | 'skip'>>): SaveReceipt['steps'] =>
  STEPS.map((step) => ({ step, verdict: verdicts[step] ?? 'skip' }))

const paragraphId = (): string => {
  const bytes = randomBytes(10)
  return `r${[...bytes].map((byte) => (byte % 36).toString(36)).join('')}`
}

/**
 * The one save-to-workspace path. Every entry point (an automatic save, the user's command or button,
 * the model's request) comes here, and every request is judged in the same fixed order:
 * 1. switch: refinement is on, at the revision the request was made under;
 * 2. revocation: content a user took back is refused for `auto` and `model` (`user-revoked`); the
 *    user's own save overrides, and clears the record once the save goes ahead;
 * 3. confirmations: only `auto` needs `PROMOTION_CONFIRMATIONS`;
 * 4. source and safety rules (`sourceRuleProblem`);
 * 5. memory mode: off refuses, ask waits for approval, auto writes (a provider without the paragraph
 *    port refuses `unsupported-provider`);
 * 6. capacity: a full memory refuses `memory-full`.
 * A memory or prompt entry becomes one managed paragraph (title, line break, content). A skill entry
 * becomes a workspace skill: installed when its name is free, updated when refinement installed it and
 * nobody changed it since; a change to a skill a person wrote or changed is only kept as a draft for
 * them (`conflict`). A saved skill whose folder a person deleted counts as taken back by the user. A
 * subagent is never saved (`subagent-review-unavailable`).
 *
 * Saves of one workspace run one at a time in this process. Each first reconciles the registry with the
 * memory file and settles what an earlier crash left. A receipt is kept in the registry for every
 * request that got past the switch; with the switch off nothing is read or written.
 */
export function createWorkspaceSave(deps: WorkspaceSaveDeps): WorkspaceSave {
  const queues = new Map<string, Promise<unknown>>()
  const inFlight = new Set<string>()
  const serial = <T>(root: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(root) ?? Promise.resolve()).then(work, work)
    const tail = run.catch(() => undefined)
    queues.set(root, tail)
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root)
    })
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
  const openMemory = (root: string): MemorySession | undefined => {
    try {
      return deps.memory(root)
    } catch {
      return undefined
    }
  }
  const withMemory = async <T>(root: string, work: (memory: MemorySession | undefined) => Promise<T>) => {
    const memory = openMemory(root)
    try {
      return await work(memory)
    } finally {
      await Promise.resolve(memory?.close?.()).catch(() => undefined)
    }
  }

  const save = async (request: WorkspaceSaveRequest): Promise<SaveReceipt> => {
    const base = receiptBase(request, deps.clock())
    if (!switchAt(request.settingsRevision))
      return { ...base, outcome: 'refused', reason: 'refinement-off', steps: steps({ switch: 'fail' }) }
    const root = request.session.workspaceRoot
    return serial(root, () =>
      withMemory(root, async (memory) => {
        const registry = deps.registry(root)
        // The run is read once however often the judgement is repeated, and only when it is needed.
        let read: ReturnType<typeof readRun> | undefined
        const run = () => {
          read ??= readRun(request)
          return read
        }
        for (let attempt = 0; ; attempt++) {
          try {
            return await judge({ request, base, registry, memory, run })
          } catch (error) {
            const failure = code(error)
            if (failure === 'REFINEMENT_SWITCH_CHANGED')
              return {
                ...base,
                outcome: 'refused',
                reason: 'refinement-off',
                steps: steps({ switch: 'fail' }),
              }
            if (failure === 'REGISTRY_REVISION_CONFLICT' && attempt === 0) continue
            const reason: SaveRefusal =
              failure === 'REGISTRY_REVISION_CONFLICT' ? 'conflict' : refusalOf(error)
            return refuse(registry, base, reason, { switch: 'pass' })
          }
        }
      }),
    )
  }

  /**
   * The finished run a skill request names, read for the requesting session: undefined when it names
   * none, or the host cannot read runs. A read that throws, or takes longer than Core's lookup bound,
   * is `not-found`.
   */
  async function readRun(
    request: WorkspaceSaveRequest,
  ): Promise<WorkflowRunView | 'not-found' | 'not-completed' | undefined> {
    const runId = request.entry.kind === 'skill' ? request.entry.workflowRun : undefined
    if (runId === undefined || !deps.workflowRuns) return undefined
    const port = deps.workflowRuns
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'not-found'>((resolve) => {
      timer = setTimeout(() => resolve('not-found'), WORKFLOW_RUN_LOOKUP_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          port.read({ key: request.session.key, lane: request.session.lane }, runId),
        ),
        late,
      ])
    } catch {
      return 'not-found'
    } finally {
      clearTimeout(timer)
    }
  }

  /** Steps 2 to 6 for one request, against the registry as it is now. */
  async function judge(input: {
    request: WorkspaceSaveRequest
    base: SaveReceipt
    registry: RefinementRegistry
    memory: MemorySession | undefined
    /** The finished run the request names; read at most once for the whole save. */
    run(): Promise<WorkflowRunView | 'not-found' | 'not-completed' | undefined>
  }): Promise<SaveReceipt> {
    const { request, registry, memory } = input
    let base: SaveReceipt = input.base
    if (memory) await reconcileWorkspace(registry, memory, deps.clock).catch(() => [])
    await resumeSaves(registry, memory, deps.clock, inFlight).catch(() => undefined)
    const verdicts: Partial<Record<Step, 'pass' | 'fail' | 'skip'>> = { switch: 'pass' }
    const refused = (reason: SaveRefusal, step: Step) =>
      refuse(registry, base, reason, { ...verdicts, [step]: 'fail' })
    // 2. Revocation. A registry that cannot be believed can rule nothing out, nor record an override.
    if (registry.unreadable())
      return {
        ...base,
        outcome: 'refused',
        reason: 'unavailable',
        steps: steps({ ...verdicts, revocation: 'fail' }),
      }
    let snapshot = registry.read()
    // A repeat is the same command from the same session for the same entry: another session's receipt
    // under the same command id is never the answer.
    const repeated = snapshot.receipts.find(
      (receipt) =>
        receipt.commandId === request.commandId &&
        receipt.source.sessionKey === base.source.sessionKey &&
        receipt.source.entryId === base.source.entryId &&
        receipt.outcome !== 'unknown' &&
        // An approval that ran out of time leaves the command free to be asked again.
        receipt.reason !== 'approval-expired',
    )
    if (repeated) return repeated
    // A skill generated from a finished workflow run is recognised by the hash of its definition, not
    // of the planner's words, in every step that compares content (revocation, an earlier save). The
    // run is read after a repeated command was answered from its receipt.
    const run = await input.run()
    if (typeof run === 'object')
      base = {
        ...base,
        source: { ...base.source, contentHash: normalizedWorkflowHash(run), fromWorkflow: true },
      }
    const skillName = request.entry.kind === 'skill' ? request.entry.id : undefined
    // A saved skill whose folder a person deleted was taken back like one removed on the skills page.
    if (skillName && deps.skills) {
      const root = request.session.workspaceRoot
      if (reconcileSkillDeletions(registry, snapshot, root, deps.skills, deps.clock()))
        snapshot = registry.read()
    }
    const revoked = registry.revoked(base.source, skillName)
    if (revoked && request.initiator !== 'user') return refused('user-revoked', 'revocation')
    verdicts.revocation = 'pass'
    const override = revoked
      ? (draft: RegistryRecords) => {
          draft.revocations = draft.revocations.filter(
            (record) => !revocationMatches(record, base.source, skillName),
          )
        }
      : undefined
    // 3. Confirmations: only an automatic save needs them.
    if (request.initiator === 'auto') {
      if (!(request.confirmations >= PROMOTION_CONFIRMATIONS)) return refused('unconfirmed', 'confirmations')
      verdicts.confirmations = 'pass'
    }
    // 4. Source and safety rules.
    const problem = sourceRuleProblem(request)
    if (problem) return refused(problem, 'rules')
    // A workflow run the session does not hold, or that did not finish, writes nothing; neither does a
    // definition whose names or tasks the source rules would not take as text.
    if (request.entry.kind === 'skill' && request.entry.workflowRun !== undefined) {
      if (run === undefined || run === 'not-found') return refused('workflow-run-unavailable', 'rules')
      if (run === 'not-completed') return refused('workflow-run-not-completed', 'rules')
      const unsafe = workflowTextProblem(run)
      if (unsafe) return refused(unsafe, 'rules')
    }
    verdicts.rules = 'pass'
    if (request.entry.kind === 'subagent')
      return refuse(registry, base, 'subagent-review-unavailable', verdicts)
    if (request.entry.kind === 'skill') {
      const decided = deps.skills
        ? await saveSkillChange({
            request,
            receiptId: base.receiptId,
            source: base.source,
            snapshot,
            registry,
            skills: deps.skills,
            clock: deps.clock,
            ...(typeof run === 'object' ? { workflow: run } : {}),
          })
        : undefined
      if (!decided) return refuse(registry, base, 'unavailable', verdicts)
      if ('refused' in decided) return refused(decided.refused, decided.step)
      const receipt: SaveReceipt = {
        ...base,
        outcome: decided.outcome,
        steps: steps({ ...verdicts, capacity: 'pass' }),
        target: decided.target,
      }
      writeFresh(registry, (draft) => {
        override?.(draft)
        putReceipt(draft, receipt)
        // The skill now holds this entry's content: a later revocation names this source.
        const target = decided.target
        const record = draft.skills.find(
          (skill) =>
            skill.name === target.name && skill.revision === target.revision && skill.state !== 'uninstalled',
        )
        if (record) record.source = { ...base.source }
      })
      return receipt
    }
    // 5. Memory mode, through the provider's paragraph port: one port for the whole request.
    const source: MemorySource = {
      sessionKey: request.session.key,
      turn: request.evidenceTurn ?? 0,
      maintenance: request.runId ?? request.commandId,
    }
    const port = memory ? paragraphPortOf(memory, source, new AbortController().signal) : undefined
    if (!memory || !port) return refused('unsupported-provider', 'memory-mode')
    let assertFileCurrent: ReturnType<typeof fileRevisionGuard>
    let mode: string
    try {
      assertFileCurrent = fileRevisionGuard(memory, 'REFINEMENT_SAVE_STALE')
      mode = (await memory.inspect()).settings.mode
    } catch {
      return refused('unavailable', 'memory-mode')
    }
    if (mode === 'off') return refused('memory-off', 'memory-mode')
    if (mode !== 'ask' && mode !== 'auto') return refused('unavailable', 'memory-mode')
    if (mode === 'ask' && !deps.approvals) return refused('unavailable', 'memory-mode')
    verdicts['memory-mode'] = 'pass'
    const text = paragraphText(request.entry)
    let listed: MemoryParagraphList
    let visible: Awaited<ReturnType<typeof paragraphVisibility>>
    try {
      listed = await port.list()
      visible = await paragraphVisibility(memory, 'workspace', listed, registry, deps.clock)
    } catch {
      return refused('unavailable', 'capacity')
    }
    // A rewrite belongs to the layer its paragraph is in: one of a user-memory section is never appended here.
    if (request.entry.replaces?.layer === 'user') return refused('conflict', 'capacity')
    const replaces = request.entry.replaces?.paragraphId
    const placed = placement(
      snapshot,
      base.source,
      text,
      deps.clock(),
      listed,
      'workspace',
      replaces,
      visible,
    )
    if (placed === 'busy' || placed === 'gone') return refused('conflict', 'capacity')
    if (placed === 'human-edited') return refused('human-edited', 'rules')
    const decision = {
      registry,
      decided: { revision: snapshot.revision },
      clock: deps.clock,
      switchCurrent: () => switchAt(request.settingsRevision),
      receipt: { ...base, steps: steps({ ...verdicts, capacity: 'pass' }) },
      ...(override ? { onSaved: override } : {}),
    }
    if ('existing' in placed) {
      if (!assertFileCurrent) return refused('conflict', 'capacity')
      return recordExisting({ ...decision, assertFileCurrent }, placed.existing)
    }
    const verifyTarget =
      replaces === undefined
        ? undefined
        : liveTargetDeadline(memory, 'workspace', port, registry, replaces, deps.clock)

    // Under ask the person sees the exact change after the provider's protection checks pass.
    if (mode === 'ask')
      return ask({
        request,
        base,
        registry,
        port,
        paragraph: placed.paragraph,
        ...(placed.targetReviewAfter === undefined ? {} : { targetReviewAfter: placed.targetReviewAfter }),
        baseHash: listed.hash,
        source,
        decided: decision.decided,
        verdicts,
      })
    // 6. Capacity is known once the change is proposed; the commit records the rest.
    const result = await commitParagraph({
      ...decision,
      ...placed,
      memory,
      port,
      mode,
      ...(verifyTarget ? { verifyTarget } : {}),
      inFlight,
    })
    if ('stale' in result) return refused('conflict', 'capacity')
    const { receipt } = result
    return receipt.reason === 'memory-full'
      ? { ...receipt, steps: steps({ ...verdicts, capacity: 'fail' }) }
      : receipt
  }

  /** Under ask: propose, keep the awaiting receipt, and hand the exact proposal to the approvals. */
  async function ask(input: {
    request: WorkspaceSaveRequest
    base: SaveReceipt
    registry: RefinementRegistry
    port: MemoryParagraphPort
    paragraph: ParagraphCommit['paragraph']
    targetReviewAfter?: number
    baseHash: string
    source: MemorySource
    decided: { revision: string }
    verdicts: Partial<Record<Step, 'pass' | 'fail' | 'skip'>>
  }): Promise<SaveReceipt> {
    const { request, base, registry, paragraph, verdicts } = input
    let proposal: MemoryProposal
    try {
      proposal = await input.port.propose({ ...paragraph, op: 'put' }, input.baseHash)
    } catch (error) {
      const reason = refusalOf(error)
      return refuse(registry, base, reason, {
        ...verdicts,
        ...(failedRules(reason) ? { rules: 'fail' } : {}),
        capacity: reason === 'memory-full' ? 'fail' : 'skip',
      })
    }
    const waiting: SaveReceipt = {
      ...base,
      outcome: 'awaiting-approval',
      steps: steps({ ...verdicts, capacity: 'pass' }),
      target: { kind: 'memory-paragraph', paragraphId: paragraph.id, fileHash: proposal.newHash },
    }
    if (deps.clock() >= (input.targetReviewAfter ?? Infinity))
      return refuse(registry, base, 'conflict', { ...verdicts, capacity: 'fail' })
    registry.update((draft) => putReceipt(draft, waiting), input.decided.revision)
    let kept: SaveReceipt
    try {
      kept = await (deps.approvals as RefinementApprovals).request(request, proposal, {
        workspaceRoot: request.session.workspaceRoot,
        receipt: waiting,
        paragraph,
        requiresActiveTarget: request.entry.replaces !== undefined,
        ...(input.targetReviewAfter === undefined ? {} : { targetReviewAfter: input.targetReviewAfter }),
        source: input.source,
        settingsRevision: request.settingsRevision,
      })
    } catch {
      kept = { ...waiting, outcome: 'refused', reason: 'unavailable' }
      delete kept.target
    }
    if (kept !== waiting) writeFresh(registry, (draft) => putReceipt(draft, kept))
    return kept
  }

  /**
   * A save that recorded its waiting receipt and stopped before its request reached the decision list
   * would wait for good: once it is older than an intent may take, a waiting receipt that no request
   * in the decision list names is settled as refused `unavailable`. Nothing happens when the list
   * cannot be read.
   */
  const settleUnasked = async (root: string, registry: RefinementRegistry): Promise<void> => {
    const now = deps.clock()
    const old = (receipt: SaveReceipt) =>
      receipt.outcome === 'awaiting-approval' && now - receipt.at >= INTENT_SETTLE_MS
    if (!registry.read().receipts.some(old) || !deps.approvals?.named) return
    const named = await deps.approvals.named(root).catch(() => undefined)
    if (!named) return
    writeFresh(registry, (draft) => {
      draft.receipts = draft.receipts.map((receipt) => {
        if (!old(receipt) || named.has(receipt.receiptId)) return receipt
        const { target: _target, ...rest } = receipt
        return { ...rest, outcome: 'refused', reason: 'unavailable', at: now }
      })
    })
  }

  const resume = async (root: string): Promise<void> => {
    try {
      if (!deps.settings().enabled) return
    } catch {
      return
    }
    await serial(root, async () => {
      const registry = deps.registry(root)
      await settleUnasked(root, registry)
      if (!registry.read().receipts.some(pendingIntent)) return
      await withMemory(root, (memory) => resumeSaves(registry, memory, deps.clock, inFlight))
    }).catch(() => undefined)
  }

  return {
    save,
    resume,
    commitApproved: (input) =>
      serial(input.workspaceRoot, () =>
        withMemory(input.workspaceRoot, async (memory) => {
          const stale = { stale: true as const }
          const registry = deps.registry(input.workspaceRoot)
          const port = memory
            ? paragraphPortOf(memory, input.source, new AbortController().signal)
            : undefined
          if (!memory || !port || !switchAt(input.settingsRevision) || registry.unreadable()) return stale
          await reconcileWorkspace(registry, memory, deps.clock).catch(() => [])
          // One snapshot decides: the receipt, its revocations, and the revision the commit must find.
          const snap = registry.read()
          const stored = snap.receipts.find((entry) => entry.receiptId === input.receipt.receiptId)
          if (!stored) return stale
          // Answered before: the receipt is settled (or its commit is under way); nothing to do again.
          if (stored.outcome !== 'awaiting-approval') return { receipt: stored }
          const settle = (receipt: SaveReceipt) => {
            try {
              registry.update((draft) => putReceipt(draft, receipt), snap.revision)
              return { receipt }
            } catch {
              return stale
            }
          }
          const without = (reason: SaveRefusal, failed?: Step): SaveReceipt => {
            const receipt: SaveReceipt = {
              ...stored,
              outcome: 'refused',
              reason,
              ...(failed
                ? {
                    steps: stored.steps.map((entry) =>
                      entry.step === failed
                        ? { ...entry, verdict: 'fail' as const }
                        : { ...entry, verdict: 'skip' as const },
                    ),
                  }
                : {}),
            }
            delete receipt.target
            return receipt
          }
          // Out of time: settled, so the same command may be asked again.
          if (deps.clock() >= stored.at + APPROVAL_TTL_MS) return settle(without('approval-expired'))
          // An approval of some other proposal than the one recorded.
          if (
            stored.target?.kind !== 'memory-paragraph' ||
            stored.target.paragraphId !== input.paragraph.id ||
            stored.target.fileHash !== input.approved.newHash
          )
            return stale
          // Step 2 again: what a person took back meanwhile wins over an earlier approval of a save
          // they did not ask for themselves.
          const revoked = snap.revocations.some((record) => revocationMatches(record, stored.source))
          if (revoked && stored.initiator !== 'user') return settle(without('user-revoked', 'revocation'))
          const target = snap.paragraphs.find((p) => p.id === input.paragraph.id)
          // Older approval rows do not distinguish a lineage update from an explicit rewrite.
          const requiresActiveTarget = input.requiresActiveTarget ?? target !== undefined
          const verifyTarget = requiresActiveTarget
            ? liveTargetDeadline(memory, 'workspace', port, registry, input.paragraph.id, deps.clock)
            : undefined
          const deadline = verifyTarget
            ? Math.min(input.targetReviewAfter ?? Infinity, await verifyTarget())
            : undefined
          if (deadline !== undefined && deps.clock() >= deadline) return settle(without('conflict'))
          const override = revoked
            ? (draft: RegistryRecords) => {
                draft.revocations = draft.revocations.filter(
                  (record) => !revocationMatches(record, stored.source),
                )
              }
            : undefined
          try {
            return await commitParagraph({
              registry,
              memory,
              port,
              mode: 'ask',
              paragraph: input.paragraph,
              receipt: stored,
              switchCurrent: () => switchAt(input.settingsRevision),
              clock: deps.clock,
              decided: { revision: snap.revision },
              ...(override ? { onSaved: override } : {}),
              approved: input.approved,
              ...(verifyTarget && deadline !== undefined
                ? { verifyTarget, targetReviewAfter: deadline }
                : {}),
              inFlight,
            })
          } catch {
            return stale
          }
        }),
      ),
    settled: async (root, receiptIds) => {
      try {
        if (!deps.settings().enabled) return []
      } catch {
        return []
      }
      await resume(root)
      const wanted = new Set(receiptIds)
      return deps
        .registry(root)
        .read()
        .receipts.filter((receipt) => wanted.has(receipt.receiptId) && !pendingIntent(receipt))
    },
  }
}

/** The receipt every outcome of `request` starts from. Its source hash is the shared normalised hash. */
export function receiptBase(request: WorkspaceSaveRequest, at: number): SaveReceipt {
  const source: SaveSource = {
    sessionKey: request.session.key,
    kind: request.entry.kind,
    entryId: request.entry.id,
    contentHash: normalizedContentHash(request.entry.content),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    initiator: request.initiator,
  }
  return {
    receiptId: randomUUID(),
    commandId: request.commandId,
    initiator: request.initiator,
    source,
    outcome: 'refused',
    steps: [],
    at,
  }
}

/** Records a refusal for `reason`, the steps up to it judged as given and the rest skipped. */
export function refuse(
  registry: RefinementRegistry,
  base: SaveReceipt,
  reason: SaveRefusal,
  verdicts: Partial<Record<Step, 'pass' | 'fail' | 'skip'>>,
): SaveReceipt {
  const receipt: SaveReceipt = { ...base, outcome: 'refused', reason, steps: steps(verdicts) }
  writeFresh(registry, (draft) => putReceipt(draft, receipt))
  return receipt
}

/**
 * Where a paragraph goes:
 * - the active paragraph that already holds exactly this text: nothing is written twice;
 * - this source entry's active paragraph: a new version replaces its verified bytes in place;
 * - the paragraph of an earlier save of this entry that was settled as not known but is still in the
 *   file: reuse its id when the previous bytes can be verified;
 * - else a new id.
 * `busy` while another process may still be saving this entry.
 */
export function placement(
  snapshot: RegistrySnapshot,
  source: SaveSource,
  text: string,
  now: number,
  listed: MemoryParagraphList,
  layer: 'workspace' | 'user',
  replaces: string | undefined,
  visible: Awaited<ReturnType<typeof paragraphVisibility>>,
):
  | { existing: ExistingParagraph }
  | Pick<ParagraphCommit, 'paragraph' | 'baseHash' | 'targetReviewAfter'>
  | 'busy'
  | 'gone'
  | 'human-edited' {
  const same = (other: SaveSource) =>
    other.sessionKey === source.sessionKey && other.kind === source.kind && other.entryId === source.entryId
  if (
    snapshot.receipts.some(
      (receipt) => pendingIntent(receipt) && same(receipt.source) && now - receipt.at < INTENT_SETTLE_MS,
    )
  )
    return 'busy'
  const active = snapshot.paragraphs.filter((paragraph) => paragraph.state === 'active')
  const inFile = new Map(listed.paragraphs.map((entry) => [entry.id, entry]))
  const hash = normalizedContentHash(text)
  const proof = (p: RegistryParagraph) => {
    const entry = inFile.get(p.id)
    const projection = entry && visible(entry)
    const deadline = targetDeadline(snapshot, entry, projection)
    return projection && now < deadline ? { deadline, projection } : undefined
  }
  const existing = (p: RegistryParagraph) => {
    if (
      inFile.get(p.id)?.text !== text ||
      p.contentHash !== hash ||
      (p.exactHash !== undefined ? p.exactHash !== sha256Hex(text) : p.fileHash !== listed.hash)
    )
      return
    const eligible = proof(p)
    if (!eligible) return
    const { refs, nextExpiry } = eligible.projection
    return {
      existing: {
        id: p.id,
        fileHash: listed.hash,
        refs,
        ...(nextExpiry === undefined ? {} : { nextExpiry }),
      },
    }
  }
  const matchesInterruptedIntent = (id: string, currentHash: string) =>
    snapshot.receipts.some(
      (r) =>
        r.outcome === 'unknown' &&
        same(r.source) &&
        r.target?.kind === 'memory-paragraph' &&
        r.target.paragraphId === id &&
        snapshot.intentTextHashes?.[r.receiptId] === currentHash,
    )
  const replace = (p: RegistryParagraph, targetReviewAfter?: number) => {
    const current = inFile.get(p.id)?.text
    if (current === undefined) return 'gone'
    const expected = p.exactHash ?? recordedTextHash(snapshot, listed.hash, p.id, current)
    // Workspace recovery can also confirm a change that already landed byte for byte.
    const currentHash = sha256Hex(current)
    const expectTextHash =
      layer === 'workspace' && current === text && matchesInterruptedIntent(p.id, currentHash)
        ? currentHash
        : expected
    if (currentHash !== expectTextHash) return 'human-edited'
    return {
      paragraph: { id: p.id, text, expectTextHash },
      ...(p.exactHash === undefined ? { baseHash: listed.hash } : {}),
      ...(targetReviewAfter === undefined ? {} : { targetReviewAfter }),
    }
  }
  // A rewrite of a saved paragraph goes into that paragraph only, and only while it is in force there.
  if (replaces !== undefined) {
    const target = active.find((p) => p.id === replaces)
    const eligible = target && proof(target)
    if (!target || !eligible) return 'gone'
    return existing(target) ?? replace(target, eligible.deadline)
  }
  for (const p of active) {
    const match = existing(p)
    if (match) return match
  }
  const lineage = active.find((paragraph) => same(paragraph.source))
  if (lineage) return replace(lineage)
  const left = snapshot.receipts.findLast(
    (receipt) =>
      receipt.outcome === 'unknown' &&
      receipt.reason !== undefined &&
      receipt.target?.kind === 'memory-paragraph' &&
      same(receipt.source) &&
      inFile.has(receipt.target.paragraphId) &&
      !active.some((paragraph) => paragraph.id === (receipt.target as { paragraphId: string }).paragraphId),
  )
  if (left?.target?.kind === 'memory-paragraph') {
    const id = left.target.paragraphId
    const current = inFile.get(id)?.text
    if (current === undefined) return 'gone'
    if (left.target.fileHash === listed.hash)
      return { paragraph: { id, text, expectTextHash: sha256Hex(current) }, baseHash: listed.hash }
    const currentHash = sha256Hex(current)
    if (snapshot.intentTextHashes?.[left.receiptId] === currentHash)
      return { paragraph: { id, text, expectTextHash: currentHash } }
    return 'human-edited'
  }
  const taken = new Set([...snapshot.paragraphs.map((paragraph) => paragraph.id), ...inFile.keys()])
  let id = paragraphId()
  while (taken.has(id)) id = paragraphId()
  return { paragraph: { id, text } }
}
