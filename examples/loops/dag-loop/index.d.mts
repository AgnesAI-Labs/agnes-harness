import type { LoopCheckpointCodec, LoopFactory, LoopPluginContext, LoopToolCall } from '@agnes/extension-api'
export interface DagNode {
  id: string
  tool: string
  args: LoopToolCall['args']
  after: string[]
}
export interface DagConfig {
  plan?: DagNode[]
}
export const codec: LoopCheckpointCodec
export function createDagLoop(config?: DagConfig): LoopFactory
export const plugin: { inject: string[]; apply(ctx: LoopPluginContext, config?: DagConfig): void }
