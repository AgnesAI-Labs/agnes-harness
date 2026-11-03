import { createHash } from 'node:crypto'
import { decisionSubjectDigest, type RefinementSettingsView } from '@agnes/core'
import type { MemoryProposal, MemorySession } from '@agnes/extension-api'
import {
  HOST_DECISION_ACTIVATION,
  type HostDecisionOwner,
  type ProfileJournal,
  type ProfileOperation,
} from '@agnes/host-extensions/profile/runtime'
import {
  APPROVAL_TTL_MS,
  type RefinementRegistry,
  type SaveReceipt,
  type SaveRefusal,
} from '@agnes/host-infrastructure/refinement-registry'
import type { Actor, DecisionSpec, JsonValue } from '@agnes/protocol'
import { paragraphPortOf } from './reconcile.js'
import { putReceipt, refusalOf, writeFresh } from './workspace-commit.js'
import type { ApprovedCommit, PendingParagraph, RefinementApprovals } from './workspace-save.js'

/** The owner name the save approvals carry in the profile decision journal. */
export const REFINEMENT_DECISION_OWNER = 'core/refinement'
/** The operation name a save approval is kept under. */
export const REFINEMENT_DECISION_SERVICE = 'workspace-save'
const SOURCE_PACKAGE = 'host'
const SOURCE_VERSION = '1'
const FIELD_MAX = 8192

type CommitResult = { receipt: SaveReceipt } | { stale: true }

export type RefinementApprovalsDeps = {
  /** The profile decision journal and the person its decisions are asked of; throws while there is none. */
  decisions(): Promise<{ journal: ProfileJournal; actor: Actor }>
  registry(workspaceRoot: string): RefinementRegistry
  /** The workspace's memory outside any session; closed after each use. */
  memory(workspaceRoot: string): MemorySession | undefined
  settings(): RefinementSettingsView
  /** Commits an approved proposal (the save service's `commitApproved`). */
  commit(input: ApprovedCommit): Promise<CommitResult>
  clock(): number
}

/** What a waiting approval keeps in its operation row: enough to commit it, or to ask again. */
type Waiting = {
  pending: PendingParagraph
  proposal: { path: string; baseHash: string; newHash: string }
  expiresAt: number
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The waiting approval an operation row holds; undefined for a row this module did not write. */
function waitingOf(operation: ProfileOperation): Waiting | undefined {
  const value = operation.prepared as unknown
  if (
    operation.owner !== REFINEMENT_DECISION_OWNER ||
    operation.service !== REFINEMENT_DECISION_SERVICE ||
    !plain(value) ||
    !plain(value.pending) ||
    !plain(value.proposal) ||
    typeof value.expiresAt !== 'number'
  )
    return undefined
  const { pending, proposal } = value
  if (
    !str(pending.workspaceRoot) ||
    !str(pending.settingsRevision) ||
    !plain(pending.receipt) ||
    !str(pending.receipt.receiptId) ||
    !plain(pending.paragraph) ||
    !str(pending.paragraph.id) ||
    !str(pending.paragraph.text) ||
    !plain(pending.source) ||
    !str(proposal.path) ||
    !str(proposal.baseHash) ||
    !str(proposal.newHash)
  )
    return undefined
  return structuredClone(value) as unknown as Waiting
}

/**
 * Saves into workspace memory under ask wait here, in the profile decision journal, beside plugin
 * services' approvals. A request belongs to the workspace, not to the session that made it, so it outlives
 * that session. The person sees the exact change (the whole-file diff and the base and new hashes) and
 * approves that change only:
 * - it stands while refinement is on at the revision it was asked under, for `APPROVAL_TTL_MS`, while its
 *   receipt still waits for exactly this change, and while nothing revoked the content; otherwise it is
 *   withdrawn, and switching refinement off and on again does not bring it back;
 * - approved, the switch, the expiry, the receipt and the revocations are checked again, and the commit
 *   writes only if the file still gives exactly the approved change; when the file changed meanwhile,
 *   nothing is written and the change is proposed again on the file as it is now and asked for anew;
 * - rejected, the save is refused `user-revoked` and the content is recorded as withdrawn, so it is not
 *   offered again unless the user saves it;
 * - a background save is never approved automatically, whatever the session's permission mode.
 * While refinement is off nothing here reads or writes the registry; a request it ended is settled once
 * refinement is on again.
 */
export function createRefinementApprovals(
  deps: RefinementApprovalsDeps,
): RefinementApprovals & { owner: HostDecisionOwner } {
  const switchOf = (waiting: Waiting): 'off' | 'changed' | 'current' => {
    try {
      const view = deps.settings()
      if (view.enabled !== true) return 'off'
      return view.revision === waiting.pending.settingsRevision ? 'current' : 'changed'
    } catch {
      return 'off'
    }
  }

  /** Why a waiting approval no longer stands, if it does not. Reads the registry only while switched on. */
  const problemOf = (waiting: Waiting): SaveRefusal | 'superseded' | undefined => {
    const at = switchOf(waiting)
    if (at !== 'current') return 'refinement-off'
    if (deps.clock() >= waiting.expiresAt) return 'approval-expired'
    const registry = deps.registry(waiting.pending.workspaceRoot)
    if (registry.unreadable()) return 'unavailable'
    const receipt = registry
      .read()
      .receipts.find((entry) => entry.receiptId === waiting.pending.receipt.receiptId)
    if (
      receipt?.outcome !== 'awaiting-approval' ||
      receipt.target?.kind !== 'memory-paragraph' ||
      receipt.target.fileHash !== waiting.proposal.newHash
    )
      return 'superseded'
    if (deps.clock() >= receipt.at + APPROVAL_TTL_MS) return 'approval-expired'
    // A revocation made since the request bars it. One from before can only stand under a user's own save,
    // which overrides it (any other save was refused for it then).
    const revoked = registry.revoked(receipt.source)
    if (revoked && revoked.at >= receipt.at) return 'user-revoked'
    return undefined
  }

  /**
   * Settles the save's receipt as refused, if it still waits for this change; a rejection also records
   * the content as withdrawn so it is not saved again without the user. False when the registry could not
   * be written, so the caller keeps what it needs to try again.
   */
  const settle = (waiting: Waiting, reason: SaveRefusal, rejected = false): boolean => {
    if (switchOf(waiting) === 'off') return true
    const registry = deps.registry(waiting.pending.workspaceRoot)
    return writeFresh(registry, (draft) => {
      const receipt = draft.receipts.find((entry) => entry.receiptId === waiting.pending.receipt.receiptId)
      if (
        receipt?.outcome !== 'awaiting-approval' ||
        receipt.target?.kind !== 'memory-paragraph' ||
        receipt.target.fileHash !== waiting.proposal.newHash
      )
        return
      const refused: SaveReceipt = { ...receipt, outcome: 'refused', reason }
      delete refused.target
      putReceipt(draft, refused)
      if (rejected)
        draft.revocations.push({
          sessionKey: receipt.source.sessionKey,
          kind: receipt.source.kind,
          entryId: receipt.source.entryId,
          contentHash: receipt.source.contentHash,
          action: 'memory-withdrawn',
          at: deps.clock(),
        })
    })
  }

  const sourceFor = (operationId: string, waiting: Waiting) => ({
    owner: REFINEMENT_DECISION_OWNER,
    operationId,
    sourcePackage: SOURCE_PACKAGE,
    packageVersion: SOURCE_VERSION,
    alive() {
      if (switchOf(waiting) !== 'current')
        throw Object.assign(new Error('refinement switch changed'), {
          code: 'REFINEMENT_SWITCH_CHANGED',
        })
    },
  })

  /**
   * Puts one exact proposal in front of the person: a new decision and the operation row that keeps it.
   * Each request of a save is numbered, so asking again for a change asked about before (a file that went
   * back to an earlier state) is a new decision, never the old, already answered one.
   */
  const ask = async (pending: PendingParagraph, proposal: MemoryProposal): Promise<void> => {
    const { journal, actor } = await deps.decisions()
    const subjectRevision = sha256(`${proposal.baseHash}:${proposal.newHash}`)
    const round = [...journal.operations.values()].filter(
      (row) =>
        row.owner === REFINEMENT_DECISION_OWNER &&
        row.receipt.operationId.startsWith(`${pending.receipt.receiptId}:`),
    ).length
    const operationId = `${pending.receipt.receiptId}:${subjectRevision}:${round}`
    const waiting: Waiting = {
      pending: structuredClone(pending),
      proposal: { path: proposal.path, baseHash: proposal.baseHash, newHash: proposal.newHash },
      expiresAt: deps.clock() + APPROVAL_TTL_MS,
    }
    const input = {
      workspaceRoot: pending.workspaceRoot,
      paragraphId: pending.paragraph.id,
      baseHash: proposal.baseHash,
      newHash: proposal.newHash,
    }
    const port = journal.decisions(actor, APPROVAL_TTL_MS).port(sourceFor(operationId, waiting))
    const handle = await port.request(specFor(operationId, pending, proposal, subjectRevision))
    const fresh = await port.get(handle)
    if (fresh.result || fresh.consumption || fresh.invalidation)
      throw Object.assign(new Error('decision already used'), { code: 'REFINEMENT_DECISION_USED' })
    const key = decisionSubjectDigest({ owner: REFINEMENT_DECISION_OWNER, operationId })
    const operation: ProfileOperation = {
      key,
      control: null,
      requestDigest: decisionSubjectDigest({ service: REFINEMENT_DECISION_SERVICE, input }),
      digest: decisionSubjectDigest({ owner: REFINEMENT_DECISION_OWNER, input, prepared: waiting }),
      actorId: actor.id,
      owner: REFINEMENT_DECISION_OWNER,
      service: REFINEMENT_DECISION_SERVICE,
      source: 'refinement',
      activationId: HOST_DECISION_ACTIVATION,
      receipt: { state: 'approval-required', operationId, decision: handle },
      input,
      prepared: waiting as unknown as JsonValue,
    }
    await journal.locked(async () => {
      if (!journal.operations.has(key)) await journal.write(operation)
    })
  }

  /**
   * The file changed under an approved change: propose it again on the file as it is now, and ask anew.
   * `failed` when the registry could not be written, so neither a new request nor a refusal was recorded.
   */
  const askAgain = async (waiting: Waiting): Promise<'asked' | 'settled' | 'failed'> => {
    const { pending } = waiting
    const ended = (recorded: boolean) => (recorded ? 'settled' : 'failed')
    const at = switchOf(waiting)
    if (at !== 'current') return ended(at === 'changed' ? settle(waiting, 'refinement-off') : true)
    let memory: MemorySession | undefined
    try {
      memory = deps.memory(pending.workspaceRoot)
      const port = memory && paragraphPortOf(memory, pending.source, new AbortController().signal)
      if (!memory || !port) return ended(settle(waiting, 'unsupported-provider'))
      const mode = (await memory.inspect()).settings.mode
      if (mode !== 'ask' && mode !== 'auto')
        return ended(settle(waiting, mode === 'off' ? 'memory-off' : 'unavailable'))
      const proposal = await port.propose({
        op: 'put',
        id: pending.paragraph.id,
        text: pending.paragraph.text,
      })
      // The same change again means the commit failed for another reason: asking again would not help.
      if (proposal.baseHash === waiting.proposal.baseHash && proposal.newHash === waiting.proposal.newHash)
        return ended(settle(waiting, 'conflict'))
      // Waiting again from now: the new request gets the whole approval period.
      const receipt: SaveReceipt = {
        ...pending.receipt,
        at: deps.clock(),
        target: { kind: 'memory-paragraph', paragraphId: pending.paragraph.id, fileHash: proposal.newHash },
      }
      let moved = false
      const written = writeFresh(deps.registry(pending.workspaceRoot), (draft) => {
        const stored = draft.receipts.find((entry) => entry.receiptId === receipt.receiptId)
        moved =
          stored?.outcome === 'awaiting-approval' &&
          stored.target?.kind === 'memory-paragraph' &&
          stored.target.fileHash === waiting.proposal.newHash
        if (moved) putReceipt(draft, receipt)
      })
      // Ask only for the change the stored receipt now names.
      if (!written) return 'failed'
      if (!moved) return 'settled'
      try {
        await ask({ ...pending, receipt }, proposal)
        return 'asked'
      } catch {
        return ended(settle({ ...waiting, proposal }, 'unavailable'))
      }
    } catch (error) {
      return ended(settle(waiting, refusalOf(error)))
    } finally {
      await Promise.resolve(memory?.close?.()).catch(() => undefined)
    }
  }

  const finish = (
    journal: ProfileJournal,
    operation: ProfileOperation,
    receipt: ProfileOperation['receipt'],
  ) => journal.write({ ...operation, receipt })

  /** Commits an approved save and finishes its operation; a moved file or target is asked about again. */
  const commitAndFinish = async (
    journal: ProfileJournal,
    run: ProfileOperation,
    waiting: Waiting,
    operationId: string,
  ): Promise<void> => {
    let result: CommitResult
    try {
      result = await deps.commit({
        ...waiting.pending,
        approved: { baseHash: waiting.proposal.baseHash, newHash: waiting.proposal.newHash },
      })
    } catch {
      result = { stale: true }
    }
    // Only a file or target that moved since the approval (`stale`) is asked about again.
    const again = 'stale' in result ? await askAgain(waiting) : undefined
    await journal.locked(() =>
      finish(
        journal,
        run,
        'receipt' in result
          ? { state: 'completed', operationId, output: { outcome: result.receipt.outcome } }
          : {
              state: 'refused',
              operationId,
              code: again === 'failed' ? 'REGISTRY_WRITE_FAILED' : 'APPROVAL_STALE',
            },
      ),
    )
  }

  // Approved operations whose commit runs in this process now, so a listing meanwhile does not run it twice.
  const committing = new Set<string>()
  const owner: HostDecisionOwner = {
    alive(operation) {
      const waiting = waitingOf(operation)
      return waiting !== undefined && problemOf(waiting) === undefined
    },
    async answered(operation, decision) {
      const { journal, actor } = await deps.decisions()
      const waiting = waitingOf(operation)
      const operationId = operation.receipt.operationId
      // While refinement is off the request is left as it is; it is settled once refinement is on again.
      if (waiting && switchOf(waiting) === 'off') return
      const answered = decision.result?.reason === 'answered' && !decision.invalidation
      const approved =
        answered &&
        decision.result?.reason === 'answered' &&
        decision.result.response.option === 'allowed-once'
      const next = await journal.locked(async () => {
        const current = journal.operations.get(operation.key)
        // A process that stopped after taking the approval and before the commit finished left the row
        // running (marked unknown once the journal reopens): the commit is handed over again; it settles
        // a receipt only once.
        if (
          current?.receipt.state === 'running' ||
          (current?.receipt.state === 'unknown' && current.receipt.code === 'OUTCOME_UNKNOWN')
        ) {
          if (!waiting || !approved || committing.has(operation.key)) return undefined
          committing.add(operation.key)
          return { run: current }
        }
        if (current?.receipt.state !== 'approval-required') return undefined
        if (!waiting) {
          await finish(journal, current, { state: 'refused', operationId, code: 'INVALID_REQUEST' })
          return undefined
        }
        const problem: SaveRefusal | 'superseded' | undefined = approved
          ? problemOf(waiting)
          : answered
            ? 'user-revoked'
            : (problemOf(waiting) ?? 'unavailable')
        if (problem) {
          const rejected = answered && !approved
          // The refusal is recorded first; while it cannot be, the operation keeps waiting and the next
          // listing settles it again.
          if (problem !== 'superseded' && !settle(waiting, problem, rejected)) return undefined
          await finish(journal, current, {
            state: 'refused',
            operationId,
            code: rejected ? 'APPROVAL_REFUSED' : 'APPROVAL_WITHDRAWN',
          })
          return undefined
        }
        const events = journal
          .decisions(actor, APPROVAL_TTL_MS)
          .consumptionEvents([decision.handle], sourceFor(operationId, waiting), operationId)
        await journal.write({ ...current, receipt: { state: 'running', operationId } }, events)
        committing.add(operation.key)
        return { run: current }
      })
      if (!next || !waiting) return
      try {
        await commitAndFinish(journal, next.run, waiting, operationId)
      } finally {
        committing.delete(operation.key)
      }
    },
  }

  return {
    owner,
    async request(_request, proposal, pending) {
      await ask(pending, proposal)
      return pending.receipt
    },
    /** The receipts of a workspace that a request in the decision list names, whatever its state. */
    async named(workspaceRoot: string): Promise<ReadonlySet<string> | undefined> {
      try {
        const { journal } = await deps.decisions()
        const ids = new Set<string>()
        for (const operation of journal.operations.values()) {
          const waiting = waitingOf(operation)
          if (waiting?.pending.workspaceRoot === workspaceRoot) ids.add(waiting.pending.receipt.receiptId)
        }
        return ids
      } catch {
        return undefined
      }
    },
  }
}

/** The decision a person sees: the exact whole-file change, its hashes, and the paragraph it adds. */
function specFor(
  operationId: string,
  pending: PendingParagraph,
  proposal: MemoryProposal,
  subjectRevision: string,
): DecisionSpec {
  const fields = (labels: {
    workspace: string
    file: string
    base: string
    next: string
    text: string
    diff: string
    clipped: string
  }) => [
    { label: labels.workspace, value: pending.workspaceRoot.slice(0, FIELD_MAX) },
    { label: labels.file, value: proposal.path.slice(0, FIELD_MAX) },
    { label: labels.base, value: proposal.baseHash },
    { label: labels.next, value: proposal.newHash },
    { label: labels.text, value: pending.paragraph.text.slice(0, FIELD_MAX) },
    // A change too long for the card is clipped with a note; the whole change stays in the request.
    {
      label: labels.diff,
      value:
        proposal.diff.length <= FIELD_MAX
          ? proposal.diff
          : `${proposal.diff.slice(0, FIELD_MAX - labels.clipped.length - 1)}\n${labels.clipped}`,
    },
  ]
  return {
    key: operationId,
    purpose: 'memory.write',
    subject: {
      workspaceRoot: pending.workspaceRoot,
      path: proposal.path,
      paragraphId: pending.paragraph.id,
      baseHash: proposal.baseHash,
      newHash: proposal.newHash,
      subjectRevision,
      diff: proposal.diff,
    },
    prompt:
      'Save this task experience to workspace memory? Approving writes exactly this change, and only onto the file whose hash is the base hash.',
    options: ['allowed-once', 'rejected'],
    responseSchema: { type: 'null' },
    presentation: {
      en: {
        title: 'Save task experience to workspace memory',
        fields: fields({
          workspace: 'Workspace',
          file: 'File',
          base: 'Base hash',
          next: 'New hash',
          text: 'Paragraph to add',
          diff: 'Exact change',
          clipped: '[cut short here; the full change is in the request details]',
        }),
      },
      'zh-CN': {
        title: '把任务经验保存到工作区记忆',
        fields: fields({
          workspace: '工作区',
          file: '文件',
          base: '原文件 hash',
          next: '新文件 hash',
          text: '要添加的段落',
          diff: '确切改动',
          clipped: '[此处截断；完整改动见请求详情]',
        }),
      },
    },
  }
}
