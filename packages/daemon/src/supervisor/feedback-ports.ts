import { randomUUID } from 'node:crypto'
import type { PackageAdminAuthority, PackageAdminService } from '@agnes/daemon-admin/packages/index'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import type { FeedbackPorts } from '@agnes/extension-api'
import type { Actor, AuthoringCandidate, EventEnvelope } from '@agnes/protocol'
import { jcs, rpcError, sha256Hex } from '@agnes/protocol'

/** Canonical reads include cold sessions. Mutations use the already-owned live writer. */
export function feedbackPorts(options: {
  context: CallContext
  profile: string
  authority: PackageAdminAuthority
  packages: PackageAdminService
  ids: readonly string[]
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
  return {
    now: () => new Date().toISOString(),
    id: randomUUID,
    sessions: async () => ({ ids: options.ids.slice(0, 256), truncated: options.ids.length > 256 }),
    scan: options.scan,
    append: async (id, type, data, actor: Actor) => {
      const written = await options
        .session(id)
        .append([{ type, data, actor, origin: 'system', trust: 'trusted', ignorable: true, lane: 'main' }])
      if (!written.seqs[0]) throw rpcError('SEMANTIC_REJECTED', { reason: 'FEEDBACK_NOT_PERSISTED' })
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
