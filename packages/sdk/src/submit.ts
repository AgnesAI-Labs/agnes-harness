import { type Ack, jcs, validateAgainst, validateMethod } from '@agnes/protocol'
import { SessionCompactParams, SessionForkParams, SessionSteerParams } from '@agnes/protocol/gen/agnes-v1'
import type { Client } from './client.js'
import { JsonRpcError, ProtocolViolation } from './errors.js'
import { type PendingCommand, snapshotPending } from './journal.js'

export type SubmitKind = 'steer' | 'followUp' | 'compact'
export type CompactOutcome =
  | { state: 'completed'; endSeq: number }
  | { state: 'failed'; endSeq: number }
  | { state: 'unknown' }
type DurableSubmitKind = SubmitKind | 'fork'
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
      : params.kind === 'compact'
        ? !validateAgainst(SessionCompactParams, { ...params.payload, commandId: params.commandId }).ok
        : !['steer', 'followUp'].includes(params.kind) ||
          !validateAgainst(SessionSteerParams, { ...params.payload, commandId: params.commandId }).ok)
  )
    throw invalid()
  return copy
}
function result(ack: Ack, commandId: string): number {
  if (ack.seq !== undefined) return ack.seq
  if (ack.status === 'uncertain')
    throw new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId } })
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
  const sessionId = (ack.result as { sessionId?: unknown } | undefined)?.sessionId
  if (typeof sessionId === 'string') return sessionId
  if (ack.status === 'uncertain')
    throw new JsonRpcError({ code: -32603, message: 'UNCERTAIN', data: { code: 'UNCERTAIN', commandId } })
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
  await client.journal.markPending(sessionId, structuredClone(command))
  const ack = await client.call<Ack>(command.method, command.params)
  if (ack.seq === undefined && ack.status !== 'uncertain')
    throw new ProtocolViolation('submit acknowledgement has no sequence')
  await client.journal.clearPending(sessionId, command.commandId)
  if (ack.status !== 'uncertain') await acknowledge(client, clientId, sessionId, command.commandId)
  return { seq: result(ack, command.commandId), compact: compactOutcome(ack) }
}
export async function submitForkCommand(
  client: Client,
  sessionId: string,
  at: number,
  commandId?: string,
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
        payload: { sessionId, at, childKey },
      },
    },
    clientId,
    sessionId,
  )
  await client.journal.markPending(sessionId, structuredClone(command))
  const ack = await client.call<Ack>(command.method, command.params)
  const forked = forkResult(ack, command.commandId)
  await client.journal.clearPending(sessionId, command.commandId)
  await acknowledge(client, clientId, sessionId, command.commandId)
  return forked
}
export async function resendPending(client: Client, sessionId: string): Promise<void> {
  const clientId = await client.clientId()
  const commands = (await client.journal.pending(sessionId)).map((command) =>
    validated(command, clientId, sessionId),
  )
  for (const command of commands) {
    const ack = await client.call<Ack>(command.method, command.params)
    const params = command.params as { kind: DurableSubmitKind }
    if (params.kind === 'fork') forkResult(ack, command.commandId)
    else result(ack, command.commandId)
    await client.journal.clearPending(sessionId, command.commandId)
    if (ack.status !== 'uncertain') await acknowledge(client, clientId, sessionId, command.commandId)
  }
}
