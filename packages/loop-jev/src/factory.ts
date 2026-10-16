import {
  type GenericLoopPorts,
  type LoopFactory,
  loopKind,
  type ProviderPluginContext,
} from '@agnes/extension-api'
import { createSkeletonDriver, skeletonCodec } from './driver.js'

export const JEV_LOOP = Object.freeze({ id: 'agnes.jev', version: '0.1.0' } as const)

export function createJevLoopFactory(_config?: unknown): LoopFactory {
  return Object.freeze({
    ...JEV_LOOP,
    checkpointMode: 'driver',
    controls: Object.freeze({ steer: true }),
    capabilities: Object.freeze(['model', 'tools', 'compaction', 'park', 'recovery']),
    codec: skeletonCodec,
    create: (ctx: GenericLoopPorts) => createSkeletonDriver(ctx),
    resume: (ctx: GenericLoopPorts, checkpoint) =>
      createSkeletonDriver(ctx, skeletonCodec.decode(checkpoint)),
  } satisfies LoopFactory)
}

export const jevLoopPlugin = {
  inject: ['providers'] as const,
  apply(ctx: ProviderPluginContext, config?: unknown): void {
    ctx.providers.register(loopKind, createJevLoopFactory(config))
  },
}
