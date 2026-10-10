/** Ordinary conversation and execution evidence projected from the Jev ledger. */

import type {
  DecisionInputPolicy,
  FrozenIntent,
  InputFact,
  JsonValue,
  LanguageInput,
  ModelSettlement,
  PreparedModelCall,
  RuntimeRecord,
  ToolDescriptor,
} from '@agnes/jev-runtime'
import { AcceptedAnswers } from '@agnes/jev-runtime'
import type { ToolCall } from '@agnes/protocol'
import { nativeAuthoredCall, nativeExplanation } from './language-provenance.js'

/** One model-visible input, completed action, or genuine final response. */
export type LanguageEntry =
  | { readonly kind: 'input'; readonly id: string; readonly input: InputFact; readonly toolDerived: boolean }
  | { readonly kind: 'system'; readonly id: string; readonly text: string }
  | { readonly kind: 'context'; readonly id: string; readonly replaceKey: string; readonly text: string }
  | { readonly kind: 'note'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'execution'
      readonly id: string
      readonly intent: FrozenIntent
      readonly outcome: Extract<RuntimeRecord, { kind: 'action.settled' }>['outcome']
      readonly effect: string
      readonly nativeCall?: ToolCall
      readonly nativeRequest?: string
      readonly nativeText?: string
    }
  | {
      readonly kind: 'model-result'
      readonly id: string
      readonly call: PreparedModelCall
      readonly settlement: ModelSettlement
    }

/** Stable declarations, ordered conversation, and one request-scoped instruction. */
export interface LanguageProjection {
  readonly tools: readonly ToolDescriptor[]
  readonly entries: readonly LanguageEntry[]
  readonly requestNote: string
}

function object(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, canonical(member)]),
  )
}

/**
 * Serialize recorded JSON without changing resource text or arguments.
 * @param value - JSON-compatible value.
 * @returns deterministic JSON text.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function selectedFields(value: { [key: string]: JsonValue }, names: readonly string[]): JsonValue {
  return Object.fromEntries(names.flatMap((name) => (value[name] === undefined ? [] : [[name, value[name]]])))
}

/**
 * Project accepted inputs and completed attempts; control records stay in the ledger.
 * Native tool content is the language evidence, independently of structured decision results.
 * Ordinary records append evidence; an empty system rendering clears projected system history.
 * @param input - current request and committed ledger prefix.
 * @returns full stable catalog, ordinary history, and necessary request constraints.
 */
export function projectLanguage(
  input: LanguageInput,
  inputPolicies: Readonly<Record<string, DecisionInputPolicy>> = {},
): LanguageProjection {
  const entries: LanguageEntry[] = []
  const answers = new AcceptedAnswers()
  const requests = new Map<string, PreparedModelCall>()
  const intents = new Map<string, FrozenIntent>()
  const intentRequests = new Map<string, string>()
  const proposalPositions = new Map<string, number>()
  const decisions = new Map<string, Extract<RuntimeRecord, { kind: 'decision.selected' }>>()
  const modelSettlements = new Map<string, ModelSettlement>()
  const nativeCalls = new Map<string, ToolCall>()
  const nativeRequests = new Map<string, string>()
  const admittedBatchCalls = new Map<string, Set<number>>()
  const settled = new Set<string>()
  const toolAdditions = new Set<string>()
  const resources = new Map<string, string>()
  const contexts = new Map<string, string>()
  let system: string | undefined
  let environment: string | undefined
  let catalog: readonly ToolDescriptor[] | undefined
  const unknownExecution = (id: string, intentId: string): void => {
    if (settled.has(intentId)) return
    const intent = intents.get(intentId)
    if (intent === undefined) throw new Error('Recorded execution has no committed intent')
    entries.push({
      kind: 'execution',
      id,
      intent,
      ...(nativeCalls.has(intentId)
        ? { nativeCall: nativeCalls.get(intentId)!, nativeRequest: nativeRequests.get(intentId)! }
        : {}),
      effect: 'unknown',
      outcome: {
        kind: 'error',
        content: [
          {
            kind: 'text',
            text: 'Execution outcome is unknown; do not infer success or repeat a possible effect.',
          },
        ],
        error: { code: 'UNKNOWN_EXECUTION', message: 'No execution result was recorded.' },
        directive: { conclude: false, additions: [] },
      },
    })
    settled.add(intentId)
    const requested = intentRequests.get(intentId)
    if (requested !== undefined) proposalPositions.set(requested, entries.length)
  }
  for (const record of input.records) {
    const answer = answers.apply(record)
    if (answer !== undefined)
      entries.push({
        kind: 'model-result',
        id: answer.settled.id,
        call: answer.request.call,
        settlement: answer.settled.settlement,
      })
    switch (record.kind) {
      case 'input.admitted': {
        const policy = Object.hasOwn(inputPolicies, record.input.source)
          ? inputPolicies[record.input.source]
          : undefined
        if (
          policy?.kind === 'context' &&
          policy.replaceKey !== undefined &&
          !toolAdditions.has(record.input.id)
        ) {
          const text = record.input.content
            .map((block) => {
              if (block.kind !== 'text') throw new Error('Host context snapshot must contain text content')
              return block.text
            })
            .join('\n')
          // Preserve prior facts at their ledger positions. Only the latest text for this key
          // governs deduplication; an empty snapshot is an explicit, replayable clear.
          if (text !== contexts.get(policy.replaceKey))
            entries.push({ kind: 'context', id: record.input.id, replaceKey: policy.replaceKey, text })
          contexts.set(policy.replaceKey, text)
          break
        }
        if (record.input.source === 'system-prompt' && !toolAdditions.has(record.input.id)) {
          const text = record.input.content
            .map((block) => {
              if (block.kind !== 'text') throw new Error('System prompt history must contain text content')
              return block.text
            })
            .join('\n')
          if (text !== system) {
            if (text.length === 0) {
              for (let index = entries.length - 1; index >= 0; index--) {
                if (entries[index]?.kind === 'system') {
                  entries.splice(index, 1)
                  for (const [requested, position] of proposalPositions)
                    if (position > index) proposalPositions.set(requested, position - 1)
                }
              }
            } else entries.push({ kind: 'system', id: record.input.id, text })
          }
          system = text
        } else
          entries.push({
            kind: 'input',
            id: record.id,
            input: record.input,
            toolDerived: toolAdditions.has(record.input.id),
          })
        break
      }
      case 'environment.observed': {
        const facts = object(record.facts)
        const visible =
          facts?.execution === 'agnes-native-tools' ? selectedFields(facts, ['cwd']) : record.facts
        const next = stableJson(visible)
        if (next !== environment)
          entries.push({ kind: 'note', id: record.id, text: `Execution environment: ${next}` })
        environment = next
        catalog = record.catalog
        break
      }
      case 'resource.observed': {
        const value = object(record.resource)
        if (value?.kind === 'jev.workspace-directory.v1') {
          const visible = selectedFields(value, [
            'root',
            'status',
            'entries',
            'complete',
            'omitted',
            'limit',
            'error',
          ])
          const text = stableJson(visible)
          if (resources.get('workspace-directory') !== text) {
            entries.push({ kind: 'note', id: record.id, text: `Workspace directory observation: ${text}` })
            resources.set('workspace-directory', text)
          }
        } else if (value?.kind === 'jev.runtime.feedback.v1' && value.languageVisible !== false) {
          entries.push({
            kind: 'note',
            id: record.id,
            text: `Request was not executed: ${stableJson(
              selectedFields(value, ['operation', 'code', 'message']),
            )}`,
          })
        }
        // Resource envelopes are decision inputs. Language facts enter through admitted inputs or explicit evidence above.
        break
      }
      case 'model.requested': {
        if (record.call.purpose === 'decision') break
        requests.set(record.id, record.call)
        // Request controls are not conversation: retain identities for provenance only.
        break
      }
      case 'model.settled': {
        modelSettlements.set(record.requested, record.settlement)
        const call = requests.get(record.requested)
        if (call === undefined) break
        if (record.settlement.error !== undefined) {
          const error = record.settlement.error
          entries.push({
            kind: 'note',
            id: `${record.id}:error`,
            text: `Language request failed: ${error.code}: ${error.message}`,
          })
        } else if (object(record.settlement.output)?.kind === 'cannot_bind') {
          const reason = object(record.settlement.output)?.reason
          if (typeof reason === 'string')
            entries.push({
              kind: 'note',
              id: `${record.id}:refusal`,
              text: `The requested arguments could not be supplied: ${reason}`,
            })
        }
        proposalPositions.set(record.requested, entries.length)
        break
      }
      case 'action.intended': {
        intents.set(record.intent.id, record.intent)
        const decision = decisions.get(record.decision)
        if (decision !== undefined) intentRequests.set(record.intent.id, decision.requested)
        if (decision?.callIndex !== undefined) {
          const indices = admittedBatchCalls.get(decision.requested) ?? new Set<number>()
          indices.add(decision.callIndex)
          admittedBatchCalls.set(decision.requested, indices)
        }
        const call = nativeAuthoredCall(
          decision,
          decision === undefined ? undefined : requests.get(decision.requested),
          decision === undefined ? undefined : modelSettlements.get(decision.requested),
          record.intent,
        )
        if (call !== undefined && decision !== undefined) {
          nativeCalls.set(record.intent.id, call)
          nativeRequests.set(record.intent.id, decision.requested)
        }
        break
      }
      case 'action.settled': {
        const intent = intents.get(record.intentId)
        if (intent === undefined) throw new Error('Recorded tool result has no committed intent')
        const nativeCall = nativeCalls.get(record.intentId)
        const requested = intentRequests.get(record.intentId)
        const settlement = requested === undefined ? undefined : modelSettlements.get(requested)
        const nativeText =
          nativeCall &&
          settlement &&
          record.outcome.kind === 'success' &&
          (record.effect === 'none' || record.effect === 'applied')
            ? nativeExplanation(settlement, nativeCall)
            : undefined
        entries.push({
          kind: 'execution',
          id: record.id,
          intent,
          outcome: record.outcome,
          effect: record.effect,
          ...(nativeText === undefined ? {} : { nativeText }),
          ...(nativeCalls.has(record.intentId)
            ? {
                nativeCall: nativeCalls.get(record.intentId)!,
                nativeRequest: nativeRequests.get(record.intentId)!,
              }
            : {}),
        })
        settled.add(record.intentId)
        if (requested !== undefined) proposalPositions.set(requested, entries.length)
        for (const addition of record.outcome.directive.additions) toolAdditions.add(addition.id)
        break
      }
      case 'action.resolved':
        unknownExecution(`${record.id}:execution`, record.intentId)
        entries.push({
          kind: 'note',
          id: record.id,
          text: `Execution resolution: ${stableJson({
            tool: intents.get(record.intentId)?.tool,
            resolution: record.resolution,
            ...(record.resolution === 'reconciled_state'
              ? {
                  meaning:
                    'Original execution remains unknown. Host verified the current file state; replan from that state without replaying the original proposal.',
                }
              : {}),
            explanation: record.explanation,
            evidence: record.evidence,
          })}`,
        })
        break
      case 'run.stopped':
        for (const intentId of record.unresolved) unknownExecution(`${record.id}:${intentId}`, intentId)
        if (record.reason !== 'completed')
          entries.push({
            kind: 'note',
            id: record.id,
            text: `Previous task stopped: ${record.reason}: ${record.detail}`,
          })
        break
      case 'run.opened':
      case 'action.dispatching':
      case 'decision.selected':
        if (record.kind === 'decision.selected') decisions.set(record.id, record)
        break
      default: {
        const exhaustive: never = record
        throw new Error(`Unsupported runtime record: ${String(exhaustive)}`)
      }
    }
  }
  const proposalNotes: { position: number; entry: LanguageEntry }[] = []
  for (const [requested, settlement] of modelSettlements) {
    const output = object(settlement.output)
    if (settlement.error || output?.kind !== 'calls' || !Array.isArray(output.calls)) continue
    const unexecuted = output.calls.flatMap((call, index) =>
      admittedBatchCalls.get(requested)?.has(index) ? [] : [{ index, name: object(call)?.name ?? null }],
    )
    if (unexecuted.length)
      proposalNotes.push({
        position: proposalPositions.get(requested) ?? entries.length,
        entry: {
          kind: 'note',
          id: `${requested}:unexecuted-proposals`,
          text: `These proposed calls were not admitted or executed: ${stableJson(unexecuted)}. They are not automatically resumed; choose any next action from the recorded results and current input.`,
        },
      })
  }
  // Feedback stays beside its execution, rather than moving past every new input on replay.
  for (const note of proposalNotes.sort((a, b) => a.position - b.position).reverse())
    entries.splice(note.position, 0, note.entry)
  const tools = [...(input.recovery ? (input.tools ?? []) : (catalog ?? input.tools ?? []))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const notes: string[] = []
  if (input.recovery)
    notes.push(
      `Inspect these uncertain actions using only the available read-only tools: ${stableJson(input.recovery.intentIds)}. Read the exact current target completely. Do not retry mutations or return a final answer. The Host alone verifies whether inspection permits continuation; your claims cannot resolve an effect.`,
    )
  if (input.purpose === 'parameters' && input.lockedOperation !== undefined) {
    notes.push(`Call ${JSON.stringify(input.lockedOperation)}. Do not call another tool.`)
  }
  return { tools, entries, requestNote: notes.join('\n') }
}
