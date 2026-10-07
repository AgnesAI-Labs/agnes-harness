import type {
  HookPayloadMap,
  HookReturnMap,
  LoopEventContext,
  LoopEventHandler,
  LoopEventName,
  LoopEventPayloadMap,
  LoopEventRegistryPort,
  LoopEventReturnMap,
} from '@agnes/extension-api'
import { LOOP_EVENTS } from '@agnes/extension-api'
import { isToolResult } from '../effects/tool-dispatch.js'
import { withTimeout } from '../effects/wrap.js'
import { authorHookReturn } from '../hooks/returns.js'
import type { DeriveOutput } from '../request/derive.js'
import { applyBeforeRequestPatches } from '../request/transforms.js'
import type { SessionImpl } from '../step/session.js'

export class LoopEventRegistry implements LoopEventRegistryPort {
  private readonly handlers = new Map<LoopEventName, Set<unknown>>()
  on<E extends LoopEventName>(event: E, handler: LoopEventHandler<E>): () => void {
    if (!LOOP_EVENTS.includes(event) || typeof handler !== 'function')
      throw new Error('Invalid loop event listener')
    let entries = this.handlers.get(event)
    if (!entries) {
      entries = new Set()
      this.handlers.set(event, entries)
    }
    entries.add(handler)
    return () => {
      entries.delete(handler)
    }
  }
  async dispatch<E extends LoopEventName>(
    event: E,
    payload: LoopEventPayloadMap[E],
    context: LoopEventContext,
  ): Promise<LoopEventReturnMap[E]> {
    let value: unknown =
      event === 'before_tool_call'
        ? { allow: true }
        : event === 'before_model_request' || event === 'after_tool_result'
          ? {}
          : undefined
    let current = structuredClone(payload)
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      if (context.signal.aborted) {
        if (event === 'before_tool_call' || event === 'before_model_request') context.signal.throwIfAborted()
        break
      }
      let next: LoopEventReturnMap[E]
      try {
        next = await withTimeout(
          Promise.resolve().then(() => (handler as LoopEventHandler<E>)(structuredClone(current), context)),
          2000,
          'loop event',
          context.signal,
        )
        context.signal.throwIfAborted()
      } catch (error) {
        if (event === 'before_tool_call' || event === 'before_model_request') throw error
        continue
      }
      if (event === 'before_tool_call') {
        const decision = authorHookReturn('tool_call', next)
        value = decision
        if (!decision.allow) break
      } else if (event === 'before_model_request') {
        const patch = authorHookReturn('before_request', next).patch
        if (patch) {
          const previous = (value as HookReturnMap['before_request']).patch
          value = {
            patch: {
              ...previous,
              ...patch,
              ...(previous?.samplingParams || patch.samplingParams
                ? { samplingParams: { ...previous?.samplingParams, ...patch.samplingParams } }
                : {}),
              ...(previous?.metadata || patch.metadata
                ? { metadata: { ...previous?.metadata, ...patch.metadata } }
                : {}),
            },
          }
          const p = current as HookPayloadMap['before_request']
          current = {
            ...p,
            request: {
              ...p.request,
              samplingParams: { ...p.request.samplingParams, ...patch.samplingParams },
              ...(patch.maxTokens === undefined ? {} : { maxTokens: patch.maxTokens }),
            },
          } as LoopEventPayloadMap[E]
        }
      } else if (event === 'after_tool_result') {
        const result = (next as HookReturnMap['tool_result'])?.result
        if (result && isToolResult(result)) {
          value = { result: structuredClone(result) }
          current = { ...current, result: structuredClone(result) }
        }
      }
    }
    return value as LoopEventReturnMap[E]
  }
}

export const loopEventContext = (s: SessionImpl, signal: AbortSignal): LoopEventContext => ({
  session: { key: s.key, lane: s.lane, workspaceRoot: s.d.cwd },
  signal,
})
export const modelRequestPayload = (
  request: import('@agnes/protocol').RequestBody,
  attempt = 1,
): HookPayloadMap['before_request'] => ({
  request: {
    model: request.model,
    slot: request.slot,
    messageCount: request.messages.length,
    toolNames: request.tools.map((tool) => tool.name),
    samplingParams: request.sampling ?? {},
    ...(request.sampling?.maxTokens === undefined ? {} : { maxTokens: request.sampling.maxTokens }),
  },
  slot: request.slot,
  model: request.model,
  attempt,
})

/** Preserve request derivation/media authority by applying the same restricted patch helper. */
export async function beforeLoopModelRequest(
  s: SessionImpl,
  base: DeriveOutput,
  slot: string,
  attempt: number,
): Promise<DeriveOutput> {
  const hooked = await s.hooks.beforeRequest(base, slot, attempt)
  const request = hooked.request
  const payload: HookPayloadMap['before_request'] = {
    request: {
      model: request.model.model,
      slot,
      messageCount: request.messages.length,
      toolNames: request.tools.map((tool) => tool.name),
      samplingParams: JSON.parse(JSON.stringify(request.samplingParams ?? {})),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    },
    slot,
    model: request.model.model,
    attempt,
  }
  const returned = await s.loopEvents.dispatch(
    'before_model_request',
    payload,
    loopEventContext(s, s.ac.signal),
  )
  return returned.patch
    ? applyBeforeRequestPatches(hooked, [{ ext: 'loop-events', patch: returned.patch }])
    : hooked
}

/** Aliases reuse existing hook decisions; a denial is terminal and cannot be reversed. */
export async function dispatchLoopEvent<E extends LoopEventName>(
  s: SessionImpl,
  event: E,
  payload: LoopEventPayloadMap[E],
  signal: AbortSignal,
): Promise<LoopEventReturnMap[E]> {
  if (event === 'before_tool_call') {
    const result = await s.hooks.toolCall(payload as LoopEventPayloadMap['before_tool_call'])
    if (!result.allow) return result as LoopEventReturnMap[E]
  }
  if (event === 'after_tool_result') {
    const p = payload as HookPayloadMap['tool_result']
    const hooked = await s.hooks.toolResult?.(p)
    const result = await s.loopEvents.dispatch(
      'after_tool_result',
      hooked?.result ? { ...p, result: hooked.result } : p,
      loopEventContext(s, signal),
    )
    return (result.result ? result : (hooked ?? {})) as LoopEventReturnMap[E]
  }
  if (event === 'before_model_request') {
    const p = payload as HookPayloadMap['before_request']
    const hooked = await s.hooks.requestPatch?.(p)
    const patch = hooked?.patch
    const updated = patch
      ? {
          ...p,
          request: {
            ...p.request,
            samplingParams: { ...p.request.samplingParams, ...patch.samplingParams },
            ...(patch.maxTokens === undefined ? {} : { maxTokens: patch.maxTokens }),
          },
        }
      : p
    const result = await s.loopEvents.dispatch('before_model_request', updated, loopEventContext(s, signal))
    if (!hooked?.patch && !result.patch) return {} as LoopEventReturnMap[E]
    return {
      patch: {
        ...hooked?.patch,
        ...result.patch,
        samplingParams: { ...hooked?.patch?.samplingParams, ...result.patch?.samplingParams },
        metadata: { ...hooked?.patch?.metadata, ...result.patch?.metadata },
      },
    } as LoopEventReturnMap[E]
  }
  return s.loopEvents.dispatch(event, payload, loopEventContext(s, signal))
}
