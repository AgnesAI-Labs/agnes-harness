import type { GenericLoopFactory, LoopCheckpointCodec, LoopPluginContext } from '@agnes/extension-api'
export const codec: LoopCheckpointCodec
export function parsePlan(
  reply: string,
  tools: readonly string[],
): { tool: string; args: unknown; awaitChild?: true }[]
/** Typed against the generic ports only. */
export function createPlanExecuteLoop(): GenericLoopFactory
export const plugin: { inject: string[]; apply(ctx: LoopPluginContext): void }
