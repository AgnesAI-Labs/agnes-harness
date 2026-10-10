import { randomUUID } from 'node:crypto'
import type { PackageAdminAuthority, PackageAdminService } from '@agnes/daemon-admin/packages/index'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { FEEDBACK_EVENT, FEEDBACK_GROWTH_EVENT, type FeedbackPorts } from '@agnes/extension-api'
import type { Actor, AuthoringCandidate, EventEnvelope } from '@agnes/protocol'
import { inspectJsonData, jcs, rpcError, sha256Hex, validateAgainst } from '@agnes/protocol'
import { FeedbackItem } from '@agnes/protocol/gen/app-server'

/** Canonical reads include cold sessions. Mutations use the already-owned live writer. */
export function feedbackPorts(options: {
  context: CallContext
  profile: string
  authority: PackageAdminAuthority
  packages: PackageAdminService
  ids: readonly string[]
  /** Re-check the invocation scope, current local grant, session owner and fitted actor. */
  authorize(id: string): Promise<Actor>
  scan(id: string, types: readonly string[]): Promise<readonly EventEnvelope[]>
  session(id: string): {
    append(tx: unknown[]): Promise<{ seqs: number[] }>
    draftFeedback(
      feedback: Parameters<FeedbackPorts['draft']>[1],
      evidence: readonly EventEnvelope[],
      signal: AbortSignal,
    ): Promise<readonly { path: string; content: string }[]>
  }
}): FeedbackPorts {
  const growthKey = (sessionKey: string, feedback: Parameters<FeedbackPorts['candidate']>[1]) =>
    'feedback-' +
    sha256Hex(
      jcs([options.profile, options.authority.principalId, sessionKey, feedback.id, feedback.revision]),
    )
  const growthAuthority = { ...options.authority, clientId: 'feedback-growth' }
  const issuedIds = new Set<string>()
  const denied = (): never => {
    throw rpcError('CAPABILITY_DENIED', { reason: 'FEEDBACK_APPEND_FORBIDDEN' })
  }
  return {
    now: () => new Date().toISOString(),
    id: () => {
      const id = randomUUID()
      issuedIds.add(id)
      return id
    },
    sessions: async () => ({ ids: options.ids.slice(0, 256), truncated: options.ids.length > 256 }),
    scan: options.scan,
    append: async (id, type, data, actor: Actor) => {
      if (type !== FEEDBACK_EVENT && type !== FEEDBACK_GROWTH_EVENT) denied()
      if (!inspectJsonData(data, 65536).ok) denied()
      const value = structuredClone(data),
        claimedActor = structuredClone(actor)
      const authenticated = structuredClone(await options.authorize(id))
      if (jcs(claimedActor) !== jcs(authenticated)) denied()
      const rows = await options.scan(id, [FEEDBACK_EVENT])
      const owned = rows.filter(
        (row) =>
          row.type === FEEDBACK_EVENT &&
          row.origin === 'system' &&
          row.trust === 'trusted' &&
          row.lane === 'main' &&
          row.actor.id === authenticated.id &&
          row.actor.org === authenticated.org &&
          (row.data as { sessionId?: unknown }).sessionId === id,
      )
      if (type === FEEDBACK_EVENT) {
        if (
          value.sessionId !== id ||
          value.actor !== authenticated.id ||
          Object.hasOwn(value, 'revision') ||
          !validateAgainst(FeedbackItem, { ...value, revision: 1 }).ok
        )
          denied()
        const previous = owned.findLast((row) => (row.data as { id?: unknown }).id === value.id)
        if (!previous && (typeof value.id !== 'string' || !issuedIds.has(value.id))) denied()
      } else {
        const fields = ['feedbackId', 'feedbackRevision', 'messageSeq', 'candidateId', 'candidateHash']
        if (
          Object.keys(value).length !== fields.length ||
          fields.some((field) => !Object.hasOwn(value, field))
        )
          denied()
        const source = owned.find(
          (row) =>
            row.seq === value.feedbackRevision && (row.data as { id?: unknown }).id === value.feedbackId,
        )
        if (
          !source ||
          (source.data as { target?: { messageSeq?: unknown } }).target?.messageSeq !== value.messageSeq ||
          !Number.isSafeInteger(value.messageSeq) ||
          typeof value.candidateId !== 'string' ||
          typeof value.candidateHash !== 'string'
        )
          denied()
      }
      // Reads can await a cold backend: re-check authority immediately before handing off to the writer.
      const currentActor = structuredClone(await options.authorize(id))
      if (jcs(currentActor) !== jcs(authenticated)) denied()
      const written = await options
        .session(id)
        .append([
          {
            type,
            data: value,
            actor: currentActor,
            origin: 'system',
            trust: 'trusted',
            ignorable: true,
            lane: 'main',
          },
        ])
      if (!written.seqs[0]) throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_NOT_PERSISTED' })
      if (type === FEEDBACK_EVENT && typeof value.id === 'string') issuedIds.delete(value.id)
      return written.seqs[0]
    },
    draft: (id, feedback, evidence, signal) => {
      signal.throwIfAborted()
      return options.session(id).draftFeedback(feedback, evidence, signal)
    },
    recoverCandidate: async (sessionKey, feedback, signal) => {
      signal.throwIfAborted()
      if (!options.packages.candidateForCommand)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_PROVENANCE_UNAVAILABLE' })
      return options.packages.candidateForCommand(
        options.profile,
        growthKey(sessionKey, feedback),
        growthAuthority,
      )
    },
    candidate: async (sessionKey, feedback, files, signal) => {
      signal.throwIfAborted()
      return (await options.packages.call(
        '_agnes/v1/plugins.candidates.create',
        {
          profile: options.profile,
          clientId: growthAuthority.clientId,
          commandId: growthKey(sessionKey, feedback),
          files: [...files],
        },
        {
          ...growthAuthority,
          installer: 'agent',
          authoringSignal: signal,
          authoringOrigin: {
            sessionKey,
            turn: feedback.target.turn!,
            toolUseId: growthKey(sessionKey, feedback),
            packageId: '@agnes/feedback',
            rowId: 'feedback:default',
            snapshotId: 'builtin',
            feedbackId: feedback.id,
            feedbackRevision: feedback.revision,
            messageSeq: feedback.target.messageSeq!,
          },
        },
      )) as AuthoringCandidate
    },
    evidence: async (candidateId) => {
      if (!options.packages.candidateEvidence)
        throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_PROVENANCE_UNAVAILABLE' })
      return options.packages.candidateEvidence(options.profile, candidateId, options.authority)
    },
  }
}
