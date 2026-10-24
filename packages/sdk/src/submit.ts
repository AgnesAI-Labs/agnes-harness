import {
  type Ack,
  type ContentBlock,
  jcs,
  type ReferenceSelection,
  validateAgainst,
  validateMethod,
} from '@agnes/protocol'
import {
  SessionCompactParams,
  SessionControlParams,
  SessionEditQueuedParams,
  SessionForkParams,
  SessionRemoveQueuedParams,
  SessionSendNowParams,
  SessionSteerParams,
} from '@agnes/protocol/gen/agnes-v1'
import type { Client } from './client.js'
import { JsonRpcError, ProtocolViolation, type UnresolvedSubmission } from './errors.js'
import { type PendingCommand, snapshotPending } from './journal.js'
import { toContentBlocks } from './prompt-budget.js'

export type SubmitKind =
  | 'steer'
  | 'followUp'
  | 'sendNow'
  | 'removeQueued'
  | 'compact'
  | 'control'
  | 'editQueued'
export type CompactOutcome =
  | { state: 'completed'; endSeq: number }
  | { state: 'failed'; endSeq: number }
  | { state: 'unknown' }
const invalid = () => new ProtocolViolation('invalid pending submit command')
function validated(command: PendingCommand, clientId: string, sessionId: string) {
  const copy = snapshotPending(command)
  if (copy.method !== '_agnes/v1/submit' || !validateMethod(copy.method, 'params', copy.params).ok)
    throw invalid()
  const params = copy.params as {
    clientId: string
    commandId: string
    kind: string
    payload: Record<string, unknown>
  }
  if (
    params.clientId !== clientId ||
    params.commandId !== copy.commandId ||
    params.payload?.sessionId !== sessionId ||
    (params.kind === 'fork'
      ? typeof params.payload.childKey !== 'string' || !validateAgainst(SessionForkParams, params.payload).ok
      : params.kind === 'control' || params.kind === 'editQueued'
        ? !validateAgainst(params.kind === 'control' ? SessionControlParams : SessionEditQueuedParams, {
            ...params.payload,
            commandId: params.commandId,
          }).ok
        : params.kind === 'compact'
          ? !validateAgainst(SessionCompactParams, { ...params.payload, commandId: params.commandId }).ok
          : params.kind === 'sendNow' || params.kind === 'removeQueued'
            ? !validateAgainst(params.kind === 'sendNow' ? SessionSendNowParams : SessionRemoveQueuedParams, {
                ...params.payload,
                commandId: params.commandId,
              }).ok
            : !['steer', 'followUp'].includes(params.kind) ||
              !validateAgainst(SessionSteerParams, { ...params.payload, commandId: params.commandId }).ok)
  )
    throw invalid()
  return copy
}
function result(ack: Ack, commandId: string): number {
  if (ack.status === 'uncertain')
    throw new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId } })
  if (ack.seq !== undefined) return ack.seq
  throw new ProtocolViolation('submit acknowledgement has no sequence')
}
function compactOutcome(ack: Ack): CompactOutcome {
  const value = (ack as Ack & { compact?: unknown }).compact
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown' }
  const compact = value as Record<string, unknown>
  if (
    (compact.state === 'completed' || compact.state === 'failed') &&
    Number.isSafeInteger(compact.endSeq) &&
    (compact.endSeq as number) >= 1
  )
    return { state: compact.state, endSeq: compact.endSeq as number }
  return compact.state === 'unknown' ? { state: 'unknown' } : { state: 'unknown' }
}
function forkResult(ack: Ack, commandId: string): string {
  if (ack.status === 'uncertain')
    throw new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId } })
  const sessionId = (ack.result as { sessionId?: unknown } | undefined)?.sessionId
  if (typeof sessionId === 'string') return sessionId
  throw new ProtocolViolation('fork acknowledgement has no session id')
}
async function acknowledge(
  client: Client,
  clientId: string,
  sessionId: string,
  commandId: string,
): Promise<void> {
  try {
    await client.call('_agnes/v1/submit.ack', { clientId, sessionId, commandId })
  } catch {
    // Receipt retention is fail-safe: a lost acknowledgement keeps the server row longer. The
    // command already completed, so cleanup failure must not turn success into a retryable error.
  }
}
export async function submitCommand(
  client: Client,
  sessionId: string,
  kind: SubmitKind,
  payload: unknown,
  commandId?: string,
): Promise<number> {
  return (await submitCompactAware(client, sessionId, kind, payload, commandId)).seq
}
export async function submitCompactAware(
  client: Client,
  sessionId: string,
  kind: SubmitKind,
  payload: unknown,
  commandId?: string,
): Promise<{ seq: number; compact: CompactOutcome }> {
  // Own the payload before clientId/counter I/O can yield to its caller.
  let owned: unknown
  try {
    owned = JSON.parse(jcs(payload))
  } catch {
    throw invalid()
  }
  const clientId = await client.clientId()
  const id = commandId ?? (await client.journal.nextCommandId(sessionId))
  const command = validated(
    { commandId: id, method: '_agnes/v1/submit', params: { clientId, commandId: id, kind, payload: owned } },
    clientId,
    sessionId,
  )
  const existing = (await client.journal.pending(sessionId)).find((entry) => entry.commandId === id)
  if (existing?.state === 'needs-confirmation')
    throw Object.assign(
      new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId: id } }),
      {
        submission: { sessionId, commandId: id, state: 'needs-confirmation' },
      },
    )
  await client.journal.markPending(sessionId, structuredClone(command))
  const ack = await dispatch(client, clientId, sessionId, command)
  return { seq: result(ack, command.commandId), compact: compactOutcome(ack) }
}
export async function submitForkCommand(
  client: Client,
  sessionId: string,
  at: number,
  commandId?: string,
  additionalDirectories: readonly string[] = [],
): Promise<string> {
  const clientId = await client.clientId()
  const id = commandId ?? (await client.journal.nextCommandId(sessionId))
  const childKey = `agnes:fork:${encodeURIComponent(clientId)}:${encodeURIComponent(id)}`
  const command = validated(
    {
      commandId: id,
      method: '_agnes/v1/submit',
      params: {
        clientId,
        commandId: id,
        kind: 'fork',
        payload: {
          sessionId,
          at,
          childKey,
          ...(additionalDirectories.length ? { additionalDirectories: [...additionalDirectories] } : {}),
        },
      },
    },
    clientId,
    sessionId,
  )
  const existing = (await client.journal.pending(sessionId)).find((entry) => entry.commandId === id)
  if (existing?.state === 'needs-confirmation')
    throw Object.assign(
      new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId: id } }),
      {
        submission: { sessionId, commandId: id, state: 'needs-confirmation' },
      },
    )
  await client.journal.markPending(sessionId, structuredClone(command))
  const ack = await dispatch(client, clientId, sessionId, command)
  const forked = forkResult(ack, command.commandId)
  return forked
}
const definitive = (error: unknown) =>
  error instanceof JsonRpcError &&
  ['QUEUED_INPUT_GONE', 'LOOP_CONTROL_UNSUPPORTED', 'CONTROL_NOT_RUNNING'].includes(String(error.data.code))

async function dispatch(
  client: Client,
  clientId: string,
  sessionId: string,
  command: PendingCommand,
  replay = false,
): Promise<Ack> {
  try {
    const ack = await client.call<Ack>(command.method, command.params)
    if ((command.params as { kind: string }).kind === 'fork') forkResult(ack, command.commandId)
    else result(ack, command.commandId)
    await client.journal.clearPending(sessionId, command.commandId)
    await acknowledge(client, clientId, sessionId, command.commandId)
    return ack
  } catch (error) {
    if (definitive(error)) {
      await client.journal.clearPending(sessionId, command.commandId)
      throw error
    }
    const state =
      replay || (error instanceof JsonRpcError && ['UNCERTAIN', 'OUTCOME_UNKNOWN'].includes(error.data.code))
        ? 'needs-confirmation'
        : 'pending'
    if (state === 'needs-confirmation') {
      await client.journal.markPending(sessionId, { ...command, state })
      client.notice({ kind: 'command-needs-confirmation', sessionId, commandId: command.commandId })
    }
    const submission: UnresolvedSubmission = { sessionId, commandId: command.commandId, state }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { submission })
  }
}

/** One reconnect replay attempt is the retry policy; another failure requires explicit checking. */
export async function resendPending(client: Client, sessionId: string, commandId?: string): Promise<void> {
  const clientId = await client.clientId()
  const commands = (await client.journal.pending(sessionId))
    .filter((command) =>
      commandId ? command.commandId === commandId : command.state !== 'needs-confirmation',
    )
    .map((command) => validated(command, clientId, sessionId))
  for (const command of commands) {
    try {
      await dispatch(client, clientId, sessionId, command, true)
    } catch (error) {
      if (commandId || (!definitive(error) && !(error instanceof Error && 'submission' in error))) throw error
      // Persisted uncertainty and definitive refusals cannot block this or another session's attach.
    }
  }
}

export function submitInput(
  client: Client,
  sessionId: string,
  kind: 'steer' | 'followUp',
  input: ContentBlock[] | string,
  opts: { commandId?: string; references?: readonly ReferenceSelection[] },
): Promise<number> {
  return submitCommand(
    client,
    sessionId,
    kind,
    {
      sessionId,
      content: toContentBlocks(input),
      ...(opts.references?.length ? { references: opts.references } : {}),
    },
    opts.commandId,
  )
}
