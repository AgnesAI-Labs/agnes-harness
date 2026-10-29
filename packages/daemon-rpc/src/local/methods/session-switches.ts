import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { JournalResult } from '@agnes/daemon-foundation/local/ports'
import { ToolFilterError, toolFilterRejection } from '@agnes/host'
import { rpcError, type ThinkingLevel, validateAgainst } from '@agnes/protocol'
import { SessionToolFilterRequest } from '@agnes/protocol/gen/agnes-v1'
import { runQueued } from '../command-queue.js'
import type { AgnesContext } from './agnes.js'
import { mapCore } from './agnes.js'

type Submit = (
  clientId: string,
  commandId: string,
  kind: string,
  payload: Record<string, unknown>,
  c: CallContext,
) => Promise<{ status?: string; result?: unknown }>

const neverAbort = (): AbortSignal => new AbortController().signal

/**
 * Runs inside `submit`'s per-session queue, which is where exactly-once for a commandId is decided.
 * Narrowing is idempotent (a union and an intersection of the same lists change nothing), so an
 * attempt whose outcome is unknown can simply run again.
 */
export async function dispatchToolFilter(
  cx: Pick<AgnesContext, 'registry'>,
  payload: Record<string, unknown>,
): Promise<JournalResult> {
  const { sessionId, allow, deny } = payload
  const request = { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) }
  try {
    const { seq, filter } = await cx.registry.require(String(sessionId)).session.setToolFilter(request)
    return { seq, result: { effectiveFromSeq: seq, filter } }
  } catch (error) {
    if (error instanceof ToolFilterError) {
      const { name, data } = toolFilterRejection(error)
      throw rpcError(name, data)
    }
    return mapCore(error)
  }
}

/**
 * `session/new` `_meta.<harness>.toolFilter`: shape-checked before anything is opened, so a malformed
 * request never leaves a half-made session behind. At least one list must be present.
 */
export function parseOpenToolFilter(value: unknown): { allow?: string[]; deny?: string[] } | undefined {
  if (value === undefined) return undefined
  const request = value as { allow?: string[]; deny?: string[] }
  if (!validateAgainst(SessionToolFilterRequest, value).ok || (!request.allow && !request.deny))
    throw rpcError('SEMANTIC_REJECTED', { code: 'TOOL_FILTER_REJECTED', reason: 'invalid-request' })
  return request
}

/**
 * Writes the new session's first filter row before the session is activated for its owner, so no
 * prompt can reach it unfiltered. A refusal propagates and the open fails; nothing is ignored.
 */
export function applyOpenToolFilter(
  cx: Pick<AgnesContext, 'registry' | 'commandQueue'>,
  sessionId: string,
  request: { allow?: string[]; deny?: string[] },
): Promise<JournalResult> {
  return runQueued(cx.commandQueue, sessionId, neverAbort(), () =>
    dispatchToolFilter(cx, { sessionId, ...request }),
  )
}

/** The three owner-only switches that change what a running session may do: preset, model, tool filter. */
export function registerSessionSwitches(
  ep: LocalEndpoint,
  cx: AgnesContext,
  requireOwner: (method: string, sessionId: string, c: CallContext) => void,
  submit: Submit,
): void {
  ep.register('_agnes/v1/session.setPreset', async (params, c) => {
    const p = params as { sessionId: string; preset: string }
    requireOwner('session.setPreset', p.sessionId, c)
    const entry = cx.registry.require(p.sessionId)
    try {
      const resolved = cx.host.validatePresetSwitch(p.preset, p.sessionId)
      return {
        effectiveFromSeq: await runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
          entry.session.setPreset(resolved.view),
        ),
      }
    } catch (e) {
      return mapCore(e)
    }
  })
  ep.register('_agnes/v1/session.setModel', async (params, c) => {
    const p = params as {
      sessionId: string
      slot: string
      route: string
      model: string
      thinking?: ThinkingLevel | null
      contextWindow?: number | null
    }
    const sel = {
      slot: p.slot,
      route: p.route,
      model: p.model,
      ...(p.thinking === undefined ? {} : { thinking: p.thinking }),
      ...(p.contextWindow === undefined ? {} : { contextWindow: p.contextWindow }),
    }
    requireOwner('session.setModel', p.sessionId, c)
    try {
      cx.host.validateModelSwitch(sel, p.sessionId)
      return {
        effectiveFromSeq: await runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
          cx.registry.require(p.sessionId).session.setModel(sel),
        ),
      }
    } catch (e) {
      return mapCore(e)
    }
  })
  ep.register('_agnes/v1/session.setToolFilter', async (params, c) => {
    const { commandId, ...payload } = params as {
      sessionId: string
      commandId: string
      allow?: string[]
      deny?: string[]
    }
    requireOwner('session.setToolFilter', payload.sessionId, c)
    const ack = await submit(c.conn.clientId, commandId, 'setToolFilter', payload, c)
    if (ack.status === 'uncertain') throw rpcError('INTERNAL_ERROR', { code: 'UNCERTAIN' })
    return ack.result
  })
}
