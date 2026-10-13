import { type BatchStatus, type EventEnvelope, rpcError } from '@agnes/protocol'
import type { BatchPort } from '../local/ports.js'
import { reserveOwnedSession } from '../local/session-admission.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceBindingEnvelope, WorkspaceCatalog } from '../storage/workspaces.js'
import {
  BatchAccessError,
  type BatchEngine,
  type BatchHostPort,
  type BatchSessionsPort,
  newBatchId,
  toolBatchId,
} from './engine.js'
import { BatchSpecError, isBatchPrincipal, isItemSession, itemPrincipal, itemSessionBatchId } from './spec.js'

type TranscriptEntry = {
  session: { scan(q: { fromSeq: number; toSeq: number; limit: number }): Promise<unknown> }
}
type TranscriptRegistry = {
  get(key: string): TranscriptEntry | undefined
  open(o: {
    key: string
    cwd: string
    binding: WorkspaceBindingEnvelope
    resume: true
  }): Promise<TranscriptEntry>
  close(key: string): Promise<void>
}
type Engine = Pick<BatchEngine, 'begin' | 'status' | 'cancel' | 'list'>

const TRANSCRIPT_PAGE = 500
/** An item session is one or two short turns; a ledger past this is not read into memory. */
const MAX_TRANSCRIPT_PAGES = 100

/** Item sessions belong to the batch principal, are bound to the batch workspace, and are read back in pages. */
export function createItemSessions(input: {
  ownership: SessionPrincipalOwnership
  workspaces: WorkspaceCatalog
  registry: TranscriptRegistry
}): BatchSessionsPort {
  return {
    prepare: async ({ sessionKey, principalId, root }) => {
      // Only an item key, and only under the principal of the batch it names.
      const batchId = itemSessionBatchId(sessionKey)
      if (!batchId || principalId !== itemPrincipal(batchId))
        throw new Error('an item session must belong to the batch it names')
      const reserved = await reserveOwnedSession({
        ownership: input.ownership,
        workspaces: input.workspaces,
        principalId,
        sessionKey,
        canonicalRoot: root,
        hasSessionFact:
          input.registry.get(sessionKey) !== undefined ||
          input.workspaces.sessionPath(sessionKey) !== undefined,
      })
      if (reserved.reservedNew && !input.ownership.activateNew(sessionKey, principalId))
        throw new Error('item session activation was refused')
    },
    release: (sessionKey) => input.registry.close(sessionKey),
    // Read from the worker's ledger until a short page, not up to the daemon's cached head: the job
    // completes when its turn ends, and the turn's last rows may not have been streamed here yet.
    transcript: async (sessionKey) => {
      let entry = input.registry.get(sessionKey)
      if (!entry) {
        const binding = await input.workspaces.restoreBinding(sessionKey)
        entry = await input.registry.open({
          key: sessionKey,
          cwd: binding.canonicalRoot,
          binding,
          resume: true,
        })
      }
      const rows: EventEnvelope[] = []
      for (let page = 0, from = 1; ; page++, from += TRANSCRIPT_PAGE) {
        if (page === MAX_TRANSCRIPT_PAGES) throw new Error('the item ledger is too long to read')
        const found = (await entry.session.scan({
          fromSeq: from,
          toSeq: from + TRANSCRIPT_PAGE - 1,
          limit: TRANSCRIPT_PAGE,
        })) as EventEnvelope[]
        rows.push(...found)
        if (found.length < TRANSCRIPT_PAGE) return rows
      }
    },
  }
}

/**
 * Asks the worker that runs item sessions whether the hook that keeps them to the read tool is
 * registered there. The worker refuses to open or run an item session on its own when it is not.
 */
export function workerItemConfinement(
  acquire: () => Promise<{
    alive: boolean
    command(
      method: 'batch.confinement',
      params: Record<string, unknown>,
      o: { timeoutMs: number },
    ): Promise<unknown>
  }>,
): BatchHostPort {
  return {
    itemConfinementReady: async () => {
      const link = await acquire()
      if (!link.alive) throw new Error('the session worker is not running')
      const answer = await link.command('batch.confinement', {}, { timeoutMs: 30_000 })
      return (answer as { ready?: unknown } | null)?.ready === true
    },
  }
}

const rpcRefusal = (error: unknown): never => {
  if (error instanceof BatchSpecError)
    throw rpcError('SEMANTIC_REJECTED', { code: 'BATCH_SPEC_INVALID', reason: error.message })
  if (error instanceof BatchAccessError)
    throw rpcError('SEMANTIC_REJECTED', { code: 'BATCH_NOT_FOUND', reason: error.message })
  throw error
}

/** The local CLI entry: the principal is the connection's, the workspace is the registered folder it names. */
export function createBatchPort(input: {
  engine: Engine
  workspaces: Pick<WorkspaceCatalog, 'bind'>
}): BatchPort {
  return {
    start: async ({ principalId, cwd, spec }) => {
      // Item sessions are bound to this root, so it must be a registered workspace, as for session/new.
      const root = (await input.workspaces.bind(undefined, cwd)).path
      return input.engine
        .begin({ batchId: newBatchId(), principalId, root, cwd: root, spec })
        .catch(rpcRefusal)
    },
    status: ({ principalId, batchId, export: exportNow }) =>
      input.engine.status(principalId, batchId, exportNow === true).catch(rpcRefusal),
    cancel: ({ principalId, batchId }) => input.engine.cancel(principalId, batchId).catch(rpcRefusal),
    list: async ({ principalId }) => input.engine.list(principalId),
  }
}

/** A refusal whose message is written for the model that called the tool. */
class BatchRequestRefused extends Error {
  override readonly name = 'BatchRequestRefused'
}

/**
 * The session tool entry: `sessionKey` is the one the worker transport stamped, never the request's.
 * Messages reach the model, so only the engine's own refusals are passed on word for word.
 */
export function createBatchRequests(input: {
  engine: Pick<Engine, 'begin' | 'status' | 'cancel'>
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  workspaces: { restoreBinding(sessionKey: string): Promise<WorkspaceBindingEnvelope> }
  log?: (message: string) => void
}): (sessionKey: string, params: unknown) => Promise<BatchStatus> {
  const plain = (error: unknown): never => {
    if (
      error instanceof BatchSpecError ||
      error instanceof BatchAccessError ||
      error instanceof BatchRequestRefused
    )
      throw new Error(error.message)
    input.log?.(`batch request failed: ${error instanceof Error ? error.message : String(error)}`)
    throw new Error('The daemon could not complete the batch request; see the daemon log.')
  }
  const handle = async (sessionKey: string, params: unknown): Promise<BatchStatus> => {
    // Refused on the key alone (it only takes more away), and again on a batch owner below.
    if (isItemSession(sessionKey))
      throw new BatchRequestRefused('A batch item cannot start or control batches.')
    let owner: ReturnType<typeof input.ownership.resolve>
    try {
      owner = input.ownership.resolve(sessionKey)
    } catch {
      owner = undefined
    }
    if (!owner?.active) throw new BatchRequestRefused('The session owner is unavailable.')
    if (isBatchPrincipal(owner.principalId))
      throw new BatchRequestRefused('A batch item cannot start or control batches.')
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    if (p.op === 'start' && typeof p.toolUseId === 'string' && typeof p.cwd === 'string') {
      const binding = await input.workspaces.restoreBinding(sessionKey)
      return input.engine.begin({
        batchId: toolBatchId(sessionKey, p.toolUseId),
        principalId: owner.principalId,
        root: binding.canonicalRoot,
        cwd: p.cwd,
        spec: p.spec,
        origin: sessionKey,
      })
    }
    if (typeof p.batchId !== 'string') throw new BatchRequestRefused('batchId is required')
    if (p.op === 'status') return input.engine.status(owner.principalId, p.batchId, p.export === true)
    if (p.op === 'cancel') return input.engine.cancel(owner.principalId, p.batchId)
    throw new BatchRequestRefused('unknown batch request')
  }
  return (sessionKey, params) => handle(sessionKey, params).catch(plain)
}
