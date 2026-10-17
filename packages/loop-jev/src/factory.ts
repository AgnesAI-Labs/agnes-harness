import {
  type GenericLoopPorts,
  type LoopFactory,
  loopKind,
  type ProviderPluginContext,
} from '@agnes/extension-api'
import { resolveConfig } from './config.js'
import { createDriver } from './driver.js'
import { codec, parseJevState } from './state.js'

export const JEV_LOOP = Object.freeze({ id: 'agnes.jev', version: '0.1.0' } as const)

export function createJevLoopFactory(config?: unknown): LoopFactory {
  const cfg = resolveConfig(config)
  return Object.freeze({
    ...JEV_LOOP,
    checkpointMode: 'driver',
    controls: Object.freeze({ steer: true }),
    capabilities: Object.freeze(['model', 'tools', 'compaction', 'park', 'recovery']),
    codec,
    create: (ctx: GenericLoopPorts) => createDriver(ctx, cfg),
    resume: (ctx: GenericLoopPorts, checkpoint) =>
      createDriver(ctx, cfg, parseJevState(codec.decode(checkpoint))),
  } satisfies LoopFactory)
}

export const jevLoopPlugin = {
  inject: ['providers'] as const,
  apply(ctx: ProviderPluginContext, config?: unknown): void {
    ctx.providers.register(loopKind, createJevLoopFactory(config))
  },
}
