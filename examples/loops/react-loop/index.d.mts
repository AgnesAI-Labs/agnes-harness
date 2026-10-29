import type { LoopCheckpointCodec, LoopFactory, LoopPluginContext } from '@agnes/extension-api'
export interface ReactConfig {
  waitForWake?: boolean
  compactAfterTools?: boolean
  childTask?: string
  childMessage?: string
}
export const codec: LoopCheckpointCodec
export function createReactLoop(config?: ReactConfig): LoopFactory
export const plugin: { inject: string[]; apply(ctx: LoopPluginContext, config?: ReactConfig): void }
