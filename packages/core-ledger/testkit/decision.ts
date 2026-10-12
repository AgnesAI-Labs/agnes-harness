import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { Actor, DecisionSnapshot, JsonValue } from '@agnes/protocol'

const requester: Actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/** Synthetic current-format requests for ledger and recovery contracts. */
export function pendingDecision(
  id: string,
  options: {
    sessionId?: string
    operationId?: string
    owner?: string
    lane?: string
    subject?: JsonValue
    actor?: Actor
  } = {},
): DecisionSnapshot {
  const subject = options.subject ?? {}
  return {
    handle: { id, sessionId: options.sessionId ?? 'k' },
    revision: 1,
    request: {
      spec: {
        key: id,
        purpose: 'tool.permission',
        subject,
        prompt: 'Review synthetic action',
        options: ['allowed-once', 'allowed-session', 'rejected'],
      },
      subjectDigest: sha256Hex(canonicalJson(subject)),
      owner: options.owner ?? 'core/tool-permission',
      operationId: options.operationId ?? id,
      sourcePackage: '@agnes/core',
      packageVersion: '0.0.0',
      requestedBy: options.actor ?? requester,
      lane: options.lane ?? 'main',
      createdAt: '2025-09-07T00:00:00.000Z',
      expiresAt: '2026-09-13T00:10:00.000Z',
    },
    result: null,
    answerCommand: null,
    consumption: null,
    invalidation: null,
  }
}
export function answeredDecision(
  value: DecisionSnapshot,
  seq: number,
  option = 'allowed-once',
): DecisionSnapshot {
  return {
    ...value,
    revision: 2,
    result: {
      reason: 'answered',
      at: '2025-09-07T00:00:00.001Z',
      response: { option, value: null },
      answeredBy: value.request.requestedBy,
    },
    answerCommand: { commandId: `answer:${value.handle.id}`, digest: 'a'.repeat(64), revision: 2, seq },
  }
}
