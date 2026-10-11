import type { LoopCheckpointCodec, LoopFactory, LoopPluginContext } from '@agnes/extension-api'
export const codec: LoopCheckpointCodec
export function createDecisionLoop(): LoopFactory
export const plugin: { inject: string[]; apply(ctx: LoopPluginContext): void }
