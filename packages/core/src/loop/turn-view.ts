import type { LoopTurnView } from '@agnes/extension-api'
import { restoreToolDisclosure } from '../execution/turn/tool-disclosure.js'
import { assembleRequestPrefix, discloseTools, resolveModel } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'

export function freezeView<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeView(item)
    Object.freeze(value)
  }
  return value
}

/** Detached read view: tool definitions have no executable methods or mutable aliases. */
export async function loopTurnView(s: SessionImpl): Promise<LoopTurnView | null> {
  const op = s.op()
  if (!op) return null
  if (!s.turn) await s.rehydrateTurn(op)
  await restoreToolDisclosure(s)
  const slot = 'primary'
  const target = resolveModel(s, slot)
  const record = s.d.provider
    .models()
    .find((model) => model.id === target.model && model.route === target.route)
  const ctx = {
    session: s,
    preset: s.preset,
    state: op,
    snapshot: s.turn!.snapshot,
    signal: s.ac.signal,
    disclosed: discloseTools(s),
    model: { slot, ...target },
  }
  const { merged } = await assembleRequestPrefix(s, ctx, op.meta.triggerSeq)
  return freezeView(
    structuredClone({
      turnId: op.meta.turn,
      step: op.step,
      cancelled: op.control.status === 'cancel_requested',
      history: s.surface().map((node) => ({
        seq: node.seq,
        kind: node.kind,
        trust: node.event.trust,
        data: node.event.data,
      })),
      tools: s.turn!.snapshot.defs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(tool.parameters)),
      })),
      model: {
        slot,
        id: target.model,
        capabilities: record
          ? {
              input: record.input,
              reasoning: record.reasoning,
              toolCallFormats: record.toolCallFormats,
              contextWindow: record.contextWindow,
              maxTokens: record.maxTokens,
            }
          : null,
      },
      prompt: { sections: merged.sections, runtime: merged.runtimeContext },
      budget: {
        maxSteps: s.preset.budget.maxSteps,
        stepsUsed: op.step,
        creditsUsed: s.state.creditsUsed,
        perRequestCap: s.turnBudgetCap(),
        onExceed: s.preset.budget.onExceed,
      },
    }),
  )
}
