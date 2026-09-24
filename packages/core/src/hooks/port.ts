import type { HookPayloadMap, HookReturnMap } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import type { HookSnapshot } from '../registry/hooks.js'
import type { PromptSection } from '../request/contribute.js'
import type { DeriveOutput } from '../request/derive.js'
import { applyBeforeRequestPatches, applyContextResults, type ContextResult } from '../request/transforms.js'
import type { HookPort } from '../step/session.js'
import { CoreError } from '../types.js'
import { type DispatchContext, HOOK_UNHANDLED, type HookEngine } from './engine.js'
import { discoverResources, type ResourceDiscovery, type ResourceDiscoveryInputs } from './resources.js'
import { contextReturnToWire } from './returns.js'

export type SessionHookInputs = {
  discovery?: ResourceDiscoveryInputs
  context(): DispatchContext
  budget(): HookPayloadMap['before_step']['budget']
  surface(): ReturnType<HookPayloadMap['context']['getSurface']>
  surfaceDigest(): HookPayloadMap['context']['surfaceDigest']
  verifierTier(): 0 | 1 | 2
  contextOverflow(data: { ext: string; bytes: number }): unknown
  /** A second `before_compact` plan showed up after the built-in layer's; it is dropped, not fatal
   *  (design third-party-transform-directive-hooks §3 item 5). Fired once per dropped plan. */
  compactPlanIgnored(data: { ext: string }): unknown
}

function json(value: unknown): JsonValue {
  const checked = inspectJsonData(value, Number.MAX_SAFE_INTEGER)
  if (!checked.ok) throw new CoreError('E_ENVELOPE', 'invalid hook input')
  return checked.value
}
function rejected(): never {
  throw new CoreError('E_ENVELOPE', 'hook rejected transformation')
}

/** One adapter per assembled session. Live state comes from that session, never a shared default. */
export class SessionHookPort implements HookPort {
  private discovered: ResourceDiscovery = { resources: [], contributions: [] }

  resources(): ResourceDiscovery['resources'] {
    return structuredClone(this.discovered.resources)
  }

  private turnSnapshot: HookSnapshot | undefined

  private snapshot(): HookSnapshot {
    this.turnSnapshot ??= this.engine.snapshot()
    return this.turnSnapshot
  }

  constructor(
    private readonly engine: HookEngine,
    private readonly inputs: SessionHookInputs,
  ) {}

  async sessionStart(p: { reason: 'new' | 'resume'; preset: string; cwd: string }): Promise<void> {
    await this.engine.dispatch('session_start', () => p, {
      ...this.inputs.context(),
      replayed: p.reason === 'resume',
    })
    if (this.inputs.discovery)
      this.discovered = await discoverResources(this.engine, this.inputs.discovery, {
        ...this.inputs.context(),
        replayed: p.reason === 'resume',
      })
  }

  async shutdown(): Promise<void> {
    // Session execution is already cancelled; cleanup receives its own bounded dispatch signal.
    try {
      await this.engine.dispatch('shutdown', () => ({ reason: 'close' }), {
        ...this.inputs.context(),
        signal: new AbortController().signal,
        replayed: false,
      })
    } finally {
      this.turnSnapshot = undefined
      this.discovered = { resources: [], contributions: [] }
    }
  }

  async shutdownExtension(source: string, reason: 'revoke' | 'reload'): Promise<void> {
    if (!source) throw new CoreError('E_ENVELOPE', 'invalid extension shutdown source')
    await this.engine.dispatch(
      'shutdown',
      () => ({ reason }),
      {
        ...this.inputs.context(),
        signal: new AbortController().signal,
        replayed: false,
      },
      { snapshot: this.engine.snapshot(source) },
    )
  }

  resetTurn(): void {
    this.turnSnapshot = this.engine.snapshot()
    this.engine.resetTurn()
  }

  async beforeStep(p: Parameters<HookPort['beforeStep']>[0]): ReturnType<HookPort['beforeStep']> {
    const result = await this.engine.dispatch(
      'before_step',
      () => ({ ...p, budget: this.inputs.budget() }),
      this.inputs.context(),
      {
        snapshot: this.snapshot(),
        terminal: (value) => value.block === true,
      },
    )
    if (result.kind === 'rejected') return { block: true, reason: result.reason }
    return result.results.find((entry) => entry.value.block)?.value ?? {}
  }

  async toolCall(p: Parameters<HookPort['toolCall']>[0]): ReturnType<HookPort['toolCall']> {
    let args: JsonValue
    try {
      args = json(p.args)
    } catch {
      return { allow: false, reason: 'invalid hook input' }
    }
    const result = await this.engine.dispatch('tool_call', () => ({ ...p, args }), this.inputs.context(), {
      snapshot: this.snapshot(),
      terminal: (value) => !value.allow,
    })
    if (result.kind === 'rejected') return { allow: false, reason: result.reason }
    return result.results.find((entry) => !entry.value.allow)?.value ?? { allow: true }
  }

  async turnStopping(p: Parameters<HookPort['turnStopping']>[0]): ReturnType<HookPort['turnStopping']> {
    const reason = p.proposedReason
    if (reason !== 'completed' && reason !== 'max_steps' && reason !== 'budget') rejected()
    const result = await this.engine.dispatch(
      'turn_stopping',
      () => ({
        turn: p.turn,
        step: p.step,
        proposedReason: reason,
        ...(p.verifier
          ? {
              verifier: {
                passed: p.verifier.verdict === 'pass',
                reasons: p.verifier.reasons,
                tier: this.inputs.verifierTier(),
              },
            }
          : {}),
      }),
      this.inputs.context(),
      { snapshot: this.snapshot(), terminal: (value) => value.action === 'continue' },
    )
    if (result.kind === 'rejected') return { action: 'stop' }
    return result.results.find((entry) => entry.value.action === 'continue')?.value ?? { action: 'stop' }
  }

  async context(base: PromptSection[]): Promise<PromptSection[]> {
    const results: Array<{ ext: string; result: ContextResult }> = structuredClone(
      this.discovered.contributions,
    )
    const initial = results.length ? applyContextResults(base, results) : { sections: base, overflow: [] }
    let sections = initial.sections
    let overflow = initial.overflow
    const outcome = await this.engine.dispatch(
      'context',
      () => ({
        sections: sections.map(({ text, ...section }) => ({ ...section, content: text })),
        surfaceDigest: this.inputs.surfaceDigest(),
        getSurface: () => this.inputs.surface(),
      }),
      this.inputs.context(),
      {
        snapshot: this.snapshot(),
        accept: (value, source) => {
          const entry = { ext: source, result: contextReturnToWire(value) }
          const next = [...results, entry]
          const applied = applyContextResults(base, next)
          results.push(entry)
          sections = applied.sections
          overflow = applied.overflow
        },
      },
    )
    if (outcome.kind === 'rejected') rejected()
    for (const item of overflow) {
      try {
        void Promise.resolve(this.inputs.contextOverflow(item)).catch(() => undefined)
      } catch {
        /* diagnostic isolation */
      }
    }
    return sections
  }

  async toolResult(p: HookPayloadMap['tool_result']): Promise<HookReturnMap['tool_result']> {
    let result = p.result
    // Each handler must see the *current* accumulated result, not the original one: otherwise a
    // handler placed after another (e.g. a third-party hook after hooks-runner's own tool-result
    // interception) would read stale data and its accepted return would silently wipe out an
    // earlier accepted rewrite instead of building on it.
    const outcome = await this.engine.dispatch(
      'tool_result',
      () => ({ ...p, result }),
      this.inputs.context(),
      {
        snapshot: this.snapshot(),
        accept: (value) => {
          if (value.result) result = value.result
        },
      },
    )
    if (outcome.kind === 'rejected') rejected()
    return { result }
  }

  async approvalRequest(p: HookPayloadMap['approval_request']): Promise<HookReturnMap['approval_request']> {
    let request: HookReturnMap['approval_request']['request']
    // Same reasoning as toolResult above: fold the accumulated override back into the payload's own
    // `request` so a later handler builds on earlier accepted changes instead of overwriting them.
    // `risk`/`context`/`summary` are the only fields a return may touch, and `ApprovalRequest`
    // already requires them, so the merged payload still satisfies its own schema.
    const outcome = await this.engine.dispatch(
      'approval_request',
      () => ({ ...p, request: { ...p.request, ...request } }),
      this.inputs.context(),
      {
        snapshot: this.snapshot(),
        accept: (value) => {
          if (value.request) request = { ...request, ...value.request }
        },
      },
    )
    if (outcome.kind === 'rejected') rejected()
    // `exactOptionalPropertyTypes` refuses `{ request: undefined }` as a stand-in for "absent": the
    // key itself must be missing when no waterfall member supplied an override.
    return request === undefined ? {} : { request }
  }

  async requestError(p: HookPayloadMap['request_error']): Promise<void> {
    await this.engine.dispatch('request_error', () => p, this.inputs.context(), { snapshot: this.snapshot() })
  }

  async formatDeviation(p: HookPayloadMap['format_deviation']): Promise<void> {
    await this.engine.dispatch('format_deviation', () => p, this.inputs.context(), {
      snapshot: this.snapshot(),
    })
  }

  async subagentStart(p: HookPayloadMap['subagent_start']): Promise<void> {
    await this.engine.dispatch('subagent_start', () => p, this.inputs.context(), {
      snapshot: this.snapshot(),
    })
  }

  async subagentEnd(p: HookPayloadMap['subagent_end']): Promise<void> {
    await this.engine.dispatch('subagent_end', () => p, this.inputs.context(), {
      snapshot: this.snapshot(),
    })
  }

  async beforeCompact(
    p: HookPayloadMap['before_compact'],
  ): ReturnType<NonNullable<HookPort['beforeCompact']>> {
    const snapshot = this.snapshot()
    if (snapshot.entries('before_compact').length === 0) return { kind: 'unhandled' }
    const outcome = await this.engine.dispatch('before_compact', () => p, this.inputs.context(), {
      snapshot,
    })
    if (outcome.kind === 'rejected') rejected()
    const participating = outcome.results.filter((entry) => entry.value !== (HOOK_UNHANDLED as unknown))
    if (participating.length === 0) return { kind: 'unhandled' }
    // Results are already in dispatch order (built-in layer first, per the registry's hookRank
    // sort): the first real plan wins, matching "whoever runs first decides"; every later plan is
    // dropped, not fatal, since a third party is now free to register on this event too.
    const plans = participating.flatMap((entry) => (entry.value === null ? [] : [entry]))
    for (const dropped of plans.slice(1)) {
      try {
        void Promise.resolve(this.inputs.compactPlanIgnored({ ext: dropped.source })).catch(() => undefined)
      } catch {
        /* diagnostic isolation */
      }
    }
    return { kind: 'handled', plan: plans[0]?.value ?? null }
  }

  async compact(p: HookPayloadMap['compact']): Promise<void> {
    await this.engine.dispatch('compact', () => p, this.inputs.context(), { snapshot: this.snapshot() })
  }

  async beforeRequest(base: DeriveOutput, slot: string, attempt: number): Promise<DeriveOutput> {
    let current = base
    const outcome = await this.engine.dispatch(
      'before_request',
      () => ({
        request: {
          model: current.request.model.model,
          slot,
          messageCount: current.request.messages.length,
          toolNames: current.request.tools.map((tool) => tool.name),
          samplingParams: json(current.request.samplingParams ?? {}) as Record<string, JsonValue>,
          ...(current.request.maxTokens === undefined ? {} : { maxTokens: current.request.maxTokens }),
        },
        slot,
        model: current.request.model.model,
        attempt,
      }),
      this.inputs.context(),
      {
        snapshot: this.snapshot(),
        accept: (value: HookReturnMap['before_request'], source) => {
          if (value.patch) current = applyBeforeRequestPatches(current, [{ ext: source, patch: value.patch }])
        },
      },
    )
    if (outcome.kind === 'rejected') rejected()
    return current
  }
}
