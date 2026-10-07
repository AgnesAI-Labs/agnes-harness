import type { LoopFactory, LoopRegistryPort } from './loop.js'

/** Structural Cordis context: authors need no Core-private context or service subclass. */
export interface LoopPluginContext {
  loops: LoopRegistryPort
  effect(callback: () => () => void): unknown
}
export function registerLoopPlugin(
  ctx: LoopPluginContext,
  sourcePackage: string,
  factory: LoopFactory,
): void {
  ctx.effect(() => ctx.loops.register(sourcePackage, factory))
}
