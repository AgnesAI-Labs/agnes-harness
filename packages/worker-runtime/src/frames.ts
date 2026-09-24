import type {
  EventEnvelope,
  McpStatus,
  RpcError,
  RuntimeStaleFrame,
  SkillDescriptor,
  WorkerGeneration,
} from '@agnes/protocol'
import { workerGeneration } from '@agnes/protocol'

export type SessionMethod =
  | 'enqueue'
  | 'run'
  | 'abort'
  | 'scan'
  | 'latest'
  | 'projectUI'
  | 'projectUIPatch'
  | 'projectUIOpening'
  | 'projectUIHistory'
  | 'append'
  | 'setPreset'
  | 'setModel'
  | 'setYolo'
  | 'manualCompact'
  | 'decideApproval'
  | 'resolveActor'
  | 'fork'
  | 'resume'
  | 'ping'
  | 'previewSnapshot'

/** Process-wide methods available before C2 runtime-target delivery exists. */
export type WorkerMethod =
  | 'ping'
  | 'configuration.apply'
  | 'inspectService'
  | 'callService'
  | 'abortService'
  | 'computerUse.status'
  | 'computerUse.doctor'
  | 'computerUse.permissionsStatus'
  | 'computerUse.permissionsGrant'
  | 'computerUse.operationStart'
  | 'computerUse.operationStatus'
  | 'computerUse.operationCancel'
  | 'resourceSkillScan'
  | 'resourceSkillRemove'
  | 'resourceMcpTest'
  | 'resourceMcpTools'
  | 'resourceMcpApply'
  | 'resourceMcpReconnect'
  | 'resource.stale'

export type WorkerHello = {
  kind: 'hello'
  token: string
  workerKey: string
  workerGeneration: WorkerGeneration
  profileHash: string
  workerKind: 'session' | 'service'
  resources?: { snapshotRevision: string; skills: readonly SkillDescriptor[]; mcp: readonly McpStatus[] }
}

export function parseWorkerHello(value: unknown): WorkerHello {
  if (!value || typeof value !== 'object') throw new Error('invalid worker hello')
  const hello = value as Partial<WorkerHello>
  if (
    hello.kind !== 'hello' ||
    typeof hello.token !== 'string' ||
    hello.token.length === 0 ||
    typeof hello.workerKey !== 'string' ||
    hello.workerKey.length === 0 ||
    typeof hello.profileHash !== 'string' ||
    (hello.workerKind !== 'session' && hello.workerKind !== 'service')
  )
    throw new Error('invalid worker hello')
  if (hello.workerKind === 'session' && hello.workerKey !== '@shared')
    throw new Error('invalid shared worker key')
  return { ...hello, workerGeneration: workerGeneration(hello.workerGeneration) } as WorkerHello
}

export type SessionOpenResult = {
  sessionKey: string
  writerRunId: string
  generation: number
  lastSeq: number
}

/** Authenticated daemon-to-worker workspace authority. This type is never part of public RPC. */
export type WorkspaceBindingFrame = Readonly<{
  version: 1
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
}>

export function parseWorkspaceBinding(value: unknown, sessionKey: string): WorkspaceBindingFrame {
  if (!value || typeof value !== 'object') throw new Error('invalid workspace binding')
  const binding = value as Partial<WorkspaceBindingFrame>
  if (
    binding.version !== 1 ||
    binding.sessionKey !== sessionKey ||
    typeof binding.workspaceId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.workspaceId) ||
    !Number.isSafeInteger(binding.revision) ||
    (binding.revision as number) < 1 ||
    typeof binding.canonicalRoot !== 'string' ||
    binding.canonicalRoot.length === 0
  )
    throw new Error('invalid workspace binding')
  return binding as WorkspaceBindingFrame
}

export type EventFrame = { kind: 'event'; sessionKey: string; seq: number; event: EventEnvelope }
/** Streamed model text for one inference. It is never a ledger row, so it carries no seq. */
export type PreviewFrame = {
  kind: 'preview'
  sessionKey: string
  lane: string
  effectId: string
  stream: 'text' | 'thinking'
  offset: number
  delta: string
}
export type SessionInterruptedFrame = {
  kind: 'session.interrupted'
  sessionKey: string
  reason: string
}
export type LogFrame = {
  kind: 'log'
  sessionKey: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}
export type ResourceStatusFrame = { kind: 'resourceStatus'; serverId: string; status: McpStatus }
export type WorkerReplyFrame = {
  kind: 'reply'
  requestId: string
  result?: unknown
  error?: RpcError | { code: string; message: string; reason?: string }
}
export type SessionReplyFrame = WorkerReplyFrame & { sessionKey: string }
export type RequestFrame = {
  kind: 'request'
  sessionKey: string
  requestId: string
  method:
    | 'permission'
    | 'notice'
    | 'artifact-media-read'
    | 'skill-install'
    | 'skill-install-abort'
    | 'plugin-manage'
    | 'plugin-manage-abort'
    | 'mcp-manage'
    | 'mcp-manage-abort'
  params: unknown
}
export type WorkerCommandFrame = {
  kind: 'command'
  requestId: string
  method: WorkerMethod
  params: Record<string, unknown>
}
export type SessionOpenFrame = {
  kind: 'session.open'
  requestId: string
  sessionKey: string
  params: {
    binding: WorkspaceBindingFrame
    preset?: string
    resume?: boolean
    parent?: { key: string; boundarySeq: number }
  }
}
export type SessionCommandFrame = {
  kind: 'command'
  requestId: string
  sessionKey: string
  method: SessionMethod
  params: Record<string, unknown>
}
export type SessionTailFrame = {
  kind: 'session.tail'
  requestId: string
  sessionKey: string
  fromSeq: number
}
export type SessionCloseFrame = {
  kind: 'session.close'
  requestId: string
  sessionKey: string
  reason: string
}
/** Compatibility name for callers that accept either strict command-frame variant. */
export type CommandFrame = WorkerCommandFrame | SessionCommandFrame
/** @deprecated Prefer WorkerReplyFrame or SessionReplyFrame at the wire boundary. */
export type ReplyFrame = WorkerReplyFrame | SessionReplyFrame
export type CloseFrame = { kind: 'close'; reason: string }
export type WorkerToSupervisor =
  | WorkerHello
  | EventFrame
  | PreviewFrame
  | SessionInterruptedFrame
  | LogFrame
  | ResourceStatusFrame
  | WorkerReplyFrame
  | SessionReplyFrame
  | RequestFrame
export type SupervisorToWorker =
  | RuntimeStaleFrame
  | WorkerCommandFrame
  | SessionOpenFrame
  | SessionTailFrame
  | SessionCloseFrame
  | SessionCommandFrame
  | CloseFrame
  | WorkerReplyFrame
  | SessionReplyFrame
